/**
 * Per-ticker news feed + keyword-based sentiment scoring.
 *
 * Source: Alpaca News API (https://data.alpaca.markets/v1beta1/news)
 *   - Free with every paper account
 *   - Headlines + summary + per-article symbol tags
 *   - Sourced from Benzinga (institutional-grade)
 *
 * Output:  newsScoreFor(ticker) → number in [-1, +1]
 *          +1   = strongly bullish over last 24h
 *           0   = no clear signal
 *          -1   = strongly bearish
 */

import chalk from 'chalk';
import { logInfo, logWarn } from './logger';

const NEWS_BASE = 'https://data.alpaca.markets/v1beta1/news';
const POLL_MS   = 10 * 60 * 1000;          // refresh every 10 min
const LOOKBACK_HOURS = 24;
const MAX_PER_REQUEST = 50;

const BULLISH_WORDS = [
  'beat', 'beats', 'beating', 'surge', 'surges', 'soar', 'soars', 'rally', 'rallies',
  'jump', 'jumps', 'climb', 'climbs', 'gain', 'gains', 'upgrade', 'upgraded',
  'breakthrough', 'record', 'growth', 'expand', 'expansion', 'profit', 'profitable',
  'dividend', 'buyback', 'acquisition', 'acquires', 'partnership', 'launch',
  'approve', 'approved', 'approval', 'breakthrough', 'strong', 'robust', 'positive',
  'outperform', 'overweight', 'bullish', 'optimistic', 'milestone', 'win', 'won',
  'contract', 'deal', 'orders', 'demand',
];

const BEARISH_WORDS = [
  'miss', 'misses', 'missed', 'plunge', 'plunges', 'drop', 'drops', 'fall', 'falls',
  'decline', 'declines', 'downgrade', 'downgraded', 'lawsuit', 'sued', 'recall',
  'investigation', 'investigated', 'fraud', 'layoff', 'layoffs', 'fire', 'fired',
  'loss', 'losses', 'cut', 'cuts', 'slash', 'slashes', 'warning', 'warned',
  'underperform', 'underweight', 'bearish', 'concern', 'risk', 'weakness',
  'weak', 'disappointing', 'disappoint', 'sell-off', 'selloff', 'crash',
  'bankruptcy', 'default', 'breach', 'hack', 'breach',
];

export interface NewsArticle {
  id:         number;
  headline:   string;
  summary:    string;
  url:        string;
  symbols:    string[];
  created_at: string;
  score:      number;             // -1..+1 per-article sentiment
}

interface CacheEntry {
  articles:   NewsArticle[];
  score:      number;             // aggregate -1..+1 for the ticker
  fetchedAt:  number;
}

export class NewsService {
  private keyId:     string;
  private secret:    string;
  private tickers:   string[];
  private cache       = new Map<string, CacheEntry>();
  private timer:      NodeJS.Timeout | null = null;
  private connected = false;

  constructor(tickers: string[]) {
    this.keyId   = process.env.ALPACA_PAPER_KEY_ID     ?? '';
    this.secret  = process.env.ALPACA_PAPER_SECRET_KEY ?? '';
    this.tickers = tickers.map(t => t.toUpperCase());
  }

  async start(): Promise<void> {
    if (!this.keyId || !this.secret) {
      logWarn('NewsService: no Alpaca keys — skipping news feed.');
      return;
    }
    await this._refresh();
    this.timer = setInterval(() => this._refresh().catch(() => {}), POLL_MS);
    this.connected = true;
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.connected = false;
  }

  /** Score in [-1, +1]. 0 if no news or unsure. */
  scoreFor(ticker: string): number {
    return this.cache.get(ticker)?.score ?? 0;
  }

  /** Plain English description for the scanner log. */
  describeFor(ticker: string): string {
    const c = this.cache.get(ticker);
    if (!c || c.articles.length === 0) return 'no recent news';
    const tag = c.score > 0.2 ? 'bullish' : c.score < -0.2 ? 'bearish' : 'neutral';
    return `${c.articles.length} articles, ${tag} ${c.score >= 0 ? '+' : ''}${c.score.toFixed(2)}`;
  }

  /** Most recent N headlines, sorted newest-first. */
  recentHeadlines(ticker: string, n = 3): NewsArticle[] {
    return (this.cache.get(ticker)?.articles ?? []).slice(0, n);
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private async _refresh(): Promise<void> {
    try {
      const start = new Date(Date.now() - LOOKBACK_HOURS * 3600_000).toISOString();
      const url = `${NEWS_BASE}?symbols=${encodeURIComponent(this.tickers.join(','))}` +
                  `&start=${encodeURIComponent(start)}&limit=${MAX_PER_REQUEST}&sort=desc`;

      const res = await fetch(url, {
        headers: {
          'APCA-API-KEY-ID':     this.keyId,
          'APCA-API-SECRET-KEY': this.secret,
          'Accept':              'application/json',
        },
      });
      if (!res.ok) {
        logWarn(`NewsService: HTTP ${res.status} ${res.statusText}`);
        return;
      }
      const body = await res.json() as { news?: any[] };
      const articles = body.news ?? [];

      // Group articles by ticker, scoring each one
      const grouped = new Map<string, NewsArticle[]>();
      for (const a of articles) {
        const text  = `${a.headline ?? ''} ${a.summary ?? ''}`.toLowerCase();
        const score = scoreText(text);
        const article: NewsArticle = {
          id:         a.id,
          headline:   a.headline ?? '',
          summary:    a.summary  ?? '',
          url:        a.url      ?? '',
          symbols:    Array.isArray(a.symbols) ? a.symbols : [],
          created_at: a.created_at,
          score,
        };
        for (const sym of article.symbols) {
          if (!this.tickers.includes(sym)) continue;
          if (!grouped.has(sym)) grouped.set(sym, []);
          grouped.get(sym)!.push(article);
        }
      }

      // Aggregate per-ticker
      for (const t of this.tickers) {
        const arts = grouped.get(t) ?? [];
        let total = 0;
        // Recent articles weighted higher
        const now = Date.now();
        let weightSum = 0;
        for (const a of arts) {
          const ageH    = (now - new Date(a.created_at).getTime()) / 3600_000;
          const weight  = Math.max(0.2, 1 - ageH / LOOKBACK_HOURS);
          total       += a.score * weight;
          weightSum   += weight;
        }
        const agg = weightSum > 0 ? clamp(total / weightSum, -1, 1) : 0;
        this.cache.set(t, { articles: arts, score: agg, fetchedAt: now });
      }

      const summary = [...this.cache.entries()]
        .filter(([_, v]) => v.articles.length > 0)
        .map(([t, v]) => `${t}:${v.score >= 0 ? '+' : ''}${v.score.toFixed(2)}(${v.articles.length})`)
        .join(' ');
      if (summary) {
        logInfo(`📰 News refreshed — ${summary}`);
      }
    } catch (err) {
      logWarn(`NewsService refresh failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}

function scoreText(text: string): number {
  let bull = 0, bear = 0;
  for (const w of BULLISH_WORDS) if (text.includes(w)) bull++;
  for (const w of BEARISH_WORDS) if (text.includes(w)) bear++;
  if (bull + bear === 0) return 0;
  return (bull - bear) / Math.max(1, bull + bear);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
