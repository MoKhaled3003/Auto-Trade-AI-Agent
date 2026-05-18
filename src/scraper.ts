import CDP from 'chrome-remote-interface';
import { EventEmitter } from 'events';
import { RawChartData } from './types';
import { logInfo, logWarn, logError } from './logger';

const EXTRACT_SCRIPT = `
(function() {
  try {
    const legendItems = document.querySelectorAll(
      '[class*="legendMainSourceWrapper"] [class*="valueItem"], ' +
      '[class*="pane-legend"] [class*="value"], ' +
      '[class*="valuesAdditionalWrapper"] [class*="valueItem"], ' +
      '[class*="valuesWrapper"] div'
    );
    const texts = Array.from(legendItems).map(function(el) {
      return el.textContent && el.textContent.trim();
    }).filter(Boolean);

    // Strategy A: find the LIVE last-price marker on the price axis inside the chart.
    // TradingView renders this as a small floating label that updates every tick,
    // and it DOES include pre-market / after-hours prices.
    function findLivePrice() {
      // Constrain search to the chart container (skip watchlist/sidebar elements)
      const chartRoot = document.querySelector('.chart-container, .chart-gui-wrapper, [class*="chart-markup-table"]') || document;

      // Most specific selectors first — these target the live tick label
      const selectors = [
        '[class*="priceMarkerCurrent"]',
        '[class*="priceMarker-"][class*="current"]',
        '[class*="price-axis-currentprice"]',
        '[class*="currentPrice"]',
        '[class*="last-price"]',
        '[class*="lastPrice"]',
        '[class*="priceValue"]',
        '[class*="priceWrapper"]',
      ];

      for (const sel of selectors) {
        const els = chartRoot.querySelectorAll(sel);
        for (const el of els) {
          const text = el.textContent && el.textContent.trim();
          if (!text) continue;
          // Skip elements containing non-numeric junk (badges, labels)
          const cleaned = text.replace(/[^0-9.]/g, '');
          const n = parseFloat(cleaned);
          if (!isNaN(n) && n > 0 && n < 100000) {
            return { text, selector: sel };
          }
        }
      }
      return null;
    }

    const liveTick = findLivePrice();
    const priceEl = liveTick ? { textContent: liveTick.text } : null;

    const tickerEl = document.querySelector(
      '[class*="chart-symbol-title"] [class*="main"], ' +
      '[class*="title-"], ' +
      '[data-symbol-name]'
    );
    let ticker = '';
    if (tickerEl) {
      ticker = tickerEl.getAttribute('data-symbol-name') || '';
      if (!ticker && tickerEl.textContent) {
        ticker = tickerEl.textContent.trim().split(':').pop() || '';
      }
    }

    let internalOHLC = null;
    try {
      const keys = Object.keys(window);
      for (let k = 0; k < keys.length; k++) {
        const w = window[keys[k]];
        if (w && typeof w === 'object' && typeof w.chart === 'function') {
          const ch = w.chart();
          if (ch && typeof ch.getSeries === 'function') {
            const series = ch.getSeries();
            if (series && typeof series.data === 'function') {
              const bars = series.data();
              const last = bars && bars[bars.length - 1];
              if (last) {
                internalOHLC = { o: last.open, h: last.high, l: last.low, c: last.close, v: last.volume };
                break;
              }
            }
          }
        }
      }
    } catch(_) {}

    return JSON.stringify({
      legendTexts: texts,
      lastPriceText: (priceEl && priceEl.textContent && priceEl.textContent.trim()) || '',
      ticker: ticker,
      title: document.title,
      url: location.href,
      internalOHLC: internalOHLC,
      ts: Date.now()
    });
  } catch(e) {
    return JSON.stringify({ error: String(e && e.message || e) });
  }
})();
`;

function parseLegendValues(texts: string[]): Partial<{ o: number; h: number; l: number; c: number; v: number }> {
  const result: Record<string, number> = {};
  const map: Record<string, string> = { O: 'o', H: 'h', L: 'l', C: 'c' };

  for (const text of texts) {
    const match = text.match(/^([OHLCV])\s*([\d,]+\.?\d*)/i);
    if (match) {
      const key  = map[match[1].toUpperCase()] ?? 'v';
      const val  = parseFloat(match[2].replace(/,/g, ''));
      if (!isNaN(val)) result[key] = val;
    }
  }

  if (Object.keys(result).length === 0) {
    const nums = texts
      .map(t => parseFloat(t.replace(/[^0-9.]/g, '')))
      .filter(n => !isNaN(n) && n > 0);
    if (nums.length >= 4) {
      [result.o, result.h, result.l, result.c] = nums;
    }
  }

  return result;
}

interface CDPTarget {
  id:     string;
  type:   string;
  title:  string;
  url:    string;
  webSocketDebuggerUrl?: string;
}

async function listTargets(host: string, port: number): Promise<CDPTarget[]> {
  const res = await fetch(`http://${host}:${port}/json/list`);
  return (await res.json()) as CDPTarget[];
}

function pickChartTarget(targets: CDPTarget[]): CDPTarget | null {
  const chart = targets.find(t =>
    t.type === 'page' &&
    t.url.includes('tradingview.com/chart')
  );
  if (chart) return chart;

  const tv = targets.find(t =>
    t.type === 'page' &&
    (t.url.includes('tradingview.com') || t.title.toLowerCase().includes('tradingview'))
  );
  if (tv) return tv;

  return targets.find(t => t.type === 'page' && t.url.startsWith('https://')) ?? null;
}

export class ChartScraper extends EventEmitter {
  private client: CDP.Client | null = null;
  private running = false;
  private interval: NodeJS.Timeout | null = null;
  private retries = 0;
  private readonly maxRetries = 5;
  private readonly host: string;
  private readonly port: number;
  private readonly pollMs: number;
  private targetId: string | null = null;

  constructor(cdpUrl: string, pollMs = 2000) {
    super();
    const u = new URL(cdpUrl);
    this.host   = u.hostname || 'localhost';
    this.port   = parseInt(u.port || '9222', 10);
    this.pollMs = pollMs;
  }

  async connect(): Promise<void> {
    logInfo(`Connecting to TradingView Desktop via CDP at ${this.host}:${this.port} ...`);

    const targets = await listTargets(this.host, this.port);
    logInfo(`Discovered ${targets.length} CDP targets`);

    const chartTarget = pickChartTarget(targets);
    if (!chartTarget) {
      throw new Error('No TradingView chart tab found. Open a chart (e.g. NVDA) in TradingView Desktop.');
    }

    logInfo(`Selected target: "${chartTarget.title}"`);
    logInfo(`  URL: ${chartTarget.url}`);
    logInfo(`  ID:  ${chartTarget.id}`);

    this.targetId = chartTarget.id;

    this.client = await CDP({
      host:   this.host,
      port:   this.port,
      target: chartTarget.id,
    });

    await this.client.Runtime.enable();
    await this.client.Page.enable();

    this.client.on('disconnect', () => this._handleDisconnect('CDP socket closed'));

    this.retries = 0;
    this.running = true;
    logInfo('CDP session established.');
  }

  startPolling(timeframe = '5m'): void {
    if (!this.running || !this.client) throw new Error('Not connected');
    logInfo(`Starting poll loop every ${this.pollMs}ms (timeframe: ${timeframe})`);
    this.interval = setInterval(() => this._poll(timeframe), this.pollMs);
  }

  stopPolling(): void {
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
    this.running = false;
  }

  async disconnect(): Promise<void> {
    this.stopPolling();
    if (this.client) {
      try { await this.client.close(); } catch { /* ignore */ }
      this.client = null;
    }
  }

  private async _poll(timeframe: string): Promise<void> {
    if (!this.client || !this.running) return;

    try {
      const { result } = await this.client.Runtime.evaluate({
        expression:    EXTRACT_SCRIPT,
        returnByValue: true,
        awaitPromise:  false,
      });

      const payload = result.value as string;
      if (!payload) {
        logWarn('Empty payload from page');
        return;
      }

      const data = JSON.parse(payload) as {
        legendTexts:   string[];
        lastPriceText: string;
        ticker:        string;
        title:         string;
        url:           string;
        internalOHLC:  { o: number; h: number; l: number; c: number; v: number } | null;
        ts:            number;
        error?:        string;
      };

      if (data.error) {
        logWarn(`DOM extraction error: ${data.error}`);
        return;
      }

      // Prefer the live DOM price axis tick (includes pre/after-market).
      // Fall back to internal series / legend OHLC only if the DOM read fails.
      const domPrice = parseFloat(data.lastPriceText.replace(/[^0-9.]/g, ''));
      const ohlcSource = data.internalOHLC ?? parseLegendValues(data.legendTexts);
      const lastPrice  = (!isNaN(domPrice) && domPrice > 0)
        ? domPrice
        : (ohlcSource.c || 0);

      if (!lastPrice || !ohlcSource.o) {
        logWarn(`No OHLC parsed yet. legend=[${data.legendTexts.slice(0, 6).join(' | ')}] price="${data.lastPriceText}"`);
        return;
      }

      let ticker = data.ticker;
      if (!ticker) {
        const m = data.url.match(/symbol=([A-Z]+)/i) || data.title.match(/\b([A-Z]{2,5})\b/);
        ticker = m ? m[1] : 'UNKNOWN';
      }

      const chartData: RawChartData = {
        ticker,
        price:    lastPrice,
        open:     ohlcSource.o ?? lastPrice,
        high:     ohlcSource.h ?? lastPrice,
        low:      ohlcSource.l ?? lastPrice,
        close:    ohlcSource.c ?? lastPrice,
        volume:   ohlcSource.v ?? 0,
        timestamp: data.ts,
        timeframe,
      };

      this.retries = 0;
      this.emit('data', chartData);

    } catch (err) {
      logError('Poll error', err);
      this.retries++;
      if (this.retries >= this.maxRetries) {
        logError(`Max retries (${this.maxRetries}) reached - attempting reconnect...`);
        await this._reconnect();
      }
    }
  }

  private async _handleDisconnect(reason: string): Promise<void> {
    logWarn(`Disconnected: ${reason}`);
    this.emit('disconnected', reason);
    await this._reconnect();
  }

  private async _reconnect(): Promise<void> {
    this.stopPolling();
    if (this.client) { try { await this.client.close(); } catch { /* */ } this.client = null; }
    const delay = Math.min(1000 * 2 ** this.retries, 30_000);
    logInfo(`Reconnecting in ${delay}ms...`);
    await new Promise(r => setTimeout(r, delay));
    try {
      await this.connect();
      this.startPolling();
      this.emit('reconnected');
    } catch (err) {
      logError('Reconnect failed', err);
      this.retries++;
      if (this.retries < this.maxRetries * 2) await this._reconnect();
    }
  }
}
