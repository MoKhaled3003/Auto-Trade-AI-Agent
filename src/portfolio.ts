import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { winstonLogger } from './logger';

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
}

interface PortfolioFile {
  positions: PortfolioPosition[];
}

const HOLD_LOG_THROTTLE_MS = 2 * 60 * 1000;   // one hold-status line per 2 min per ticker

export class PortfolioManager {
  private filePath: string;
  private positions: PortfolioPosition[] = [];
  private lastHoldLog = new Map<string, number>();

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  load(): void {
    if (!fs.existsSync(this.filePath)) {
      console.log(chalk.gray(`📂 No portfolio file at ${this.filePath} — starting empty.`));
      return;
    }
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const obj: PortfolioFile = JSON.parse(raw);
      this.positions = (obj.positions ?? []).map(p => ({
        status: 'OPEN',
        breakevenMoved: false,
        tp1Hit: false,
        tp2Hit: false,
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
