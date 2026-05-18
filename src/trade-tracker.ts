import chalk from 'chalk';
import { TradingSetup } from './types';
import { winstonLogger } from './logger';
import { AlpacaBroker } from './alpaca-broker';

type Status = 'WATCHING' | 'ENTERED' | 'CLOSED';

interface ActivePosition {
  setupId:     string;
  setupKey:    string;     // dedupe key (ticker + direction + zone)
  ticker:      string;
  direction:   'long' | 'short';
  shares:      number;
  entryZoneLo: number;
  entryZoneHi: number;
  entryIdeal:  number;
  stopLoss:    number;
  takeProfit:  number;     // we exit at TP1 for clean intraday
  setupTime:   number;
  status:      Status;
  entryPrice?: number;
  entryTime?:  number;
  exitPrice?:  number;
  exitTime?:   number;
  exitReason?: 'TP' | 'STOP' | 'EOD' | 'TIMEOUT';
  pnlUsd?:     number;
}

export interface DailyStats {
  trades:     number;
  wins:       number;
  losses:     number;
  pnlUsd:     number;
  watching:   number;
  inMarket:   number;
}

export class TradeTracker {
  private positions = new Map<string, ActivePosition>();
  private trades:   ActivePosition[] = [];
  private maxPerDay: number;
  private maxConcurrent: number;
  private dayKey: string = this._dayKey();
  private broker: AlpacaBroker | null = null;

  constructor(maxPerDay = 5, maxConcurrent = 2, broker: AlpacaBroker | null = null) {
    this.maxPerDay     = maxPerDay;
    this.maxConcurrent = maxConcurrent;
    this.broker        = broker;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** A new setup was emitted. Register it for watching if rules allow. */
  considerSetup(setup: TradingSetup): boolean {
    this._rolloverIfNewDay();

    const key = `${setup.ticker}_${setup.direction}_${setup.entry.low.toFixed(2)}_${setup.entry.high.toFixed(2)}`;

    // Already watching/entered this exact setup? Skip silently (debounce).
    const existing = this.positions.get(setup.ticker);
    if (existing && existing.setupKey === key) return false;

    // Already have an open position on this ticker? One at a time.
    if (existing && existing.status !== 'CLOSED') {
      return false;
    }

    // Daily cap
    if (this.trades.length >= this.maxPerDay) return false;

    // Concurrent cap
    const openCount = [...this.positions.values()].filter(p => p.status === 'WATCHING' || p.status === 'ENTERED').length;
    if (openCount >= this.maxConcurrent) return false;

    const shares = setup.positionSizing?.sharesForTarget ?? 1;
    const tp     = setup.takeProfits[0].price;

    const pos: ActivePosition = {
      setupId:     setup.id,
      setupKey:    key,
      ticker:      setup.ticker,
      direction:   setup.direction,
      shares,
      entryZoneLo: setup.entry.low,
      entryZoneHi: setup.entry.high,
      entryIdeal:  setup.entry.ideal,
      stopLoss:    setup.stopLoss,
      takeProfit:  tp,
      setupTime:   Date.now(),
      status:      'WATCHING',
    };

    this.positions.set(setup.ticker, pos);
    this._logWatching(pos);

    // Hand the setup to Alpaca as a bracket order. Server-side SL/TP are protected
    // even if our agent crashes. In dry-run mode this just logs intent.
    if (this.broker?.isReady()) {
      this.broker.submitBracketOrder({
        ticker:     pos.ticker,
        direction:  pos.direction,
        shares:     pos.shares,
        entryIdeal: pos.entryIdeal,
        stopLoss:   pos.stopLoss,
        takeProfit: pos.takeProfit,
      }).catch(() => { /* logged by broker */ });
    }
    return true;
  }

  /** Drive the state machine with every fresh price tick. */
  onPrice(ticker: string, price: number, time: number = Date.now()): void {
    const pos = this.positions.get(ticker);
    if (!pos || pos.status === 'CLOSED') return;

    if (pos.status === 'WATCHING') {
      const inZone = price >= pos.entryZoneLo && price <= pos.entryZoneHi;
      if (inZone) {
        pos.status     = 'ENTERED';
        pos.entryPrice = price;
        pos.entryTime  = time;
        this._logEntry(pos);
      }
      return;
    }

    // ENTERED — check exits
    if (pos.direction === 'long') {
      if (price <= pos.stopLoss) return this._closePosition(pos, price, time, 'STOP');
      if (price >= pos.takeProfit) return this._closePosition(pos, price, time, 'TP');
    } else {
      if (price >= pos.stopLoss) return this._closePosition(pos, price, time, 'STOP');
      if (price <= pos.takeProfit) return this._closePosition(pos, price, time, 'TP');
    }
  }

  /** Force-close all open/watching positions (called at EOD or on shutdown). */
  forceCloseAll(reasonText = 'End-of-day flat'): void {
    for (const pos of this.positions.values()) {
      if (pos.status === 'WATCHING') {
        // Never entered → just drop, no fill
        pos.status = 'CLOSED';
        console.log(chalk.gray(`  📋 [DROPPED] ${pos.ticker} setup never triggered — ${reasonText}`));
      } else if (pos.status === 'ENTERED') {
        const price = pos.entryPrice ?? pos.entryIdeal;
        this._closePosition(pos, price, Date.now(), 'EOD');
      }
    }
  }

  stats(): DailyStats {
    const wins   = this.trades.filter(t => (t.pnlUsd ?? 0) > 0).length;
    const losses = this.trades.filter(t => (t.pnlUsd ?? 0) < 0).length;
    const pnlUsd = this.trades.reduce((a, t) => a + (t.pnlUsd ?? 0), 0);
    const watching = [...this.positions.values()].filter(p => p.status === 'WATCHING').length;
    const inMarket = [...this.positions.values()].filter(p => p.status === 'ENTERED').length;
    return { trades: this.trades.length, wins, losses, pnlUsd, watching, inMarket };
  }

  printEodSummary(): void {
    const s = this.stats();
    const colour = s.pnlUsd >= 0 ? chalk.greenBright : chalk.redBright;
    console.log('\n' + chalk.gray('═'.repeat(60)));
    console.log(chalk.bold.white('  📊  END-OF-DAY SUMMARY'));
    console.log(chalk.gray('═'.repeat(60)));
    console.log(`  Trades taken:  ${chalk.cyan(s.trades.toString())}`);
    console.log(`  Wins / Losses: ${chalk.greenBright(s.wins)} / ${chalk.redBright(s.losses)}`);
    console.log(`  Net P&L:       ${colour(`$${s.pnlUsd.toFixed(2)}`)}`);
    console.log(chalk.gray('═'.repeat(60)) + '\n');
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private _logWatching(pos: ActivePosition): void {
    const arrow = pos.direction === 'long' ? '▲' : '▼';
    const word  = pos.direction === 'long' ? 'LONG'  : 'SHORT';
    console.log(
      chalk.yellow('📋 [WATCHING]') +
      ` ${arrow} ${chalk.bold(pos.ticker)} ${word} — waiting for price to enter ` +
      chalk.cyan(`$${pos.entryZoneLo.toFixed(2)}–$${pos.entryZoneHi.toFixed(2)}`) +
      chalk.gray(` | Stop $${pos.stopLoss.toFixed(2)} | Target $${pos.takeProfit.toFixed(2)} | ${pos.shares}sh`)
    );
    winstonLogger.info({ event: 'WATCHING', ...pos });
  }

  private _logEntry(pos: ActivePosition): void {
    const label = pos.direction === 'long' ? '[BUY ENTRY]' : '[SHORT ENTRY]';
    const verb  = pos.direction === 'long' ? 'Bought'     : 'Shorted';
    console.log(
      chalk.greenBright(`🟢 ${label}`) +
      ` ${verb} ${chalk.bold.yellow(pos.shares.toString())} shares of ${chalk.bold.white(pos.ticker)} ` +
      `at ${chalk.greenBright(`$${pos.entryPrice!.toFixed(2)}`)} ` +
      chalk.gray(`| Stop Loss: $${pos.stopLoss.toFixed(2)} | Target: $${pos.takeProfit.toFixed(2)}`)
    );
    winstonLogger.info({ event: 'ENTRY', ...pos });
  }

  private _closePosition(pos: ActivePosition, price: number, time: number, reason: 'TP' | 'STOP' | 'EOD' | 'TIMEOUT'): void {
    // Tell the broker to flatten — required in ext hours (no server bracket).
    // In RTH it's belt-and-braces: Alpaca's bracket already exited, this is a no-op.
    if (this.broker?.isLive()) {
      this.broker.closePosition(pos.ticker, price).catch(() => { /* */ });
    }

    pos.status     = 'CLOSED';
    pos.exitPrice  = price;
    pos.exitTime   = time;
    pos.exitReason = reason;

    const perShare = pos.direction === 'long'
      ? price - (pos.entryPrice ?? pos.entryIdeal)
      : (pos.entryPrice ?? pos.entryIdeal) - price;
    pos.pnlUsd = perShare * pos.shares;

    this.trades.push(pos);

    const pnlColour = (pos.pnlUsd ?? 0) >= 0 ? chalk.greenBright : chalk.redBright;
    const sign      = (pos.pnlUsd ?? 0) >= 0 ? '+' : '';
    const tag       = reason === 'TP'   ? 'TARGET HIT' :
                      reason === 'STOP' ? 'STOPPED OUT' :
                      reason === 'EOD'  ? 'EOD CLOSE' :
                                          'TIMED OUT';
    console.log(
      chalk.redBright('🔴 [EXIT/SELL]') +
      ` Closed position for ${chalk.bold.white(pos.ticker)} at ` +
      chalk.white(`$${price.toFixed(2)}`) +
      ` | Result: ` + pnlColour(`${sign}$${(pos.pnlUsd ?? 0).toFixed(2)}`) +
      chalk.gray(`  (${tag})`)
    );
    winstonLogger.info({ event: 'EXIT', ...pos });
  }

  private _dayKey(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private _rolloverIfNewDay(): void {
    const today = this._dayKey();
    if (today !== this.dayKey) {
      this.dayKey   = today;
      this.trades   = [];
      this.positions.clear();
    }
  }
}
