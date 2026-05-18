/**
 * Smoke test: buy a ticker on Alpaca paper, wait for fill, then close.
 * Handles RTH AND extended-hours (pre-market 04:00–09:30 ET, post-market 16:00–20:00 ET).
 *
 * Usage:  npx ts-node src/test-alpaca.ts [TICKER] [QTY]
 *   default ticker = MU, default qty = 1
 */

import 'dotenv/config';
import chalk from 'chalk';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Alpaca = require('@alpacahq/alpaca-trade-api');

const TICKER = (process.argv[2] ?? 'MU').toUpperCase();
const QTY    = parseInt(process.argv[3] ?? '1', 10);

async function main() {
  const keyId     = process.env.ALPACA_PAPER_KEY_ID;
  const secretKey = process.env.ALPACA_PAPER_SECRET_KEY;
  if (!keyId || !secretKey) {
    console.error(chalk.red('Missing ALPACA_PAPER_KEY_ID / ALPACA_PAPER_SECRET_KEY in .env'));
    process.exit(1);
  }

  const alpaca = new Alpaca({
    keyId, secretKey, paper: true,
    baseUrl: 'https://paper-api.alpaca.markets',
  });

  console.log(chalk.gray('─'.repeat(60)));
  console.log(chalk.bold.cyan(`  🧪  ALPACA ROUND-TRIP TEST — ${TICKER} × ${QTY}`));
  console.log(chalk.gray('─'.repeat(60)));

  // ── 1. Account ─────────────────────────────────────────────────────────
  const acct = await alpaca.getAccount();
  console.log(`  Account:      ${chalk.bold(acct.status)}`);
  console.log(`  Cash:         ${chalk.greenBright(`$${parseFloat(acct.cash).toFixed(2)}`)}`);
  console.log(`  Buying power: ${chalk.greenBright(`$${parseFloat(acct.buying_power).toFixed(2)}`)}`);

  // ── 2. Detect session (RTH vs extended) ───────────────────────────────
  const clock = await alpaca.getClock();
  const session = detectSession();
  console.log(`  Session:      ${session.label}` +
              chalk.gray(`  | RTH open: ${clock.is_open ? 'YES' : 'NO'}`));

  if (session.kind === 'closed') {
    console.log(chalk.red('\n❌ Market fully closed (overnight/weekend). Try again 04:00–20:00 ET.\n'));
    return;
  }

  const useExtendedHours = session.kind !== 'rth';
  const orderType: 'market' | 'limit' = useExtendedHours ? 'limit' : 'market';
  console.log(chalk.gray(`  Order type:   ${orderType}` +
                          (useExtendedHours ? ' (extended-hours limit)' : '')));

  // ── 3. Get live quote (needed for limit pricing in extended hours) ─────
  const quote = await getQuote(alpaca, TICKER);
  console.log(chalk.gray(`  Quote ${TICKER}:    bid $${quote.bid.toFixed(2)} / ask $${quote.ask.toFixed(2)}`));

  if (!quote.bid || !quote.ask) {
    console.log(chalk.red('\n❌ No live quote available for this ticker.\n'));
    return;
  }

  // Aggressive limit prices to maximize fill probability
  const buyLimit  = round2(quote.ask + 0.05);   // pay a nickel above ask
  const sellLimit = round2(quote.bid - 0.05);   // accept a nickel below bid

  // ── 4. Submit BUY ──────────────────────────────────────────────────────
  console.log(chalk.gray('\n  ➤ Step 1: Submitting BUY order...'));
  const buyParams: any = {
    symbol:        TICKER,
    qty:           QTY,
    side:          'buy',
    type:          orderType,
    time_in_force: 'day',
  };
  if (orderType === 'limit') {
    buyParams.limit_price     = buyLimit;
    buyParams.extended_hours  = true;
    console.log(chalk.gray(`         BUY ${QTY} @ limit $${buyLimit.toFixed(2)} (above ask)`));
  }

  const buyOrder = await alpaca.createOrder(buyParams);
  console.log(chalk.greenBright(`  ✅ Buy submitted`) +
              chalk.gray(` | id: ${buyOrder.id.slice(0, 8)}…`));

  // ── 5. Wait for fill ─────────────────────────────────────────────────
  console.log(chalk.gray('  ➤ Step 2: Waiting for fill (up to 60s)...'));
  const filled = await waitForFill(alpaca, buyOrder.id, 60_000);
  if (!filled) {
    console.log(chalk.red('  ❌ Buy order did not fill. Cancelling to be safe...'));
    try { await alpaca.cancelOrder(buyOrder.id); } catch { /* */ }
    return;
  }
  const entryPx = parseFloat(filled.filled_avg_price);
  console.log(chalk.greenBright(`  ✅ Filled ${filled.filled_qty} ${TICKER} @ $${entryPx.toFixed(2)}`));

  // ── 6. Hold 5s then close ────────────────────────────────────────────
  console.log(chalk.gray('\n  ➤ Step 3: Holding 5s before closing...'));
  await sleep(5_000);

  console.log(chalk.gray('  ➤ Step 4: Submitting SELL order...'));
  let closeOrderId: string | null = null;

  if (orderType === 'market') {
    // RTH: closePosition() is simplest
    const closeOrder = await alpaca.closePosition(TICKER);
    closeOrderId = closeOrder.id ?? null;
    console.log(chalk.greenBright(`  ✅ Close submitted (market)`) +
                chalk.gray(` | id: ${closeOrderId?.slice(0, 8) ?? '?'}…`));
  } else {
    // Extended hours: must use explicit limit + extended_hours flag
    // (closePosition issues a market order which fails in ext hours)
    const sellOrder = await alpaca.createOrder({
      symbol:         TICKER,
      qty:            QTY,
      side:           'sell',
      type:           'limit',
      time_in_force:  'day',
      limit_price:    sellLimit,
      extended_hours: true,
    });
    const sellId: string = sellOrder.id;
    closeOrderId = sellId;
    console.log(chalk.greenBright(`  ✅ Sell submitted`) +
                chalk.gray(` @ limit $${sellLimit.toFixed(2)} | id: ${sellId.slice(0, 8)}…`));
  }

  // ── 7. Wait for close fill ───────────────────────────────────────────
  const closed = closeOrderId ? await waitForFill(alpaca, closeOrderId, 60_000) : null;
  if (closed) {
    const exitPx  = parseFloat(closed.filled_avg_price);
    const pnl     = (exitPx - entryPx) * QTY;
    const pnlPct  = ((exitPx - entryPx) / entryPx) * 100;
    const colour  = pnl >= 0 ? chalk.greenBright : chalk.redBright;
    const sign    = pnl >= 0 ? '+' : '';

    console.log(chalk.greenBright(`  ✅ Sold @ $${exitPx.toFixed(2)}`));
    console.log(chalk.gray('─'.repeat(60)));
    console.log(chalk.bold('  📊  ROUND-TRIP RESULT'));
    console.log(`  Entry:        $${entryPx.toFixed(2)}`);
    console.log(`  Exit:         $${exitPx.toFixed(2)}`);
    console.log(`  Realized P&L: ${colour(`${sign}$${pnl.toFixed(2)} (${sign}${pnlPct.toFixed(2)}%)`)}`);
  } else {
    console.log(chalk.red('  ❌ Close order did not fill. Cancelling...'));
    if (closeOrderId) {
      try { await alpaca.cancelOrder(closeOrderId); } catch { /* */ }
    }
    console.log(chalk.yellow('  ⚠️  You still have an open position. Close it manually on the dashboard.'));
  }

  // ── 8. Final snapshot ────────────────────────────────────────────────
  const finalAcct = await alpaca.getAccount();
  console.log(chalk.gray('─'.repeat(60)));
  console.log(`  Final cash:   ${chalk.greenBright(`$${parseFloat(finalAcct.cash).toFixed(2)}`)}`);
  console.log(`  Final equity: ${chalk.greenBright(`$${parseFloat(finalAcct.equity).toFixed(2)}`)}`);
  console.log(chalk.gray('─'.repeat(60)) + '\n');
}

// ── helpers ───────────────────────────────────────────────────────────────

function detectSession(): { kind: 'pre' | 'rth' | 'post' | 'closed'; label: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  }).formatToParts(new Date());
  const h  = parseInt(parts.find(p => p.type === 'hour')!.value, 10) % 24;
  const m  = parseInt(parts.find(p => p.type === 'minute')!.value, 10);
  const wd = parts.find(p => p.type === 'weekday')!.value;
  const mins = h * 60 + m;

  if (wd === 'Sat' || wd === 'Sun') return { kind: 'closed', label: 'Weekend' };
  if (mins >= 4 * 60   && mins < 9 * 60 + 30)  return { kind: 'pre',  label: 'Pre-market (04:00–09:30 ET)' };
  if (mins >= 9 * 60 + 30 && mins < 16 * 60)   return { kind: 'rth',  label: 'RTH (09:30–16:00 ET)' };
  if (mins >= 16 * 60  && mins < 20 * 60)      return { kind: 'post', label: 'Post-market (16:00–20:00 ET)' };
  return { kind: 'closed', label: 'Overnight (closed)' };
}

async function getQuote(alpaca: any, ticker: string): Promise<{ bid: number; ask: number; last: number }> {
  try {
    const trade = await alpaca.getLatestTrade(ticker);
    const quote = await alpaca.getLatestQuote(ticker);
    return {
      bid:  parseFloat(quote.BidPrice ?? quote.bp ?? '0') || parseFloat(trade.Price ?? trade.p ?? '0'),
      ask:  parseFloat(quote.AskPrice ?? quote.ap ?? '0') || parseFloat(trade.Price ?? trade.p ?? '0'),
      last: parseFloat(trade.Price ?? trade.p ?? '0'),
    };
  } catch (err) {
    console.log(chalk.yellow(`  ⚠️  Quote fetch error: ${err instanceof Error ? err.message : err}`));
    return { bid: 0, ask: 0, last: 0 };
  }
}

async function waitForFill(alpaca: any, orderId: string, timeoutMs: number): Promise<any | null> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = '';
  while (Date.now() < deadline) {
    const order = await alpaca.getOrder(orderId);
    if (order.status !== lastStatus) {
      console.log(chalk.gray(`         status: ${order.status}`));
      lastStatus = order.status;
    }
    if (order.status === 'filled') return order;
    if (['canceled', 'rejected', 'expired', 'done_for_day'].includes(order.status)) {
      console.log(chalk.red(`  ❌ Order ${order.status}`));
      return null;
    }
    await sleep(1500);
  }
  return null;
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }
function round2(n: number): number { return Math.round(n * 100) / 100; }

main().catch(err => {
  const msg     = err instanceof Error ? err.message : String(err);
  const status  = (err as any)?.response?.status;
  const data    = (err as any)?.response?.data;
  console.error(chalk.red(`\n❌ Test failed: ${msg}`));
  if (status)  console.error(chalk.gray(`   HTTP status: ${status}`));
  if (data)    console.error(chalk.gray(`   Body: ${JSON.stringify(data).slice(0, 300)}`));
  process.exit(1);
});
