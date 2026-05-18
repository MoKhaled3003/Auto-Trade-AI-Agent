import 'dotenv/config';
import chalk from 'chalk';
import { ChartScraper } from './scraper';
import {
  detectSwings, analyseStructure,
  detectOrderBlocks, detectFVGs,
  detectLiquiditySweeps, scoreConfluence,
  hasMomentumWithVolume,
} from './smc-engine';
import { buildSetup }      from './risk-manager';
import { logInfo, logWarn, logError, logSetupSilent } from './logger';
import { fetchHistory }    from './market-data';
import { getHTFBias }      from './bias';
import { TradeTracker }    from './trade-tracker';
import { PortfolioManager } from './portfolio';
import { AlpacaBroker }    from './alpaca-broker';
import { getSessionState } from './session-rules';
import { Candle, RawChartData } from './types';

// ── Config ────────────────────────────────────────────────────────────────
const CDP_URL      = process.env.CDP_URL          ?? 'http://localhost:9222';
const TICKERS      = (process.env.TICKERS         ?? 'NVDA,MU,INTC').split(',');
const POLL_MS      = parseInt(process.env.POLL_INTERVAL_MS  ?? '3000', 10);
const BUFFER_SIZE  = parseInt(process.env.CANDLE_BUFFER_SIZE ?? '300', 10);
const TIMEFRAME    = process.env.TIMEFRAME        ?? '15m';
const MIN_CONF     = parseInt(process.env.MIN_CONFIDENCE    ?? '70',  10);
const MAX_PER_DAY  = parseInt(process.env.MAX_TRADES_PER_DAY ?? '5',  10);
const MAX_CONCUR   = parseInt(process.env.MAX_CONCURRENT     ?? '2',  10);
const SWING_STR    = 3;

const candleBuffers = new Map<string, Candle[]>();
const backfilled    = new Set<string>();
const lastSetupKey  = new Map<string, string>();   // anti-spam: per-ticker dedupe

const broker    = new AlpacaBroker();
const tracker   = new TradeTracker(MAX_PER_DAY, MAX_CONCUR, broker);
const portfolio = new PortfolioManager(process.env.PORTFOLIO_FILE ?? './portfolio.json');
portfolio.load();

// Track latest LTF bias per ticker so portfolio hold-status can include it
const latestLtfBias = new Map<string, string>();

// ── Company name → ticker mapping for TradingView DOM ─────────────────────
const COMPANY_TO_TICKER: Record<string, string> = {
  NVIDIA: 'NVDA', NVIDIACORP: 'NVDA', NVIDIACORPORATION: 'NVDA',
  MICRON: 'MU', MICRONTECHNOLOGY: 'MU', MICRONTECHNOLOGYINC: 'MU',
  INTEL: 'INTC', INTELCORP: 'INTC', INTELCORPORATION: 'INTC',
  ADVANCEDMICRODEVICES: 'AMD', AMD: 'AMD',
  TAIWANSEMICONDUCTOR: 'TSM', TSMC: 'TSM',
  BROADCOM: 'AVGO',
  INVESCOQQQTRUST: 'QQQ',
  SANDISK: 'SNDK', SANDISKCORP: 'SNDK', SANDISKCORPORATION: 'SNDK',
  SERVICENOW: 'NOW', SERVICENOWINC: 'NOW',
  CARIS: 'CAI', CARISLIFESCIENCES: 'CAI', CARISLIFESCIENCESINC: 'CAI',
};

function resolveTicker(raw: string): string | null {
  const norm = raw.toUpperCase().replace(/[^A-Z]/g, '');
  for (const t of TICKERS) if (norm === t || norm.includes(t)) return t;
  if (COMPANY_TO_TICKER[norm]) return COMPANY_TO_TICKER[norm];
  for (const [name, ticker] of Object.entries(COMPANY_TO_TICKER)) {
    if (norm.startsWith(name) || name.startsWith(norm)) return ticker;
  }
  return null;
}

function getBuffer(ticker: string): Candle[] {
  if (!candleBuffers.has(ticker)) candleBuffers.set(ticker, []);
  return candleBuffers.get(ticker)!;
}

// ── Backfill + HTF prime ──────────────────────────────────────────────────
async function backfillTicker(ticker: string): Promise<void> {
  if (backfilled.has(ticker)) return;
  try {
    const bars = await fetchHistory(ticker, TIMEFRAME, BUFFER_SIZE);
    candleBuffers.set(ticker, bars);
    backfilled.add(ticker);
    logInfo(`Backfilled ${ticker}: ${bars.length} × ${TIMEFRAME} bars`);
  } catch (err) {
    logError(`Backfill failed for ${ticker}`, err);
  }
}

// ── Candle buffer maintenance ─────────────────────────────────────────────
function bucketStart(timestamp: number, tfMs: number): number {
  return Math.floor(timestamp / tfMs) * tfMs;
}
function timeframeToMs(tf: string): number {
  const m = tf.match(/^(\d+)([mhd])$/);
  if (!m) return 60_000;
  const n = parseInt(m[1], 10);
  return m[2] === 'd' ? n * 86400_000 : m[2] === 'h' ? n * 3600_000 : n * 60_000;
}
const TIMEFRAME_MS = timeframeToMs(TIMEFRAME);

function ingestCandle(raw: RawChartData): void {
  const buf  = getBuffer(raw.ticker);
  const last = buf[buf.length - 1];
  const bucketTs = bucketStart(raw.timestamp, TIMEFRAME_MS);

  if (last && bucketStart(last.timestamp, TIMEFRAME_MS) === bucketTs) {
    buf[buf.length - 1] = {
      ...last,
      high:  Math.max(last.high, raw.high, raw.close),
      low:   Math.min(last.low,  raw.low,  raw.close),
      close: raw.close,
      volume: raw.volume || last.volume,
    };
  } else {
    buf.push({
      timestamp: bucketTs,
      open:  raw.open  || raw.close,
      high:  raw.high  || raw.close,
      low:   raw.low   || raw.close,
      close: raw.close,
      volume: raw.volume,
      timeframe: raw.timeframe,
    });
    if (buf.length > BUFFER_SIZE) buf.shift();
  }
}

// ── Core analysis (silent unless a real setup forms) ──────────────────────
async function analyse(ticker: string, currentPrice: number): Promise<void> {
  const buf = getBuffer(ticker);
  if (buf.length < 30) return;

  // 1. Session-rules gate — no new entries outside the prime intraday window
  const session = getSessionState();
  if (session.shouldForceFlat) {
    tracker.forceCloseAll('EOD force-flat window');
    return;
  }
  if (!session.canEnterNewTrade) return;

  // 2. Structure
  const swings    = detectSwings(buf, SWING_STR);
  const structure = analyseStructure(buf, swings);

  // 3. HTF bias
  const htfBias = await getHTFBias(ticker);

  // Track LTF bias for portfolio hold-status
  latestLtfBias.set(ticker, structure.bias);

  const longsAllowed  = htfBias === 'bullish' &&
                        (structure.bias === 'bullish' || structure.bias === 'ranging');
  const shortsAllowed = htfBias === 'bearish' &&
                        (structure.bias === 'bearish' || structure.bias === 'ranging');
  const direction: 'long' | 'short' | null =
    longsAllowed ? 'long' : shortsAllowed ? 'short' : null;
  if (!direction) return;

  // 4. Day-trading priority: only count RECENT activity (last 20 bars)
  const recencyCutoff = buf[Math.max(0, buf.length - 20)].timestamp;
  const lastBreak     = structure.breaks[structure.breaks.length - 1];

  // Insist on a recent MSS — pure BOS continuations are noisier intraday
  if (!lastBreak || lastBreak.type !== 'MSS' || lastBreak.timestamp < recencyCutoff) {
    return;
  }

  const allOBs    = detectOrderBlocks(buf);
  const allFVGs   = detectFVGs(buf);
  const sweeps    = detectLiquiditySweeps(buf, swings);

  const obs = (direction === 'long'
    ? allOBs.filter(ob => ob.type === 'bullish' && !ob.mitigated)
    : allOBs.filter(ob => ob.type === 'bearish' && !ob.mitigated))
    .sort((a, b) => Math.abs(currentPrice - (a.low + a.high) / 2)
                  - Math.abs(currentPrice - (b.low + b.high) / 2));

  const fvgs = (direction === 'long'
    ? allFVGs.filter(f => f.type === 'bullish' && !f.filled)
    : allFVGs.filter(f => f.type === 'bearish' && !f.filled))
    .sort((a, b) => Math.abs(currentPrice - a.midpoint) - Math.abs(currentPrice - b.midpoint));

  const recentSweep = (direction === 'long'
    ? sweeps.filter(s => s.type === 'sell_side' && s.reversed)
    : sweeps.filter(s => s.type === 'buy_side'  && s.reversed))
    .filter(s => s.sweepTimestamp >= recencyCutoff)
    .sort((a, b) => b.sweepTimestamp - a.sweepTimestamp)[0] ?? null;

  // Day trading insists on a recent sweep — without it, we're just guessing
  if (!recentSweep) return;

  // 5. Volume confirmation — momentum candle with elevated volume
  const momentum = hasMomentumWithVolume(buf, direction);
  if (!momentum.ok) return;

  const nearestOB  = obs[0]  ?? null;
  const nearestFVG = fvgs[0] ?? null;

  const { score, reasons } = scoreConfluence(
    currentPrice, nearestOB, nearestFVG, recentSweep, structure, direction
  );
  // Volume momentum bumps the score
  const finalScore = Math.min(100, score + 10);
  reasons.push(momentum.reason);

  if (finalScore < MIN_CONF) return;

  // 6. Build the setup
  const parts: string[] = [
    `MSS confirmed @ $${lastBreak.price.toFixed(2)}`,
    `${recentSweep.type} liq swept @ $${recentSweep.sweptPrice.toFixed(2)}`,
    momentum.reason,
  ];
  if (nearestOB)  parts.push(`${nearestOB.type} OB $${nearestOB.low.toFixed(2)}-$${nearestOB.high.toFixed(2)}`);
  if (nearestFVG) parts.push(`${nearestFVG.type} FVG $${nearestFVG.bottom.toFixed(2)}-$${nearestFVG.top.toFixed(2)}`);
  const setupType = parts.join(' + ');

  const setup = buildSetup({
    ticker, timeframe: TIMEFRAME,
    direction,
    currentPrice,
    ob:           nearestOB,
    fvg:          nearestFVG,
    sweep:        recentSweep,
    setupType,
    confidence:   finalScore,
    marketBias:   `HTF ${htfBias} / LTF ${structure.bias}`,
    structureNote: `MSS ${lastBreak.direction} @ $${lastBreak.price.toFixed(2)}`,
    keyLevels: [
      `HTF: ${htfBias}`,
      ...reasons,
    ],
  });
  if (!setup) return;

  // 7. Anti-spam: only forward to tracker when the setup KEY actually changes
  const key = `${ticker}_${direction}_${setup.entry.low.toFixed(2)}_${setup.entry.high.toFixed(2)}`;
  if (lastSetupKey.get(ticker) === key) return;
  lastSetupKey.set(ticker, key);

  // 8. Persist to setups.log silently, then hand to the tracker (which prints the action)
  logSetupSilent(setup);
  tracker.considerSetup(setup);
}

// ── Heartbeat (every 5 min) ───────────────────────────────────────────────
function startHeartbeat(): void {
  setInterval(() => {
    const s    = tracker.stats();
    const sess = getSessionState();
    if (!sess.marketOpen) {
      console.log(chalk.gray(`💤 Market closed — ${sess.reason}`));
      return;
    }
    if (sess.shouldForceFlat) {
      console.log(chalk.yellow(`⏰ EOD window — flattening positions`));
      tracker.forceCloseAll();
      return;
    }
    if (!sess.canEnterNewTrade) {
      console.log(chalk.gray(`⏸  Standing down — ${sess.reason}`));
      return;
    }
    const pnl = s.pnlUsd >= 0 ? chalk.greenBright(`+$${s.pnlUsd.toFixed(2)}`)
                              : chalk.redBright(`-$${Math.abs(s.pnlUsd).toFixed(2)}`);
    const sessTag = sess.extendedHours
      ? chalk.magenta(`[${sess.kind.toUpperCase()}]`)
      : chalk.greenBright('[RTH]');
    console.log(chalk.gray(
      `❤️  Heartbeat ${sessTag} — trades: ${s.trades} (${s.wins}W/${s.losses}L) | ` +
      `open: ${s.inMarket} | watching: ${s.watching} | P&L: ` + pnl
    ));
  }, 5 * 60 * 1000);
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\n──────────────────────────────────────────────'));
  console.log(chalk.bold.white('   SMC Day-Trading Agent — Intraday mode    '));
  console.log(chalk.bold.cyan('──────────────────────────────────────────────'));
  console.log(`  Watchlist:    ${chalk.cyan(TICKERS.join(', '))}`);
  console.log(`  Timeframe:    ${TIMEFRAME}  (HTF bias: 1h)`);
  console.log(`  Min conf:     ${MIN_CONF}%`);
  console.log(`  Max trades:   ${MAX_PER_DAY}/day, ${MAX_CONCUR} concurrent`);
  console.log(`  Sessions:     pre 04:00-09:30 | RTH-prime 10:00-11:30 + 13:00-15:30 | post 16:00-20:00 ET`);
  console.log(`                (RTH uses brackets, ext-hours uses limit + tracker-managed exits)`);
  console.log(`  Portfolio:    ${process.env.PORTFOLIO_FILE ?? './portfolio.json'}\n`);

  // Stage 0: Alpaca account info + sync live positions if connected
  await broker.printAccountAtStartup();
  if (broker.isReady()) {
    const alpacaPositions = await broker.getPositions();
    if (alpacaPositions.length > 0) {
      console.log(chalk.bold.cyan(`  🦙 Syncing ${alpacaPositions.length} Alpaca position(s) into portfolio:`));
      for (const p of alpacaPositions) {
        const pnlColour = p.unrealizedPl >= 0 ? chalk.greenBright : chalk.redBright;
        console.log(
          chalk.gray('   • ') + chalk.bold(p.ticker.padEnd(5)) +
          ` ${p.side === 'long' ? '▲ LONG' : '▼ SHORT'}  ${p.qty}sh @ $${p.avgEntryPx.toFixed(2)}  ` +
          chalk.gray(`mkt $${p.marketValue.toFixed(2)} | uPnL `) +
          pnlColour(`${p.unrealizedPl >= 0 ? '+' : ''}$${p.unrealizedPl.toFixed(2)}`)
        );
      }
      console.log();
    }
  }

  // Stage 1: backfill silently in parallel
  await Promise.all(TICKERS.map(t => backfillTicker(t)));

  // Stage 2: prime HTF bias in parallel
  await Promise.all(TICKERS.map(t => getHTFBias(t)));

  // Stage 3: attach to TradingView
  const scraper = new ChartScraper(CDP_URL, POLL_MS);

  scraper.on('data', async (raw: RawChartData) => {
    const ticker = resolveTicker(raw.ticker);
    if (!ticker) return;
    if (!backfilled.has(ticker)) await backfillTicker(ticker);

    const enriched: RawChartData = { ...raw, ticker };
    ingestCandle(enriched);

    // 1. Push every live tick into the tracker (drives entry/exit transitions)
    tracker.onPrice(ticker, raw.price, raw.timestamp);

    // 2. Drive portfolio (open positions you already hold) — exits, breakeven, holds
    portfolio.onPrice(ticker, raw.price, latestLtfBias.get(ticker));

    // 3. Run the SMC analyser (may register a fresh setup with the tracker)
    await analyse(ticker, raw.price);
  });

  scraper.on('disconnected', r => logWarn(`Scraper disconnected (${r}) — reconnecting…`));
  scraper.on('reconnected',  () => logInfo('Scraper reconnected.'));

  const shutdown = async () => {
    console.log('\n');
    tracker.forceCloseAll('Shutdown');
    tracker.printEodSummary();
    portfolio.printSummary();
    if (broker.isLive()) {
      console.log(chalk.yellow('  🦙 Closing all Alpaca positions on shutdown...'));
      await broker.closeAllPositions();
    }
    await scraper.disconnect();
    process.exit(0);
  };
  process.on('SIGINT',  shutdown);
  process.on('SIGTERM', shutdown);
  process.on('uncaughtException',  err => logError('Uncaught exception', err));
  process.on('unhandledRejection', r   => logError('Unhandled rejection', r));

  await scraper.connect();
  scraper.startPolling(TIMEFRAME);
  startHeartbeat();
}

main().catch(err => { logError('Fatal startup error', err); process.exit(1); });
