/**
 * Diagnostic: probe Alpaca's data API to see what (if anything) is coming back.
 *
 *   npx ts-node src/test-alpaca-data.ts
 *
 * Tests in order:
 *   1. Account auth         (proves keys work)
 *   2. Latest trades batch  (live last-price)
 *   3. Latest bars batch    (1-min OHLC)
 *   4. Historical bars      (the backfill path)
 *   5. Direct REST fallback (raw fetch, bypassing the SDK)
 *
 * Each step prints the raw response so we can see exactly which one fails.
 */

import 'dotenv/config';
import chalk from 'chalk';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Alpaca = require('@alpacahq/alpaca-trade-api');

const TICKERS = (process.env.TICKERS ?? 'NVDA,MU,INTC,AMD').split(',').slice(0, 4);

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

  console.log(chalk.bold.cyan('\n──────────────────────────────────────────────'));
  console.log(chalk.bold.white('   ALPACA DATA FLOW DIAGNOSTIC'));
  console.log(chalk.bold.cyan('──────────────────────────────────────────────\n'));
  console.log(`Testing tickers: ${chalk.cyan(TICKERS.join(', '))}\n`);

  // ── Test 1: Auth ──────────────────────────────────────────────────────────
  console.log(chalk.bold('[1] Account auth'));
  try {
    const acct = await alpaca.getAccount();
    console.log(chalk.greenBright(`    ✅ Account ${acct.account_number} — status: ${acct.status}, cash: $${parseFloat(acct.cash).toFixed(2)}\n`));
  } catch (err: any) {
    console.error(chalk.red(`    ❌ Auth failed: ${err.message}`));
    if (err.response?.data) console.error(chalk.red(`       Body: ${JSON.stringify(err.response.data)}`));
    return;
  }

  // ── Test 2: getLatestTrades (batch) ───────────────────────────────────────
  console.log(chalk.bold('[2] getLatestTrades batch (IEX feed)'));
  try {
    const trades = await alpaca.getLatestTrades(TICKERS, { feed: 'iex' });
    console.log(chalk.gray(`    raw type: ${typeof trades}, isMap: ${trades instanceof Map}, isArray: ${Array.isArray(trades)}`));
    const entries = normaliseEntries(trades);
    if (entries.length === 0) {
      console.log(chalk.red(`    ❌ Empty response — Alpaca returned nothing.`));
    } else {
      for (const [sym, t] of entries) {
        const price = t?.Price ?? t?.p ?? '?';
        const ts    = t?.Timestamp ?? t?.t ?? '?';
        console.log(chalk.greenBright(`    ✅ ${sym.padEnd(5)} $${price}  @ ${ts}`));
      }
    }
  } catch (err: any) {
    console.error(chalk.red(`    ❌ getLatestTrades failed: ${err.message}`));
    if (err.response?.data) console.error(chalk.red(`       Body: ${JSON.stringify(err.response.data)}`));
  }
  console.log();

  // ── Test 3: getLatestBars (batch) ─────────────────────────────────────────
  console.log(chalk.bold('[3] getLatestBars batch (IEX feed)'));
  try {
    const bars = await alpaca.getLatestBars(TICKERS, { feed: 'iex' });
    const entries = normaliseEntries(bars);
    if (entries.length === 0) {
      console.log(chalk.red(`    ❌ Empty response — no bars at all.`));
    } else {
      for (const [sym, b] of entries) {
        const o = b?.OpenPrice  ?? b?.o ?? '?';
        const h = b?.HighPrice  ?? b?.h ?? '?';
        const l = b?.LowPrice   ?? b?.l ?? '?';
        const c = b?.ClosePrice ?? b?.c ?? '?';
        const v = b?.Volume     ?? b?.v ?? '?';
        const t = b?.Timestamp  ?? b?.t ?? '?';
        console.log(chalk.greenBright(`    ✅ ${sym.padEnd(5)} O:${o} H:${h} L:${l} C:${c} V:${v}  @ ${t}`));
      }
    }
  } catch (err: any) {
    console.error(chalk.red(`    ❌ getLatestBars failed: ${err.message}`));
    if (err.response?.data) console.error(chalk.red(`       Body: ${JSON.stringify(err.response.data)}`));
  }
  console.log();

  // ── Test 4: Historical bars (the backfill path) ───────────────────────────
  console.log(chalk.bold('[4] getBarsV2 historical (300 × 15Min for NVDA)'));
  try {
    const start = new Date(Date.now() - 30 * 86400_000).toISOString();
    const iter  = alpaca.getBarsV2('NVDA', {
      start, timeframe: '15Min', limit: 300, adjustment: 'raw', feed: 'iex',
    });
    let count  = 0;
    let firstTs: string | undefined;
    let lastTs:  string | undefined;
    let lastC:   any;
    for await (const b of iter) {
      count++;
      if (!firstTs) firstTs = String(b.Timestamp ?? b.t);
      lastTs = String(b.Timestamp ?? b.t);
      lastC  = b.ClosePrice ?? b.c;
    }
    if (count === 0) {
      console.log(chalk.red(`    ❌ Zero bars returned for NVDA — historical feed empty.`));
    } else {
      console.log(chalk.greenBright(`    ✅ ${count} bars  ${firstTs} → ${lastTs}  (last close $${lastC})`));
    }
  } catch (err: any) {
    console.error(chalk.red(`    ❌ getBarsV2 failed: ${err.message}`));
    if (err.response?.data) console.error(chalk.red(`       Body: ${JSON.stringify(err.response.data)}`));
  }
  console.log();

  // ── Test 5: Direct REST call (bypass SDK) ─────────────────────────────────
  console.log(chalk.bold('[5] Direct REST call (bypasses SDK)'));
  try {
    const url = `https://data.alpaca.markets/v2/stocks/trades/latest?symbols=${TICKERS.join(',')}&feed=iex`;
    const res = await fetch(url, {
      headers: {
        'APCA-API-KEY-ID':     keyId,
        'APCA-API-SECRET-KEY': secretKey,
      },
    });
    console.log(chalk.gray(`    HTTP ${res.status} ${res.statusText}`));
    const text = await res.text();
    console.log(chalk.gray(`    ${text.slice(0, 500)}${text.length > 500 ? '…' : ''}`));
  } catch (err: any) {
    console.error(chalk.red(`    ❌ Direct REST failed: ${err.message}`));
  }

  console.log(chalk.bold.cyan('\n──────────────────────────────────────────────'));
  console.log(chalk.bold.white(' Done. The first test that ❌ failed is the broken link.'));
  console.log(chalk.bold.cyan('──────────────────────────────────────────────\n'));
}

function normaliseEntries(resp: any): Array<[string, any]> {
  if (!resp) return [];
  if (Array.isArray(resp)) return resp.map(r => [r.Symbol ?? r.S ?? r.symbol, r]);
  if (resp instanceof Map) return [...resp.entries()];
  if (typeof resp === 'object') return Object.entries(resp);
  return [];
}

main().catch(err => {
  console.error(chalk.red(`\nFatal: ${err.message}`));
  if (err.stack) console.error(chalk.gray(err.stack));
  process.exit(1);
});
