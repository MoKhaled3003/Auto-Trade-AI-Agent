/**
 * Discover Sahm Capital's historical kline (candlestick) endpoint.
 *
 * Run:  npx ts-node src/sahm-discover.ts INTC
 *
 * In the open browser:
 *   1. Log in (if prompted)
 *   2. Click the chart to focus it
 *   3. Click each timeframe button: 1m, 5m, 15m, 30m, 1h, 1d
 *   4. Drag chart left to load older bars
 *   5. Wait until the 90s capture window finishes
 */

import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';

const TICKER     = process.argv[2] ?? 'INTC';
const TARGET_URL = `https://app.sahmcapital.com/stock/detail?data_type=20000&code=${TICKER}`;
const USER_DATA_DIR = path.resolve(__dirname, '..', 'browser-data');
const LOG_FILE      = path.resolve(__dirname, '..', 'logs', `sahm-discover-${TICKER}.log`);
const CAPTURE_MS    = 90_000;

if (!fs.existsSync(path.dirname(LOG_FILE))) fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

interface LoggedCall {
  ts:           number;
  kind:         'fetch' | 'xhr' | 'websocket' | 'ws-frame';
  url:          string;
  method?:      string;
  status?:      number;
  reqBody?:     string;
  bodySample?:  string;
}

const calls: LoggedCall[] = [];

function append(call: LoggedCall): void {
  calls.push(call);
  fs.appendFileSync(LOG_FILE, JSON.stringify(call) + '\n');
}

function isSahmData(url: string): boolean {
  return /sahmcapital\.com/.test(url) &&
         !/sentry|sensors-api|googletag|analytics|doubleclick|gtag|gtm|\.css|\.png|\.jpg|\.svg|\.woff|\.ico/.test(url) &&
         !/r\.sahmcapital\.com/.test(url);
}

async function main() {
  console.log('────────────────────────────────────────────────');
  console.log('  Sahm Capital — kline endpoint discovery');
  console.log('────────────────────────────────────────────────');
  console.log(`Persistent profile: ${USER_DATA_DIR}`);
  console.log(`Recording window:   ${CAPTURE_MS / 1000}s\n`);

  fs.writeFileSync(LOG_FILE, '');

  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1500, height: 950 },
    args: ['--start-maximized'],
  });

  const page = await ctx.newPage();

  page.on('request', req => {
    const url = req.url();
    if (!isSahmData(url)) return;

    let reqBody: string | undefined;
    try {
      const body = req.postData();
      if (body && body.length < 800) reqBody = body;
    } catch { /* */ }

    append({
      ts: Date.now(),
      kind: req.resourceType() === 'xhr' ? 'xhr' : 'fetch',
      url,
      method: req.method(),
      reqBody,
    });
  });

  page.on('response', async res => {
    const url = res.url();
    if (!isSahmData(url)) return;

    let bodySample: string | undefined;
    try {
      const text = await res.text();
      bodySample = text.slice(0, 600);
    } catch { /* */ }

    append({ ts: Date.now(), kind: 'fetch', url, status: res.status(), bodySample });
  });

  page.on('websocket', ws => {
    console.log(`[WS open] ${ws.url()}`);
    append({ ts: Date.now(), kind: 'websocket', url: ws.url() });
    ws.on('framereceived', frame => {
      try {
        const payload = typeof frame.payload === 'string'
          ? frame.payload
          : frame.payload.toString('utf8');
        if (payload && payload.length < 2000) {
          append({ ts: Date.now(), kind: 'ws-frame', url: ws.url(), bodySample: payload.slice(0, 400) });
        }
      } catch { /* */ }
    });
  });

  console.log(`Navigating to ${TARGET_URL} ...\n`);
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(' ACTION NEEDED IN THE OPEN BROWSER:');
  console.log('   1.  Log in to Sahm if prompted');
  console.log('   2.  Click on the chart to activate it');
  console.log('   3.  Click each timeframe button: 1m, 5m, 15m, 30m, 1h, 1d');
  console.log('   4.  Drag the chart left to load older bars');
  console.log(`   5.  Leave it alone — recording for ${CAPTURE_MS / 1000}s`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  await page.waitForTimeout(CAPTURE_MS);

  console.log(`\n✓  Captured ${calls.length} Sahm API calls`);
  console.log(`   Log: ${LOG_FILE}\n`);

  console.log('─── queryKline requests grouped by `type` parameter ───');
  interface PairedKline { type: string; limit: string; bars: number; firstTs?: string; secondTs?: string; }
  const klineByType = new Map<string, PairedKline>();

  for (let i = 0; i < calls.length; i++) {
    const c = calls[i];
    if (!c.reqBody || !/queryKline/.test(c.url)) continue;

    const typeMatch  = c.reqBody.match(/[?&]type=([^&]+)/);
    const limitMatch = c.reqBody.match(/[?&]limit=([^&]+)/);
    if (!typeMatch) continue;
    const type  = typeMatch[1];
    const limit = limitMatch?.[1] ?? '?';

    const pathname = new URL(c.url).pathname;
    const response = calls.slice(i + 1).find(r =>
      r.status === 200 && r.url.includes(pathname) && r.bodySample
    );

    let bars = 0; let firstTs: string | undefined; let secondTs: string | undefined;
    if (response?.bodySample) {
      const patterns = [
        /"time":"?(\d+)"?/g,
        /"t":"?(\d+)"?/g,
        /"timestamp":"?(\d+)"?/g,
        /"openTime":"?(\d+)"?/g,
        /"date":"?(\d+)"?/g,
        /"\d{14,17}"/g,
      ];
      for (const p of patterns) {
        const m = [...response.bodySample.matchAll(p)];
        if (m.length > 0) {
          bars = m.length;
          firstTs  = m[0]?.[1] ?? m[0]?.[0];
          secondTs = m[1]?.[1] ?? m[1]?.[0];
          break;
        }
      }
    }

    if (!klineByType.has(type)) {
      klineByType.set(type, { type, limit, bars, firstTs, secondTs });
    }
  }

  if (klineByType.size === 0) {
    console.log('  (no queryKline calls captured — please click each timeframe)');
  } else {
    console.log('  type | limit |  bars | first bar ts        | gap (1st→2nd)');
    console.log('  -----+-------+-------+---------------------+----------------');
    for (const k of [...klineByType.values()].sort((a, b) => parseInt(a.type) - parseInt(b.type))) {
      const gap = k.firstTs && k.secondTs ? `${k.firstTs} → ${k.secondTs}` : 'n/a';
      console.log(`  ${k.type.padStart(4)} | ${k.limit.padStart(5)} | ${k.bars.toString().padStart(5)} | ${(k.firstTs ?? '').padEnd(19)} | ${gap}`);
    }
  }

  console.log('\n─── Raw queryKline response samples ───');
  const seenTypes = new Set<string>();
  for (let i = 0; i < calls.length && seenTypes.size < 8; i++) {
    const req = calls[i];
    if (!req.reqBody || !/queryKline/.test(req.url)) continue;
    const typeMatch = req.reqBody.match(/[?&]type=([^&]+)/);
    if (!typeMatch || seenTypes.has(typeMatch[1])) continue;
    const pathname = new URL(req.url).pathname;
    const resp = calls.slice(i + 1).find(r =>
      r.status === 200 && r.url.includes(pathname) && r.bodySample
    );
    if (!resp) continue;
    seenTypes.add(typeMatch[1]);
    console.log(`\n  --- type=${typeMatch[1]} (${pathname}) ---`);
    console.log(`  ${resp.bodySample}`);
  }

  console.log('\n─── All unique POST endpoints seen ───');
  const posts = new Map<string, number>();
  for (const c of calls) {
    if (c.method === 'POST') {
      try {
        const p = new URL(c.url).pathname;
        posts.set(p, (posts.get(p) ?? 0) + 1);
      } catch { /* */ }
    }
  }
  for (const [p, n] of [...posts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n.toString().padStart(4)}  ${p}`);
  }

  await ctx.close();
}

main().catch(e => { console.error(e); process.exit(1); });
