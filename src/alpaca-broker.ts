import chalk from 'chalk';
import { winstonLogger } from './logger';
import { TradingSetup } from './types';
import { getSessionState } from './session-rules';

/**
 * Thin wrapper around @alpacahq/alpaca-trade-api for paper trading.
 *
 * Two execution modes:
 *   AUTO    - submits real (paper) bracket orders on every BUY/SHORT signal
 *   DRY-RUN - logs what would be submitted, never calls the API
 *
 * Toggle via ALPACA_AUTO_TRADE=true/false in .env. Defaults to DRY-RUN
 * for safety — explicit opt-in to send orders.
 */

// Loose typing — the SDK has no first-class TS types
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Alpaca = require('@alpacahq/alpaca-trade-api');

export interface AlpacaPosition {
  ticker:      string;
  qty:         number;
  side:        'long' | 'short';
  avgEntryPx:  number;
  marketValue: number;
  unrealizedPl: number;
}

export interface OrderSubmission {
  ticker:      string;
  direction:   'long' | 'short';
  shares:      number;
  entryIdeal:  number;
  stopLoss:    number;
  takeProfit:  number;
}

export class AlpacaBroker {
  private client: any;
  private autoTrade: boolean;
  private connected = false;

  constructor() {
    const keyId     = process.env.ALPACA_PAPER_KEY_ID;
    const secretKey = process.env.ALPACA_PAPER_SECRET_KEY;
    this.autoTrade  = (process.env.ALPACA_AUTO_TRADE ?? 'false').toLowerCase() === 'true';

    if (!keyId || !secretKey) {
      console.log(chalk.yellow('⚠️  Alpaca keys missing — broker disabled. ' +
        'Set ALPACA_PAPER_KEY_ID and ALPACA_PAPER_SECRET_KEY in .env.'));
      return;
    }

    this.client = new Alpaca({
      keyId,
      secretKey,
      paper: true,
      baseUrl: 'https://paper-api.alpaca.markets',
    });
    this.connected = true;
  }

  isReady(): boolean { return this.connected; }
  isLive():  boolean { return this.connected && this.autoTrade; }

  /** Return the underlying Alpaca SDK client (for data feed reuse). */
  getDataClient(): any { return this.client; }

  // ── Account ───────────────────────────────────────────────────────────────

  async printAccountAtStartup(): Promise<void> {
    if (!this.connected) return;
    try {
      const acct = await this.client.getAccount();
      const buyingPower = parseFloat(acct.buying_power);
      const cash        = parseFloat(acct.cash);
      const equity      = parseFloat(acct.equity);

      console.log(chalk.gray('─'.repeat(60)));
      console.log(chalk.bold.cyan('  🦙  ALPACA PAPER ACCOUNT'));
      console.log(chalk.gray('─'.repeat(60)));
      console.log(`  Status:        ${chalk.bold(acct.status)}`);
      console.log(`  Cash:          ${chalk.greenBright(`$${cash.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`)}`);
      console.log(`  Buying power:  ${chalk.greenBright(`$${buyingPower.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`)}`);
      console.log(`  Equity:        ${chalk.greenBright(`$${equity.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`)}`);
      console.log(`  Mode:          ${this.autoTrade ? chalk.bgRed.white.bold(' AUTO TRADE ON ') : chalk.bgYellow.black.bold(' DRY-RUN (no real orders) ')}`);
      console.log(chalk.gray('─'.repeat(60)) + '\n');

      winstonLogger.info({ event: 'ALPACA_STARTUP', status: acct.status, cash, buyingPower, equity, autoTrade: this.autoTrade });
    } catch (err) {
      this._handleError('account fetch', err);
    }
  }

  async getPositions(): Promise<AlpacaPosition[]> {
    if (!this.connected) return [];
    try {
      const raw = await this.client.getPositions();
      return raw.map((p: any) => ({
        ticker:       p.symbol,
        qty:          Math.abs(parseInt(p.qty, 10)),
        side:         p.side as 'long' | 'short',
        avgEntryPx:   parseFloat(p.avg_entry_price),
        marketValue:  parseFloat(p.market_value),
        unrealizedPl: parseFloat(p.unrealized_pl),
      }));
    } catch (err) {
      this._handleError('getPositions', err);
      return [];
    }
  }

  // ── Order submission ──────────────────────────────────────────────────────

  /**
   * Submit an entry order. RTH gets a bracket order (server-side SL/TP).
   * Pre/post-market gets a plain limit + extended_hours flag — bracket orders
   * are not allowed outside RTH, so the agent's tracker manages exits manually.
   */
  async submitBracketOrder(req: OrderSubmission): Promise<string | null> {
    if (!this.connected) return null;
    const side    = req.direction === 'long' ? 'buy' : 'sell';
    const session = getSessionState();

    let body: any;
    let tag: string;

    if (session.extendedHours) {
      // Extended hours: bracket not supported. Use aggressive limit so it fills.
      // Buy slightly above entryIdeal, sell slightly below.
      const slip = Math.max(0.05, req.entryIdeal * 0.001);  // 10 bps slip
      const limitPrice = side === 'buy'
        ? round2(req.entryIdeal + slip)
        : round2(req.entryIdeal - slip);
      body = {
        symbol:        req.ticker,
        qty:           req.shares,
        side,
        type:          'limit',
        time_in_force: 'day',
        limit_price:   limitPrice,
        extended_hours: true,
      };
      tag = `EXT-HOURS LIMIT $${limitPrice.toFixed(2)} (no server bracket)`;
    } else {
      // RTH: full bracket order with TP + SL legs
      body = {
        symbol:        req.ticker,
        qty:           req.shares,
        side,
        type:          'market',
        time_in_force: 'day',
        order_class:   'bracket',
        take_profit:   { limit_price: round2(req.takeProfit) },
        stop_loss:     { stop_price:  round2(req.stopLoss)  },
      };
      tag = `BRACKET market | TP $${req.takeProfit.toFixed(2)} | SL $${req.stopLoss.toFixed(2)}`;
    }

    if (!this.autoTrade) {
      console.log(
        chalk.bgYellow.black.bold('  📝 [DRY-RUN ORDER]  ') +
        chalk.yellow(`  ${side.toUpperCase()} ${req.shares} ${req.ticker} — ${tag}`)
      );
      winstonLogger.info({ event: 'ALPACA_DRY_RUN', ...body });
      return null;
    }

    try {
      const order = await this.client.createOrder(body);
      console.log(
        chalk.bgGreen.black.bold('  ✅ [ORDER SUBMITTED]  ') +
        chalk.greenBright(`  ${side.toUpperCase()} ${req.shares} ${req.ticker}`) +
        chalk.gray(`  | ${tag}  | id: ${order.id?.slice(0, 8)}…`)
      );
      winstonLogger.info({ event: 'ALPACA_ORDER_OK', id: order.id, session: session.kind, ...body });
      return order.id;
    } catch (err) {
      this._handleError(`submit ${side} ${req.ticker}`, err);
      return null;
    }
  }

  /**
   * Emergency liquidation: close a position at market.
   * Used when SMC structure shifts against an open position.
   */
  async closePosition(ticker: string, currentPrice?: number): Promise<boolean> {
    if (!this.connected) return false;

    if (!this.autoTrade) {
      console.log(
        chalk.bgYellow.black.bold('  📝 [DRY-RUN CLOSE]  ') +
        chalk.yellow(`  Would close position: ${ticker}`)
      );
      return false;
    }

    const session = getSessionState();

    try {
      if (session.extendedHours) {
        // Need to look up the current open position to know side + qty
        let pos: any;
        try { pos = await this.client.getPosition(ticker); }
        catch { /* no open position */ return false; }

        const qty   = Math.abs(parseInt(pos.qty, 10));
        const isLong = pos.side === 'long';
        const closeSide = isLong ? 'sell' : 'buy';
        // Aggressive limit to actually cross the spread
        const refPx = currentPrice ?? parseFloat(pos.current_price ?? pos.avg_entry_price);
        const slip  = Math.max(0.05, refPx * 0.001);
        const limitPx = isLong ? round2(refPx - slip) : round2(refPx + slip);

        await this.client.createOrder({
          symbol:        ticker,
          qty,
          side:          closeSide,
          type:          'limit',
          time_in_force: 'day',
          limit_price:   limitPx,
          extended_hours: true,
        });
        console.log(
          chalk.bgRed.white.bold('  🚨 [POSITION CLOSED]  ') +
          chalk.redBright(`  ${ticker} ext-hours close @ limit $${limitPx.toFixed(2)}`)
        );
        winstonLogger.warn({ event: 'ALPACA_CLOSE_EXT', ticker, qty, side: closeSide, limitPx });
      } else {
        await this.client.closePosition(ticker);
        console.log(
          chalk.bgRed.white.bold('  🚨 [POSITION CLOSED]  ') +
          chalk.redBright(`  Alpaca liquidated ${ticker} at market`)
        );
        winstonLogger.warn({ event: 'ALPACA_CLOSE', ticker });
      }
      return true;
    } catch (err) {
      this._handleError(`closePosition ${ticker}`, err);
      return false;
    }
  }

  async closeAllPositions(): Promise<void> {
    if (!this.connected || !this.autoTrade) return;
    try {
      await this.client.closeAllPositions();
      console.log(chalk.bgRed.white.bold('  🚨 [CLOSE ALL]  ') + chalk.redBright('  All positions liquidated'));
      winstonLogger.warn({ event: 'ALPACA_CLOSE_ALL' });
    } catch (err) {
      this._handleError('closeAllPositions', err);
    }
  }

  // ── Error handling ────────────────────────────────────────────────────────

  private _handleError(context: string, err: unknown): void {
    const msg     = err instanceof Error ? err.message : String(err);
    const status  = (err as any)?.response?.status;
    const respBody = (err as any)?.response?.data;

    let tag = '❌';
    let advice = '';
    if (status === 401 || status === 403) {
      tag = '🔑';
      advice = ' (check your API keys)';
    } else if (status === 422) {
      tag = '⚠️';
      advice = ' (rejected — likely market closed, PDT rule, or insufficient buying power)';
    } else if (status === 429) {
      tag = '⏱️';
      advice = ' (rate limited — backing off)';
    } else if (status >= 500) {
      tag = '☁️';
      advice = ' (Alpaca server hiccup)';
    }

    console.log(
      chalk.redBright(`${tag} Alpaca ${context} failed: ${msg}${advice}`) +
      (respBody ? chalk.gray(`  | ${JSON.stringify(respBody).slice(0, 200)}`) : '')
    );
    winstonLogger.error({ event: 'ALPACA_ERROR', context, message: msg, status });
  }
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
