import { EventEmitter } from 'events';
import { RawChartData } from './types';
import { logInfo, logWarn, logError } from './logger';

const DATA_BASE = 'https://data.alpaca.markets/v2/stocks';

/**
 * The Alpaca Node SDK v3 has buggy batch methods (`getLatestTrades` /
 * `getLatestBars` throw with empty error objects). Hit the REST API
 * directly — same response shape, no SDK middleware in the way.
 */
async function alpacaGet(path: string, keyId: string, secretKey: string): Promise<any> {
  const url = `${DATA_BASE}${path}`;
  const res = await fetch(url, {
    headers: {
      'APCA-API-KEY-ID':     keyId,
      'APCA-API-SECRET-KEY': secretKey,
      'Accept':              'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Alpaca ${path} → HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Async Alpaca live data feed.
 *
 * - Batch-polls getLatestBars + getLatestTrades for ALL watchlist tickers in one call.
 * - Emits `data` events with RawChartData (drop-in compatible with the old
 *   TradingView CDP ChartScraper).
 * - No DOM scraping, no tab-following — fully async across the watchlist.
 *
 * Free Alpaca paper account uses the IEX feed (real-time for paper trading,
 * limited venue coverage — but plenty good for SMC analysis on liquid names).
 */
export class AlpacaFeed extends EventEmitter {
  private client: any;          // SDK client (kept for compatibility, not used for polling)
  private keyId: string;
  private secretKey: string;
  private tickers: string[];
  private intervalMs: number;
  private barTimer:   NodeJS.Timeout | null = null;
  private tradeTimer: NodeJS.Timeout | null = null;
  private connected = false;
  private lastBarTs   = new Map<string, number>();   // dedupe bar emits
  private lastTradeTs = new Map<string, number>();   // dedupe trade emits

  constructor(client: any, tickers: string[], barPollMs = 15_000, tradePollMs = 3_000) {
    super();
    this.client      = client;
    this.keyId       = process.env.ALPACA_PAPER_KEY_ID     ?? '';
    this.secretKey   = process.env.ALPACA_PAPER_SECRET_KEY ?? '';
    this.tickers     = tickers.map(t => t.toUpperCase());
    this.intervalMs  = barPollMs;
    this._tradeMs    = tradePollMs;
  }
  private _tradeMs: number;

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    logInfo(`AlpacaFeed connecting — ${this.tickers.length} tickers (bars every ${this.intervalMs}ms, trades every ${this._tradeMs}ms)`);

    // First call is LOUD — surface any auth / shape problems immediately
    const firstTrades = await this._pollTradesLoud();
    const firstBars   = await this._pollBarsLoud();

    if (firstTrades === 0 && firstBars === 0) {
      logError(
        '⚠️  Alpaca data feed returned 0 trades AND 0 bars on first pull. ' +
        'No price data will flow. Run `npx ts-node src/test-alpaca-data.ts` to diagnose.'
      );
    } else {
      logInfo(`AlpacaFeed first pull: ${firstTrades} trades, ${firstBars} bars`);
    }

    this.barTimer   = setInterval(() => { this._pollBars().catch(() => {});   }, this.intervalMs);
    this.tradeTimer = setInterval(() => { this._pollTrades().catch(() => {}); }, this._tradeMs);
    this.connected = true;
  }

  // Loud variants used only at startup to expose silent failures.
  // Same direct-REST path as the regular pollers — but log per-symbol confirmations.
  private async _pollTradesLoud(): Promise<number> {
    try {
      const params = `?symbols=${encodeURIComponent(this.tickers.join(','))}&feed=iex`;
      const resp   = await alpacaGet(`/trades/latest${params}`, this.keyId, this.secretKey);
      const trades = resp?.trades ?? {};
      const entries = Object.entries(trades);
      for (const [sym, t] of entries) {
        const tr = t as any;
        const p = Number(tr.p ?? tr.Price);
        if (!p) continue;
        const tsRaw = tr.t ?? tr.Timestamp;
        const ts    = tsRaw ? new Date(tsRaw).getTime() : Date.now();
        this.lastTradeTs.set(sym, ts);
        this.emit('data', {
          ticker: sym, price: p, open: p, high: p, low: p, close: p,
          volume: Number(tr.s ?? tr.Size) || 0,
          timestamp: ts, timeframe: '1m',
        } as RawChartData);
        logInfo(`  📈 ${sym.padEnd(5)} live tick: $${p.toFixed(2)}`);
      }
      return entries.length;
    } catch (err: any) {
      logError(`⚠️  Alpaca /trades/latest failed at startup: ${err.message}`, err);
      return 0;
    }
  }

  private async _pollBarsLoud(): Promise<number> {
    try {
      const params = `?symbols=${encodeURIComponent(this.tickers.join(','))}&feed=iex`;
      const resp   = await alpacaGet(`/bars/latest${params}`, this.keyId, this.secretKey);
      const bars   = resp?.bars ?? {};
      const entries = Object.entries(bars);
      for (const [sym, b] of entries) {
        const norm = normaliseBar(b);
        if (!norm) continue;
        this.lastBarTs.set(sym, norm.timestamp);
        this.emit('data', {
          ticker: sym, price: norm.close,
          open: norm.open, high: norm.high, low: norm.low, close: norm.close,
          volume: norm.volume, timestamp: norm.timestamp, timeframe: '1m',
        } as RawChartData);
      }
      return entries.length;
    } catch (err: any) {
      logError(`⚠️  Alpaca /bars/latest failed at startup: ${err.message}`, err);
      return 0;
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.barTimer)   { clearInterval(this.barTimer);   this.barTimer = null; }
    if (this.tradeTimer) { clearInterval(this.tradeTimer); this.tradeTimer = null; }
  }

  isConnected(): boolean { return this.connected; }

  // ── Bar polling (1-min bars, drives candle buffer) ─────────────────────────
  // Response shape: { "bars": { "NVDA": {o, h, l, c, v, t}, ... } }

  private async _pollBars(): Promise<void> {
    try {
      const params = `?symbols=${encodeURIComponent(this.tickers.join(','))}&feed=iex`;
      const resp   = await alpacaGet(`/bars/latest${params}`, this.keyId, this.secretKey);
      const bars   = resp?.bars ?? {};
      for (const [symbol, bar] of Object.entries(bars)) {
        const norm = normaliseBar(bar);
        if (!norm) continue;
        const prev = this.lastBarTs.get(symbol) ?? 0;
        if (norm.timestamp <= prev) continue;
        this.lastBarTs.set(symbol, norm.timestamp);

        this.emit('data', {
          ticker:    symbol,
          price:     norm.close,
          open:      norm.open,
          high:      norm.high,
          low:       norm.low,
          close:     norm.close,
          volume:    norm.volume,
          timestamp: norm.timestamp,
          timeframe: '1m',
        } as RawChartData);
      }
    } catch (err) {
      logWarn(`AlpacaFeed bar poll error: ${err instanceof Error ? err.message : err}`);
    }
  }

  // ── Trade polling (live price for portfolio/tracker reactivity) ────────────
  // Response shape: { "trades": { "NVDA": {p, s, t, ...}, ... } }

  private async _pollTrades(): Promise<void> {
    try {
      const params = `?symbols=${encodeURIComponent(this.tickers.join(','))}&feed=iex`;
      const resp   = await alpacaGet(`/trades/latest${params}`, this.keyId, this.secretKey);
      const trades = resp?.trades ?? {};
      for (const [symbol, trade] of Object.entries(trades)) {
        const t = trade as any;
        const price = num(t.p ?? t.Price);
        const tsRaw = t.t ?? t.Timestamp;
        const ts    = tsRaw ? new Date(tsRaw).getTime() : Date.now();
        if (!price) continue;

        const prev = this.lastTradeTs.get(symbol) ?? 0;
        if (ts <= prev) continue;
        this.lastTradeTs.set(symbol, ts);

        this.emit('data', {
          ticker:    symbol,
          price,
          open:      price,
          high:      price,
          low:       price,
          close:     price,
          volume:    num(t.s ?? t.Size) || 0,
          timestamp: ts,
          timeframe: '1m',
        } as RawChartData);
      }
    } catch (err) {
      logWarn(`AlpacaFeed trade poll error: ${err instanceof Error ? err.message : err}`);
    }
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

interface NormBar {
  open: number; high: number; low: number; close: number;
  volume: number; timestamp: number;
}

function normaliseBar(b: any): NormBar | null {
  if (!b) return null;
  const open   = num(b.OpenPrice  ?? b.Open  ?? b.o);
  const high   = num(b.HighPrice  ?? b.High  ?? b.h);
  const low    = num(b.LowPrice   ?? b.Low   ?? b.l);
  const close  = num(b.ClosePrice ?? b.Close ?? b.c);
  const volume = num(b.Volume     ?? b.v) || 0;
  const tsRaw  = b.Timestamp ?? b.t;
  const ts     = tsRaw ? new Date(tsRaw).getTime() : Date.now();
  if (!open || !close) return null;
  return { open, high, low, close, volume, timestamp: ts };
}

function num(v: any): number {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return isFinite(n) ? n : 0;
}
