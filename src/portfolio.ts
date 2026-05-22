import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { winstonLogger } from './logger';
import { AlpacaBroker } from './alpaca-broker';

export interface PortfolioPosition {
  ticker:            string;
  direction:         'long' | 'short';
  qty:               number;
  averageEntryPrice: number;
  stopLoss:          number;
  takeProfit1:       number;
  takeProfit2?:      number;

  // internal state (managed by the engine)
  status?:           'OPEN' | 'CLOSED';
  breakevenMoved?:   boolean;
  tp1Hit?:           boolean;
  tp2Hit?:           boolean;
  realizedPnL?:      number;
  closedAt?:         number;
  exitReason?:       'STOP' | 'TP1' | 'TP2' | 'TRAIL';

  // Was this position auto-synced from Alpaca, or manually entered in the file?
  source?:           'alpaca' | 'file';
}

interface PortfolioFile {
  // Optional per-ticker SL/TP overrides — applied when Alpaca sync adopts a position
  overrides?: Array<Partial<PortfolioPosition> & { ticker: string }>;
  // Legacy: full position records (still loadable for backwards compatibility)
  positions?: PortfolioPosition[];
}

const HOLD_LOG_THROTTLE_MS = 2 * 60 * 1000;   // one hold-status line per 2 min per ticker
const SYNC_INTERVAL_MS     = 30_000;          // re-pull Alpaca positions every 30s

// Default SL/TP percentages when Alpaca position has no override
const DEFAULT_STOP_PCT = parseFloat(process.env.DEFAULT_STOP_PCT ?? '0.03');   // 3%
const DEFAULT_TP1_PCT  = parseFloat(process.env.DEFAULT_TP1_PCT  ?? '0.03');   // 3%
const DEFAULT_TP2_PCT  = parseFloat(process.env.DEFAULT_TP2_PCT  ?? '0.06');   // 6%

export class PortfolioManager {
  private filePath: string;
  private positions: PortfolioPosition[] = [];
  private overrides: Map<string, Partial<PortfolioPosition>> = new Map();
  private lastHoldLog = new Map<string, number>();
  private broker:  AlpacaBroker | null = null;
  private syncTimer: NodeJS.Timeout | null = null;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  load(): void {
    if (!fs.existsSync(this.filePath)) {
      console.log(chalk.gray(`📂 No portfolio file at ${this.filePath} — Alpaca is the only source.`));
      return;
    }
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const obj: PortfolioFile = JSON.parse(raw);

      // Index any user-specified SL/TP overrides
      for (const o of obj.overrides ?? []) {
        this.overrides.set(o.ticker, o);
      }
      if (this.overrides.size > 0) {
        console.log(chalk.gray(`📂 Loaded ${this.overrides.size} SL/TP overrides from ${path.basename(this.filePath)}`));
      }

      // Backwards compatibility — keep legacy full positions if present.
      // These get merged with Alpaca positions on sync.
      this.positions = (obj.positions ?? []).map(p => ({
        status: 'OPEN',
        breakevenMoved: false,
        tp1Hit: false,
        tp2Hit: false,
        source: 'file',
        ...p,
      }));
      console.log(chalk.bold.white(`📂 Portfolio loaded: ${this.positions.length} positions`));
      for (const p of this.positions) {
        if (p.status === 'CLOSED') continue;
        const dir = p.direction === 'long' ? '▲ LONG' : '▼ SHORT';
        console.log(
          chalk.gray('   • ') +
          chalk.bold(p.ticker.padEnd(5)) +
          ` ${dir}  ${p.qty}sh @ $${p.averageEntryPrice.toFixed(2)}  ` +
          chalk.gray(`SL $${p.stopLoss.toFixed(2)} / TP1 $${p.takeProfit1.toFixed(2)}` +
            (p.takeProfit2 ? ` / TP2 $${p.takeProfit2.toFixed(2)}` : ''))
        );
      }
      console.log();
    } catch (err) {
      console.error(chalk.red(`Portfolio load failed: ${err instanceof Error ? err.message : err}`));
    }
  }

  /**
   * Connect to Alpaca and treat IT as the source of truth for positions.
   * Re-syncs every SYNC_INTERVAL_MS so positions opened/closed on the
   * Alpaca dashboard (outside the agent) are picked up automatically.
   */
  async startBrokerSync(broker: AlpacaBroker): Promise<void> {
    this.broker = broker;
    if (!broker.isReady()) {
      console.log(chalk.gray('   PortfolioManager: broker not ready — sync disabled.'));
      return;
    }
    await this._syncOnce();
    this.syncTimer = setInterval(() => this._syncOnce().catch(() => {}), SYNC_INTERVAL_MS);
    console.log(chalk.gray(`   PortfolioManager: auto-syncing from Alpaca every ${SYNC_INTERVAL_MS / 1000}s`));
  }

  stopBrokerSync(): void {
    if (this.syncTimer) { clearInterval(this.syncTimer); this.syncTimer = null; }
  }

  private async _syncOnce(): Promise<void> {
    if (!this.broker) return;
    const live = await this.broker.getPositions();
    const liveByTicker = new Map(live.map(p => [p.ticker, p]));

    // 1. Update existing OPEN positions or detect closes
    for (const pos of this.positions) {
      if (pos.status === 'CLOSED') continue;
      if (pos.source === 'file') continue;     // hand-managed entries don't auto-close
      const livePos = liveByTicker.get(pos.ticker);
      if (!livePos) {
        // Position is gone from Alpaca → closed
        pos.status   = 'CLOSED';
        pos.closedAt = Date.now();
        console.log(chalk.gray(`   📂 ${pos.ticker} closed externally (no longer on Alpaca) — marked CLOSED`));
        winstonLogger.info({ event: 'PORTFOLIO_EXTERNAL_CLOSE', ticker: pos.ticker });
      } else {
        // Qty change? Re-base
        if (Math.abs(livePos.qty - pos.qty) > 0) {
          pos.qty               = livePos.qty;
          pos.averageEntryPrice = livePos.avgEntryPx;
        }
        liveByTicker.delete(pos.ticker);
      }
    }

    // 2. Anything left in liveByTicker is a NEW position we didn't know about
    for (const [ticker, lp] of liveByTicker.entries()) {
      const override = this.overrides.get(ticker) ?? {};
      const entry    = lp.avgEntryPx;
      const isLong   = lp.side === 'long';
      const stopLoss    = override.stopLoss    ?? round2(isLong ? entry * (1 - DEFAULT_STOP_PCT) : entry * (1 + DEFAULT_STOP_PCT));
      const takeProfit1 = override.takeProfit1 ?? round2(isLong ? entry * (1 + DEFAULT_TP1_PCT)  : entry * (1 - DEFAULT_TP1_PCT));
      const takeProfit2 = override.takeProfit2 ?? round2(isLong ? entry * (1 + DEFAULT_TP2_PCT)  : entry * (1 - DEFAULT_TP2_PCT));
      const newPos: PortfolioPosition = {
        ticker,
        direction:          lp.side,
        qty:                lp.qty,
        averageEntryPrice:  entry,
        stopLoss,
        takeProfit1,
        takeProfit2,
        status:             'OPEN',
        breakevenMoved:     false,
        tp1Hit:             false,
        tp2Hit:             false,
        source:             'alpaca',
      };
      this.positions.push(newPos);
      const dir = isLong ? '▲ LONG' : '▼ SHORT';
      console.log(chalk.cyan(
        `   📂 Adopted ${ticker} ${dir} ${lp.qty}sh @ $${entry.toFixed(2)}` +
        chalk.gray(`  | SL $${stopLoss.toFixed(2)} | TP1 $${takeProfit1.toFixed(2)} | TP2 $${takeProfit2.toFixed(2)}` +
                   (override.stopLoss ? '  (overrides applied)' : '  (defaults)'))
      ));
    }
  }

  save(): void {
    try {
      const file: PortfolioFile = { positions: this.positions };
      fs.writeFileSync(this.filePath, JSON.stringify(file, null, 2));
    } catch (err) {
      console.error(chalk.red(`Portfolio save failed: ${err instanceof Error ? err.message : err}`));
    }
  }

  positionsFor(ticker: string): PortfolioPosition[] {
    return this.positions.filter(p => p.ticker === ticker && p.status !== 'CLOSED');
  }

  hasOpen(ticker: string): boolean {
    return this.positionsFor(ticker).length > 0;
  }

  // ── Main loop hook ────────────────────────────────────────────────────────

  /**
   * Evaluate live price against every open position for this ticker.
   * Drives exit, breakeven, and hold-status logging.
   *
   * @param ticker      Resolved ticker symbol
   * @param price       Live last price from scraper
   * @param ltfBias     Optional SMC bias context for richer hold reasoning
   */
  onPrice(ticker: string, price: number, ltfBias?: string): void {
    const positions = this.positionsFor(ticker);
    if (positions.length === 0) return;

    for (const pos of positions) {
      this._evaluate(pos, price, ltfBias);
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private _evaluate(pos: PortfolioPosition, price: number, ltfBias?: string): void {
    // 1. Stop-loss breach
    const stopHit = pos.direction === 'long'
      ? price <= pos.stopLoss
      : price >= pos.stopLoss;
    if (stopHit) {
      const pnl = this._pnl(pos, price);
      pos.status      = 'CLOSED';
      pos.exitReason  = pos.breakevenMoved && Math.abs(price - pos.averageEntryPrice) < Math.abs(pos.stopLoss - pos.averageEntryPrice)
                        ? 'TRAIL' : 'STOP';
      pos.realizedPnL = pnl;
      pos.closedAt    = Date.now();

      const tag = pos.exitReason === 'TRAIL' ? 'TRAILING STOP' : 'STOP LOSS';
      console.log(
        chalk.bgRed.white.bold(`  🚨 EMERGENCY EXIT  `) +
        chalk.redBright(`  ${tag} HIT — ${pos.ticker} @ $${price.toFixed(2)}`) +
        chalk.gray(`  | Entry $${pos.averageEntryPrice.toFixed(2)} | ${pos.qty}sh | `) +
        chalk.redBright(`Realized P&L: $${pnl.toFixed(2)}`)
      );
      winstonLogger.warn({ event: 'PORTFOLIO_EXIT_STOP', ...pos, exitPrice: price });
      this.save();
      return;
    }

    // 2. Take-profit hits
    if (!pos.tp1Hit) {
      const tp1Hit = pos.direction === 'long' ? price >= pos.takeProfit1 : price <= pos.takeProfit1;
      if (tp1Hit) {
        pos.tp1Hit = true;
        const pnlAtTp1 = this._pnl(pos, pos.takeProfit1);
        console.log(
          chalk.bgGreen.black.bold(`  🎯 TAKE PROFIT 1  `) +
          chalk.greenBright(`  ${pos.ticker} hit TP1 @ $${pos.takeProfit1.toFixed(2)}`) +
          chalk.gray(`  | Profit on full position: `) +
          chalk.greenBright(`$${pnlAtTp1.toFixed(2)}`) +
          chalk.gray(`  | Suggestion: scale out half + move stop to breakeven`)
        );
        winstonLogger.info({ event: 'PORTFOLIO_TP1', ...pos, hitPrice: pos.takeProfit1 });

        // Auto-move stop to breakeven on TP1
        if (!pos.breakevenMoved) {
          pos.stopLoss = pos.averageEntryPrice;
          pos.breakevenMoved = true;
          console.log(
            chalk.cyan(`  🔒 [BREAKEVEN] ${pos.ticker} stop moved to entry $${pos.averageEntryPrice.toFixed(2)} — risk-free runner.`)
          );
        }
        this.save();
      }
    }

    if (pos.takeProfit2 != null && !pos.tp2Hit) {
      const tp2Hit = pos.direction === 'long' ? price >= pos.takeProfit2 : price <= pos.takeProfit2;
      if (tp2Hit) {
        pos.tp2Hit      = true;
        pos.status      = 'CLOSED';
        pos.exitReason  = 'TP2';
        pos.realizedPnL = this._pnl(pos, pos.takeProfit2);
        pos.closedAt    = Date.now();
        console.log(
          chalk.bgGreen.black.bold(`  🎯 TAKE PROFIT 2 — FULL EXIT  `) +
          chalk.greenBright(`  ${pos.ticker} @ $${pos.takeProfit2.toFixed(2)}`) +
          chalk.gray(`  | `) +
          chalk.greenBright(`Realized P&L: $${pos.realizedPnL.toFixed(2)}`)
        );
        winstonLogger.info({ event: 'PORTFOLIO_TP2_FULL_EXIT', ...pos });
        this.save();
        return;
      }
    }

    // 3. Breakeven trail at 1R (if not already moved)
    if (!pos.breakevenMoved) {
      const riskPerShare = Math.abs(pos.averageEntryPrice - pos.stopLoss);
      const oneRTarget   = pos.direction === 'long'
        ? pos.averageEntryPrice + riskPerShare
        : pos.averageEntryPrice - riskPerShare;
      const at1R = pos.direction === 'long' ? price >= oneRTarget : price <= oneRTarget;
      if (at1R) {
        pos.stopLoss = pos.averageEntryPrice;
        pos.breakevenMoved = true;
        console.log(
          chalk.cyan(`  🔒 [BREAKEVEN] ${pos.ticker} reached 1R profit — stop moved to entry $${pos.averageEntryPrice.toFixed(2)}.`)
        );
        winstonLogger.info({ event: 'PORTFOLIO_BREAKEVEN', ...pos });
        this.save();
      }
    }

    // 4. Hold status (throttled)
    const now      = Date.now();
    const lastLog  = this.lastHoldLog.get(pos.ticker) ?? 0;
    if (now - lastLog >= HOLD_LOG_THROTTLE_MS) {
      this.lastHoldLog.set(pos.ticker, now);
      const pnl     = this._pnl(pos, price);
      const pnlPct  = ((price - pos.averageEntryPrice) / pos.averageEntryPrice) * 100 *
                      (pos.direction === 'long' ? 1 : -1);
      const colour  = pnl >= 0 ? chalk.greenBright : chalk.redBright;
      const sign    = pnl >= 0 ? '+' : '';
      const bias    = ltfBias ? chalk.gray(` | LTF ${ltfBias}`) : '';
      const beTag   = pos.breakevenMoved ? chalk.cyan(' [BE]') : '';
      console.log(
        chalk.bold(pos.ticker.padEnd(5)) + chalk.gray(' | Hold') + beTag +
        chalk.gray(' | Current: ') + chalk.white(`$${price.toFixed(2)}`) +
        chalk.gray(' | Entry: ') + `$${pos.averageEntryPrice.toFixed(2)}` +
        chalk.gray(' | P&L: ') + colour(`${sign}$${pnl.toFixed(2)} (${sign}${pnlPct.toFixed(2)}%)`) +
        bias
      );
    }
  }

  private _pnl(pos: PortfolioPosition, price: number): number {
    const perShare = pos.direction === 'long'
      ? price - pos.averageEntryPrice
      : pos.averageEntryPrice - price;
    return perShare * pos.qty;
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  printSummary(): void {
    if (this.positions.length === 0) return;
    console.log('\n' + chalk.gray('═'.repeat(60)));
    console.log(chalk.bold.white('  💼  PORTFOLIO SUMMARY'));
    console.log(chalk.gray('═'.repeat(60)));
    let totalRealized = 0;
    for (const p of this.positions) {
      const dir = p.direction === 'long' ? '▲' : '▼';
      if (p.status === 'CLOSED') {
        const pnl    = p.realizedPnL ?? 0;
        const colour = pnl >= 0 ? chalk.greenBright : chalk.redBright;
        console.log(
          `  ${dir} ${chalk.bold(p.ticker.padEnd(5))} ${chalk.gray('CLOSED')} @ ${p.exitReason}` +
          chalk.gray(`  ${p.qty}sh from $${p.averageEntryPrice.toFixed(2)}  → `) +
          colour(`$${pnl.toFixed(2)}`)
        );
        totalRealized += pnl;
      } else {
        console.log(
          `  ${dir} ${chalk.bold(p.ticker.padEnd(5))} ${chalk.yellow('OPEN')}` +
          chalk.gray(`  ${p.qty}sh @ $${p.averageEntryPrice.toFixed(2)}` +
            ` | SL $${p.stopLoss.toFixed(2)}` +
            (p.breakevenMoved ? chalk.cyan(' [BE]') : '') +
            ` / TP1 $${p.takeProfit1.toFixed(2)}` +
            (p.takeProfit2 ? ` / TP2 $${p.takeProfit2.toFixed(2)}` : ''))
        );
      }
    }
    if (totalRealized !== 0) {
      const colour = totalRealized >= 0 ? chalk.greenBright : chalk.redBright;
      console.log(chalk.gray('  ─') + chalk.gray('─'.repeat(58)));
      console.log(`  Realized total: ${colour(`$${totalRealized.toFixed(2)}`)}`);
    }
    console.log(chalk.gray('═'.repeat(60)) + '\n');
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
