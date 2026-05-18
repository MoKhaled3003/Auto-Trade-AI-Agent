import { chromium, BrowserContext, Page } from 'playwright';
import { EventEmitter } from 'events';
import path from 'path';
import { Candle, RawChartData } from './types';
import { logInfo, logWarn, logError } from './logger';

/**
 * SahmScraper - drives Sahm Capital's web app via Playwright with a persistent
 * browser context. Reads candle history (queryKline) and live prices
 * (queryBasic, queryPreAfterSimple) directly off the network.
 *
 * Sahm's API is HMAC-signed by their JS bundle, so we cannot POST to it
 * directly from Node. Instead we navigate the real page and intercept the
 * responses their own JS produces.
 */

const SAHM_BASE     = 'https://app.sahmcapital.com/stock/detail?data_type=20000&code=';
const USER_DATA_DIR = path.resolve(__dirname, '..', 'browser-data');

// Sahm timeframe ID -> internal label. We confirmed:
//   type=2 → daily.
// (Other intraday types not yet mapped; daily is what we use for SMC swing.)
const TIMEFRAME_TO_TYPE: Record<string, number> = {
  '1d': 2,
  'D':  2,
};

interface SahmKline {
  timestamp: number;   // unix ms
  open:      number;
  close:     number;
  high:      number;
  low:       number;
  volume:    number;
}

interface SahmPrice {
  ticker:    string;
  lastPrice: number;
  prevClose: number;
  open:      number;
  high:      number;
  low:       number;
  volume:    number;
  timestamp: number;
}

// Parse Sahm's compact timestamp "yyyyMMddHHmmssSSS" → unix ms
function parseTs(s: string): number {
  // Sahm sends e.g. "20240517000000000" -- yyyyMMddHHmmssSSS
  const y  = +s.slice(0, 4);
  const mo = +s.slice(4, 6) - 1;
  const d  = +s.slice(6, 8);
  const h  = +s.slice(8, 10);
  const mi = +s.slice(10, 12);
  const se = +s.slice(12, 14);
  return Date.UTC(y, mo, d, h, mi, se);
}

function num(s: string | number | undefined | null): number {
  if (s == null) return 0;
  const n = typeof s === 'number' ? s : parseFloat(s);
  return isNaN(n) ? 0 : n;
}

// queryKline response sample (array per bar):
//   [ts, open, close, high, low, volume, prevClose, turnover, sharesOut, ?]
function parseKlineResponse(json: any): SahmKline[] {
  const rows = json?.data?.tradeData;
  if (!Array.isArray(rows)) return [];
  return rows.map((r: any[]) => ({
    timestamp: parseTs(String(r[0])),
    open:      num(r[1]),
    close:     num(r[2]),
    high:      num(r[3]),
    low:       num(r[4]),
    volume:    num(r[5]),
  })).filter(k => k.open > 0 && k.high > 0);
}

// queryBasic response data is an array:
//   [code, name, dataType, time, open, prevClose, high, low, lastPrice, ?, w52H, w52L, ...]
function parseBasicResponse(json: any): SahmPrice | null {
  const d = json?.data;
  if (!Array.isArray(d) || d.length < 9) return null;
  const ticker    = String(d[0]);
  const open      = num(d[4]);
  const prevClose = num(d[5]);
  const high      = num(d[6]);
  const low       = num(d[7]);
  const lastPrice = num(d[8]);
  const volume    = num(d[14]);
  const tsRaw     = String(d[31] ?? d[3] ?? '');
  const timestamp = tsRaw.length >= 14 ? parseTs(tsRaw) : Date.now();

  if (!lastPrice) return null;
  return { ticker, lastPrice, prevClose, open, high, low, volume, timestamp };
}

// queryPreAfterSimple is a labeled JSON object — much simpler.
function parsePreAfter(json: any, ticker: string): SahmPrice | null {
  const d = json?.data;
  if (!d || typeof d !== 'object') return null;
  const lastPrice = num(d.lastPrice);
  if (!lastPrice) return null;
  return {
    ticker,
    lastPrice,
    prevClose: 0,
    open: 0, high: 0, low: 0, volume: 0,
    timestamp: Date.now(),
  };
}

export interface SahmScraperEvents {
  on(event: 'price', listener: (price: RawChartData) => void): this;
  on(event: 'kline', listener: (ticker: string, bars: Candle[]) => void): this;
  on(event: 'disconnected', listener: (reason: string) => void): this;
}

export class SahmScraper extends EventEmitter implements SahmScraperEvents {
  private ctx:     BrowserContext | null = null;
  private page:    Page | null = null;
  private currentTicker: string | null = null;
  private running = false;

  // Buffers waiting for a kline response after we navigate to a ticker
  private pendingKline: Map<string, (bars: Candle[]) => void> = new Map();

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async connect(headless = false): Promise<void> {
    logInfo(`Launching Chromium (persistent profile: ${USER_DATA_DIR})`);
    this.ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless,
      viewport: { width: 1400, height: 900 },
      args: ['--start-maximized'],
    });

    // Reuse first page or open a new one
    this.page = this.ctx.pages()[0] ?? await this.ctx.newPage();

    // Wire network interceptor BEFORE first navigation
    this.attachNetworkListener();

    this.ctx.on('close', () => this._handleDisconnect('context closed'));
    this.page.on('crash', () => this._handleDisconnect('page crash'));
    this.page.on('close', () => this._handleDisconnect('page closed'));

    this.running = true;
    logInfo('Sahm scraper connected.');
  }

  async disconnect(): Promise<void> {
    this.running = false;
    if (this.ctx) {
      try { await this.ctx.close(); } catch { /* */ }
      this.ctx = null;
      this.page = null;
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Navigate to a ticker's chart page and capture the daily kline response.
   * Resolves with the parsed candles (typically ~500 daily bars).
   */
  async fetchHistory(ticker: string, timeframe = '1d', timeoutMs = 30_000): Promise<Candle[]> {
    if (!this.page) throw new Error('Not connected');
    if (TIMEFRAME_TO_TYPE[timeframe] !== 2) {
      throw new Error(`Sahm scraper currently supports only timeframe=1d, got '${timeframe}'`);
    }

    return new Promise<Candle[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingKline.delete(ticker);
        reject(new Error(`Timeout waiting for kline response for ${ticker}`));
      }, timeoutMs);

      this.pendingKline.set(ticker, (bars) => {
        clearTimeout(timer);
        resolve(bars);
      });

      this.currentTicker = ticker;
      this.page!.goto(`${SAHM_BASE}${ticker}`, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
        .catch(err => {
          this.pendingKline.delete(ticker);
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  /**
   * Keep one ticker active (queryBasic will poll its price every ~3s naturally).
   * Calling again with a different ticker rotates the page.
   */
  async setActiveTicker(ticker: string): Promise<void> {
    if (!this.page) throw new Error('Not connected');
    if (this.currentTicker === ticker) return;
    this.currentTicker = ticker;
    await this.page.goto(`${SAHM_BASE}${ticker}`, { waitUntil: 'domcontentloaded' });
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private attachNetworkListener(): void {
    if (!this.page) return;
    this.page.on('response', async res => {
      const url = res.url();
      if (!/damquoteapi\.sahmcapital\.com/.test(url)) return;

      let json: any;
      try { json = await res.json(); } catch { return; }
      if (!json || json.code !== '10000000') return;

      try {
        if (url.includes('/queryKline')) this._handleKlineResponse(json);
        else if (url.includes('/queryBasic')) this._handlePriceResponse(json, 'basic');
        else if (url.includes('/queryPreAfterSimple')) this._handlePriceResponse(json, 'preAfter');
      } catch (err) {
        logWarn(`Response handler error: ${err instanceof Error ? err.message : err}`);
      }
    });
  }

  private _handleKlineResponse(json: any): void {
    const bars = parseKlineResponse(json);
    if (bars.length === 0) return;

    const ticker = this.currentTicker;
    if (!ticker) return;

    const candles: Candle[] = bars.map(b => ({
      timestamp: b.timestamp,
      open:      b.open,
      high:      b.high,
      low:       b.low,
      close:     b.close,
      volume:    b.volume,
      timeframe: '1d',
    }));

    logInfo(`[${ticker}] Sahm queryKline → ${candles.length} daily bars`);

    // Resolve any pending fetchHistory promise
    const waiter = this.pendingKline.get(ticker);
    if (waiter) {
      this.pendingKline.delete(ticker);
      waiter(candles);
    }

    this.emit('kline', ticker, candles);
  }

  private _handlePriceResponse(json: any, kind: 'basic' | 'preAfter'): void {
    const price = kind === 'basic'
      ? parseBasicResponse(json)
      : parsePreAfter(json, this.currentTicker ?? '');
    if (!price) return;

    const raw: RawChartData = {
      ticker:    price.ticker || this.currentTicker || 'UNKNOWN',
      price:     price.lastPrice,
      open:      price.open  || price.lastPrice,
      high:      price.high  || price.lastPrice,
      low:       price.low   || price.lastPrice,
      close:     price.lastPrice,
      volume:    price.volume,
      timestamp: price.timestamp,
      timeframe: '1d',
    };

    this.emit('price', raw);
  }

  private _handleDisconnect(reason: string): void {
    this.running = false;
    logWarn(`Sahm scraper disconnected: ${reason}`);
    this.emit('disconnected', reason);
  }
}
