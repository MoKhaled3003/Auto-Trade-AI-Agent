/**
 * Per-ticker fundamentals snapshot + earnings calendar.
 *
 * Source: yahoo-finance2 (quoteSummary endpoint, free).
 * Refresh: once at startup, then once every 12 hours.
 *
 * Key uses by the SMC engine:
 *   - isNearEarnings(ticker, hoursBefore, hoursAfter) → block trades around earnings
 *   - getFundamentals(ticker) → P/E, EPS, market cap, analyst price target
 */

import YahooFinanceCtor from 'yahoo-finance2';
import { logInfo, logWarn } from './logger';

// v3 of yahoo-finance2 requires an explicit instance
const yahooFinance: any = new (YahooFinanceCtor as any)();
try { yahooFinance.suppressNotices?.(['yahooSurvey']); } catch { /* */ }

const REFRESH_MS = 12 * 3600 * 1000;
const REQUIRED_MODULES = [
  'summaryDetail',
  'defaultKeyStatistics',
  'calendarEvents',
  'financialData',
  'price',
];

export interface Fundamentals {
  ticker:           string;
  marketCap?:       number;
  trailingPE?:      number;
  forwardPE?:       number;
  trailingEps?:     number;
  priceToBook?:     number;
  analystTargetMean?:    number;
  analystRecommendation?: string;     // 'buy', 'hold', 'sell', etc.
  sector?:          string;
  shortPercentOfFloat?: number;
  nextEarningsDate?: number;          // unix ms
  fetchedAt:        number;
}

export class FundamentalsService {
  private tickers: string[];
  private cache    = new Map<string, Fundamentals>();
  private timer:   NodeJS.Timeout | null = null;

  constructor(tickers: string[]) {
    this.tickers = tickers.map(t => t.toUpperCase());
  }

  async start(): Promise<void> {
    await this._refreshAll();
    this.timer = setInterval(() => this._refreshAll().catch(() => {}), REFRESH_MS);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  get(ticker: string): Fundamentals | undefined {
    return this.cache.get(ticker);
  }

  /**
   * True if `ticker` has earnings within [hoursBefore] in the future
   * OR earnings happened within [hoursAfter] in the past. The most
   * volatile and stop-out-prone window for any stock.
   */
  isNearEarnings(ticker: string, hoursBefore = 4, hoursAfter = 1): boolean {
    const f = this.cache.get(ticker);
    if (!f?.nextEarningsDate) return false;
    const now    = Date.now();
    const delta  = f.nextEarningsDate - now;   // positive = upcoming, negative = past
    const upBefore = hoursBefore * 3600_000;
    const upAfter  = hoursAfter  * 3600_000;
    return delta >= -upAfter && delta <= upBefore;
  }

  describeFor(ticker: string): string {
    const f = this.cache.get(ticker);
    if (!f) return 'no fundamentals';
    const parts: string[] = [];
    if (f.trailingPE)        parts.push(`P/E ${f.trailingPE.toFixed(1)}`);
    if (f.analystTargetMean) parts.push(`tgt $${f.analystTargetMean.toFixed(0)}`);
    if (f.analystRecommendation) parts.push(`rec ${f.analystRecommendation}`);
    if (f.nextEarningsDate) {
      const days = (f.nextEarningsDate - Date.now()) / 86400_000;
      if (days >= 0 && days <= 30) parts.push(`earnings in ${days.toFixed(1)}d`);
    }
    return parts.join(' | ') || 'no data';
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private async _refreshAll(): Promise<void> {
    logInfo(`📑 Fundamentals refreshing for ${this.tickers.length} tickers...`);
    let ok = 0, fail = 0;
    for (const t of this.tickers) {
      try {
        const result: any = await yahooFinance.quoteSummary(t, { modules: REQUIRED_MODULES });
        const f = parseFundamentals(t, result);
        this.cache.set(t, f);
        ok++;
      } catch (err) {
        fail++;
        // Don't spam — Yahoo rate-limits occasionally
        logWarn(`Fundamentals fetch failed for ${t}: ${err instanceof Error ? err.message : err}`);
      }
    }
    logInfo(`📑 Fundamentals: ${ok} ok, ${fail} failed`);
  }
}

function parseFundamentals(ticker: string, result: any): Fundamentals {
  const sd   = result?.summaryDetail        ?? {};
  const dks  = result?.defaultKeyStatistics ?? {};
  const ce   = result?.calendarEvents       ?? {};
  const fd   = result?.financialData        ?? {};
  const pr   = result?.price                ?? {};

  let nextEarningsDate: number | undefined;
  const ed = ce?.earnings?.earningsDate;
  if (Array.isArray(ed) && ed.length > 0) {
    const first = ed[0];
    const ts    = first instanceof Date ? first.getTime() :
                  typeof first === 'number' ? first * 1000 :
                  typeof first === 'string' ? new Date(first).getTime() : NaN;
    if (isFinite(ts)) nextEarningsDate = ts;
  }

  return {
    ticker,
    marketCap:             pr.marketCap        ?? sd.marketCap,
    trailingPE:            sd.trailingPE       ?? dks.trailingPE,
    forwardPE:             sd.forwardPE        ?? dks.forwardPE,
    trailingEps:           dks.trailingEps,
    priceToBook:           dks.priceToBook,
    analystTargetMean:     fd.targetMeanPrice,
    analystRecommendation: fd.recommendationKey,
    sector:                pr.sector,
    shortPercentOfFloat:   dks.shortPercentOfFloat,
    nextEarningsDate,
    fetchedAt:             Date.now(),
  };
}
