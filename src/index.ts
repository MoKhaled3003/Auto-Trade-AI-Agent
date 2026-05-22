import 'dotenv/config';
import chalk from 'chalk';
import { ChartScraper }    from './scraper';
import { AlpacaFeed }      from './alpaca-feed';
import {
  detectSwings, analyseStructure,
  detectOrderBlocks, detectFVGs,
  detectLiquiditySweeps, scoreConfluence,
  hasMomentumWithVolume,
} from './smc-engine';
import { buildSetup }       from './risk-manager';
import { logInfo, logWarn, logError, logSetupSilent } from './logger';
import { fetchHistory }     from './market-data';
import { fetchHistoryAlpaca } from './alpaca-history';
import { getHTFBias }       from './bias';
import { TradeTracker }     from './trade-tracker';
import { PortfolioManager } from './portfolio';
import { AlpacaBroker }     from './alpaca-broker';
import { getSessionState, minutesUntilNextOpen } from './session-rules';
import { NewsService }         from './news';
import { FundamentalsService } from './fundamentals';
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
const OPP_THRESHOLD = parseInt(process.env.OPPORTUNITY_THRESHOLD ?? String(Math.max(40, MIN_CONF - 15)), 10);
const OPP_LOG_THROTTLE_MS = 5 * 60 * 1000;       // 1 opportunity log per ticker per 5 min
const SWING_STR    = 3;
const lastOppLog   = new Map<string, number>();

// Data source: 'alpaca' (default) or 'tradingview' (legacy CDP scraper).
const DATA_SOURCE  = (process.env.DATA_SOURCE ?? 'alpaca').toLowerCase();
const BAR_POLL_MS    = parseInt(process.env.ALPACA_BAR_POLL_MS   ?? '15000', 10);
const TRADE_POLL_MS  = parseInt(process.env.ALPACA_TRADE_POLL_MS ?? '3000',  10);

// AGGRESSIVE mode — loosens every filter that's been stopping trades from firing.
// More signals = more trades = more wins AND more losses. See heartbeat for stats.
const AGGRESSIVE = (process.env.AGGRESSIVE ?? 'false').toLowerCase() === 'true';
const RECENCY_BARS = AGGRESSIVE ? 50 : 20;

// 🕌 Sharia-compliant mode — long-only spot, no shorting (selling what you don't own),
// no margin. Default ON because Islamic finance is the assumed baseline.
const SHARIA_COMPLIANT = (process.env.SHARIA_COMPLIANT ?? 'true').toLowerCase() === 'true';

const candleBuffers   = new Map<string, Candle[]>();
const backfilled      = new Set<string>();
const lastSetupKey    = new Map<string, string>();   // anti-spam: per-ticker dedupe
const lastBlockReason = new Map<string, string>();   // diagnostic: why each ticker is not firing

const broker    = new AlpacaBroker();
const portfolio = new PortfolioManager(process.env.PORTFOLIO_FILE ?? './portfolio.json');
portfolio.load();

// 🕌 If Sharia mode is on, flag any short positions still listed in portfolio.json
if (SHARIA_COMPLIANT) {
  // We can't read positions directly, but the load() output will reveal shorts
  // (every entry prints with ▲ LONG or ▼ SHORT). Add a header so the user sees it.
  console.log(chalk.gray(
    '   (Sharia mode: any ▼ SHORT entries above are NOT compatible — ' +
    'they were opened before this mode was enabled. Close them manually.)'
  ));
}
// Tracker checks portfolio first to avoid opposite-direction submissions
// that Alpaca would reject (error 40310000).
const tracker   = new TradeTracker(MAX_PER_DAY, MAX_CONCUR, broker, portfolio);

const news         = new NewsService(TICKERS);
const fundamentals = new FundamentalsService(TICKERS);
const ENABLE_NEWS_GATE     = (process.env.ENABLE_NEWS_GATE     ?? 'true').toLowerCase() === 'true';
const ENABLE_EARNINGS_GATE = (process.env.ENABLE_EARNINGS_GATE ?? 'true').toLowerCase() === 'true';

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
  BILIBILI: 'BILI', BILIBILIINC: 'BILI',
  POET: 'POET', POETTECHNOLOGIES: 'POET', POETTECHNOLOGIESINC: 'POET',
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
    const useAlpaca = DATA_SOURCE === 'alpaca' && broker.isReady();
    const client = useAlpaca ? broker.getDataClient() : null;
    const bars = client
      ? await fetchHistoryAlpaca(client, ticker, TIMEFRAME, BUFFER_SIZE)
      : await fetchHistory(ticker, TIMEFRAME, BUFFER_SIZE);
    candleBuffers.set(ticker, bars);
    backfilled.add(ticker);
    logInfo(`Backfilled ${ticker}: ${bars.length} × ${TIMEFRAME} bars (${useAlpaca ? 'alpaca' : 'yahoo'})`);
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
  if (buf.length < 30) { lastBlockReason.set(ticker, `buffer warming (${buf.length}/30)`); return; }

  // 1. Session-rules gate. AGGRESSIVE mode only blocks fully-closed markets;
  //    conservative also blocks lunch/open-vol/close-auction windows.
  const session = getSessionState();
  if (session.shouldForceFlat) {
    tracker.forceCloseAll('EOD force-flat window');
    return;
  }
  if (!session.marketOpen) {
    lastBlockReason.set(ticker, session.reason);
    return;
  }
  if (!AGGRESSIVE && !session.canEnterNewTrade) {
    lastBlockReason.set(ticker, session.reason);
    return;
  }

  // 1b. Earnings filter — never trade near scheduled earnings reports
  if (ENABLE_EARNINGS_GATE && fundamentals.isNearEarnings(ticker, 4, 1)) {
    lastBlockReason.set(ticker, `⚠️  earnings imminent — skipping`);
    return;
  }

  // 2. Structure
  const swings    = detectSwings(buf, SWING_STR);
  const structure = analyseStructure(buf, swings);

  // 3. HTF bias
  const htfBias = await getHTFBias(ticker);

  // Track LTF bias for portfolio hold-status
  latestLtfBias.set(ticker, structure.bias);

  // Bias gate (relaxed in AGGRESSIVE mode: HTF=ranging unlocks both directions,
  // and LTF can disagree as long as HTF gives us a lean)
  let direction: 'long' | 'short' | null;
  if (AGGRESSIVE) {
    // Trust the LTF if HTF is ranging, trust HTF when it has a lean
    const lean = htfBias !== 'ranging' ? htfBias : structure.bias;
    direction = lean === 'bullish' ? 'long' : lean === 'bearish' ? 'short' : null;
  } else {
    const longsAllowed  = htfBias === 'bullish' &&
                          (structure.bias === 'bullish' || structure.bias === 'ranging');
    const shortsAllowed = htfBias === 'bearish' &&
                          (structure.bias === 'bearish' || structure.bias === 'ranging');
    direction = longsAllowed ? 'long' : shortsAllowed ? 'short' : null;
  }

  // 🕌 Sharia gate — block all shorts (selling what you don't own).
  // Bearish bias becomes "stay out, wait for trend reversal" rather than fade it.
  if (SHARIA_COMPLIANT && direction === 'short') {
    lastBlockReason.set(ticker, `🕌 bearish bias — short trades disabled (Sharia mode)`);
    return;
  }
  if (!direction) {
    lastBlockReason.set(ticker, `bias misaligned (HTF=${htfBias}, LTF=${structure.bias})`);
    return;
  }

  // 4. Recency window. Aggressive mode widens it from 20 to 50 bars.
  const recencyCutoff = buf[Math.max(0, buf.length - RECENCY_BARS)].timestamp;
  const lastBreak     = structure.breaks[structure.breaks.length - 1];

  // Conservative: require MSS (reversal). Aggressive: accept MSS or BOS (continuation).
  if (!lastBreak || lastBreak.timestamp < recencyCutoff) {
    lastBlockReason.set(ticker, lastBreak
      ? `last break is stale (${Math.round((Date.now() - lastBreak.timestamp) / 60_000)}m old)`
      : `no structure break detected yet`);
    return;
  }
  if (!AGGRESSIVE && lastBreak.type !== 'MSS') {
    lastBlockReason.set(ticker, `last break is ${lastBreak.type} (conservative mode needs MSS)`);
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

  // Conservative requires a sweep. Aggressive: nice-to-have but not a gate.
  if (!recentSweep && !AGGRESSIVE) {
    lastBlockReason.set(ticker, `no recent liquidity sweep (last ${RECENCY_BARS} bars)`);
    return;
  }

  // 5. Volume confirmation — gate in conservative, bonus in aggressive
  const momentum = hasMomentumWithVolume(buf, direction);
  if (!momentum.ok && !AGGRESSIVE) {
    lastBlockReason.set(ticker, momentum.reason);
    return;
  }

  const nearestOB  = obs[0]  ?? null;
  const nearestFVG = fvgs[0] ?? null;

  const { score, reasons } = scoreConfluence(
    currentPrice, nearestOB, nearestFVG, recentSweep, structure, direction
  );
  // Volume momentum still bumps the score when present
  let finalScore = momentum.ok ? Math.min(100, score + 10) : score;
  if (momentum.ok) reasons.push(momentum.reason);
  else if (AGGRESSIVE) reasons.push(`(no volume confirmation — aggressive entry)`);

  // News alignment modifies the score:
  //   aligned bullish news on a long  → +12   (or bearish on a short)
  //   contradicting news              → -15   (against your direction)
  //   neutral / no news               → no change
  if (ENABLE_NEWS_GATE) {
    const newsScore = news.scoreFor(ticker);
    const aligned   = (direction === 'long' && newsScore > 0) ||
                      (direction === 'short' && newsScore < 0);
    const opposite  = (direction === 'long' && newsScore < -0.2) ||
                      (direction === 'short' && newsScore > 0.2);
    if (aligned && Math.abs(newsScore) > 0.2) {
      const bonus = Math.round(Math.abs(newsScore) * 12);
      finalScore  = Math.min(100, finalScore + bonus);
      reasons.push(`📰 news ${news.describeFor(ticker)} → +${bonus} aligned`);
    } else if (opposite) {
      const penalty = Math.round(Math.abs(newsScore) * 15);
      finalScore    = Math.max(0, finalScore - penalty);
      reasons.push(`📰 news ${news.describeFor(ticker)} → -${penalty} opposes direction`);
    }
  }

  // Optional fundamentals colour: trading WITH the analyst consensus gets a tiny nudge
  const f = fundamentals.get(ticker);
  if (f?.analystRecommendation) {
    const rec = f.analystRecommendation.toLowerCase();
    const buyish  = /buy|strong_buy|outperform/.test(rec);
    const sellish = /sell|strong_sell|underperform/.test(rec);
    if ((direction === 'long' && buyish) || (direction === 'short' && sellish)) {
      finalScore = Math.min(100, finalScore + 3);
      reasons.push(`📑 analyst ${rec} aligns with direction`);
    }
  }

  if (finalScore < MIN_CONF) {
    lastBlockReason.set(ticker, `confluence score ${finalScore}% < min ${MIN_CONF}%`);
    return;
  }
  lastBlockReason.set(ticker, `✅ setup formed (${finalScore}%)`);

  // 6. Build the setup
  const parts: string[] = [
    `${lastBreak.type} ${lastBreak.direction} @ $${lastBreak.price.toFixed(2)}`,
  ];
  if (recentSweep) parts.push(`${recentSweep.type} liq swept @ $${recentSweep.sweptPrice.toFixed(2)}`);
  if (momentum.ok) parts.push(momentum.reason);
  if (nearestOB)   parts.push(`${nearestOB.type} OB $${nearestOB.low.toFixed(2)}-$${nearestOB.high.toFixed(2)}`);
  if (nearestFVG)  parts.push(`${nearestFVG.type} FVG $${nearestFVG.bottom.toFixed(2)}-$${nearestFVG.top.toFixed(2)}`);
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

  // 8. Persist to setups.log silently, then hand to the tracker (which prints the action)
  logSetupSilent(setup);
  const accepted = tracker.considerSetup(setup);
  // Only set the debounce key if the tracker actually took the setup,
  // so a rejection (e.g. max-concurrent) doesn't permanently block this zone.
  if (accepted) lastSetupKey.set(ticker, key);
}

// ── Heartbeat — always-on (every 1 min in AGGRESSIVE, every 5 min otherwise) ──
// Agent never sleeps. Overnight, it shows session info + next-open countdown
// + portfolio P&L. During session it shows trade stats, current mode, and the
// per-ticker scanner status so you can see exactly what each ticker is doing.
function startHeartbeat(): void {
  const intervalMs = AGGRESSIVE ? 60_000 : 5 * 60_000;
  setInterval(() => {
    const s    = tracker.stats();
    const sess = getSessionState();

    if (sess.shouldForceFlat) {
      console.log(chalk.yellow(`⏰ EOD window — flattening positions`));
      tracker.forceCloseAll();
      return;
    }

    const pnl = s.pnlUsd >= 0 ? chalk.greenBright(`+$${s.pnlUsd.toFixed(2)}`)
                              : chalk.redBright(`-$${Math.abs(s.pnlUsd).toFixed(2)}`);

    // ── Closed-market heartbeat: still informative ─────────────────────────
    if (!sess.marketOpen) {
      const mins = minutesUntilNextOpen();
      const h    = Math.floor(mins / 60);
      const m    = mins % 60;
      const eta  = h > 0 ? `${h}h ${m}m` : `${m}m`;
      console.log(chalk.gray(
        `💤 ${sess.reason} | next session in ${chalk.cyan(eta)} | ` +
        `today's trades: ${s.trades} (${s.wins}W/${s.losses}L) P&L: ` + pnl
      ));
      return;
    }

    // ── Stand-down (lunch / open-vol / last-30): track but no entries ─────
    if (!sess.canEnterNewTrade) {
      console.log(chalk.gray(
        `⏸  ${sess.reason} | open: ${s.inMarket} | watching: ${s.watching} | P&L: ` + pnl
      ));
      return;
    }

    // ── Live trading window ───────────────────────────────────────────────
    const sessTag = sess.extendedHours
      ? chalk.magenta(`[${sess.kind.toUpperCase()}]`)
      : chalk.greenBright('[RTH]');
    console.log(chalk.gray(
      `❤️  Heartbeat ${sessTag} — trades: ${s.trades} (${s.wins}W/${s.losses}L) | ` +
      `open: ${s.inMarket} | watching: ${s.watching} | P&L: ` + pnl +
      (AGGRESSIVE ? chalk.red(' 🔥AGG') : '')
    ));
    printScannerStatus();
  }, intervalMs);
}

// Per-ticker diagnostic — shows the most recent reason each ticker isn't trading.
// Lets the user see "agent is alive and scanning, just nothing qualifies right now".
function printScannerStatus(): void {
  if (lastBlockReason.size === 0) return;
  console.log(chalk.gray(`   🔍 Scanner status (${TICKERS.length} tickers):`));
  for (const t of TICKERS) {
    const reason = lastBlockReason.get(t) ?? 'no data yet';
    const colour = reason.startsWith('✅') ? chalk.greenBright
                 : reason.includes('warming') ? chalk.gray
                 : chalk.yellow;
    const newsTag  = ENABLE_NEWS_GATE
      ? chalk.gray(` | 📰 ${news.describeFor(t)}`) : '';
    const fundTag  = (() => {
      const desc = fundamentals.describeFor(t);
      return desc !== 'no fundamentals' && desc !== 'no data'
        ? chalk.gray(` | 📑 ${desc}`) : '';
    })();
    console.log(chalk.gray(`     ${t.padEnd(5)} → `) + colour(reason) + newsTag + fundTag);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(chalk.bold.cyan('\n──────────────────────────────────────────────'));
  console.log(chalk.bold.white('   SMC Day-Trading Agent — Intraday mode    '));
  console.log(chalk.bold.cyan('──────────────────────────────────────────────'));
  console.log(`  Watchlist:    ${chalk.cyan(TICKERS.join(', '))}`);
  console.log(`  Timeframe:    ${TIMEFRAME}  (HTF bias: 1h)`);
  console.log(`  Min conf:     ${MIN_CONF}%`);
  console.log(`  Mode:         ` +
    (AGGRESSIVE ? chalk.redBright('🔥 AGGRESSIVE') + chalk.gray(' (more trades, lower win rate)')
                : chalk.greenBright('🛡  CONSERVATIVE') + chalk.gray(' (fewer trades, higher quality)')));
  console.log(`  Sharia:       ` +
    (SHARIA_COMPLIANT
      ? chalk.greenBright('🕌 ON') + chalk.gray('  — long-only spot, no shorting, no margin')
      : chalk.gray('off — long + short allowed')));
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

  // Stage 2: prime HTF bias in parallel (uses Alpaca client when available)
  const alpacaForBias = broker.isReady() ? broker.getDataClient() : undefined;
  await Promise.all(TICKERS.map(t => getHTFBias(t, alpacaForBias)));

  // Stage 2b: news + fundamentals (non-blocking — start refreshing in background)
  news.start().catch(err => logError('NewsService start failed', err));
  fundamentals.start().catch(err => logError('FundamentalsService start failed', err));

  // Stage 2c: portfolio sync from Alpaca (every 30s) — Alpaca is now the source of truth
  await portfolio.startBrokerSync(broker);

  // ── Stage 3: live feed ───────────────────────────────────────────────────
  const onTick = async (raw: RawChartData) => {
    const ticker = resolveTicker(raw.ticker);
    if (!ticker) return;
    if (!backfilled.has(ticker)) await backfillTicker(ticker);

    const enriched: RawChartData = { ...raw, ticker };
    ingestCandle(enriched);
    tracker.onPrice(ticker, raw.price, raw.timestamp);
    portfolio.onPrice(ticker, raw.price, latestLtfBias.get(ticker));
    await analyse(ticker, raw.price);
  };

  let shutdownFeed: () => Promise<void>;

  if (DATA_SOURCE === 'alpaca' && broker.isReady()) {
    // ── Alpaca async feed (default) ────────────────────────────────────────
    logInfo(`Live feed: Alpaca async (${TICKERS.length} tickers, bar poll ${BAR_POLL_MS}ms, trade poll ${TRADE_POLL_MS}ms)`);
    const feed = new AlpacaFeed(broker.getDataClient(), TICKERS, BAR_POLL_MS, TRADE_POLL_MS);
    feed.on('data', onTick);
    await feed.connect();
    shutdownFeed = () => feed.disconnect();
  } else {
    // ── Legacy TradingView CDP scraper (set DATA_SOURCE=tradingview) ───────
    logInfo(`Live feed: TradingView CDP @ ${CDP_URL}`);
    const scraper = new ChartScraper(CDP_URL, POLL_MS);
    scraper.on('data', onTick);
    scraper.on('disconnected', r => logWarn(`Scraper disconnected (${r}) — reconnecting…`));
    scraper.on('reconnected',  () => logInfo('Scraper reconnected.'));
    await scraper.connect();
    scraper.startPolling(TIMEFRAME);
    shutdownFeed = () => scraper.disconnect();
  }

  const shutdown = async () => {
    console.log('\n');
    portfolio.stopBrokerSync();
    tracker.forceCloseAll('Shutdown');
    tracker.printEodSummary();
    portfolio.printSummary();
    if (broker.isLive()) {
      console.log(chalk.yellow('  🦙 Closing all Alpaca positions on shutdown...'));
      await broker.closeAllPositions();
    }
    await shutdownFeed();
    process.exit(0);
  };
  process.on('SIGINT',  shutdown);
  process.on('SIGTERM', shutdown);
  process.on('uncaughtException',  err => logError('Uncaught exception', err));
  process.on('unhandledRejection', r   => logError('Unhandled rejection', r));

  startHeartbeat();
}

main().catch(err => { logError('Fatal startup error', err); process.exit(1); });
