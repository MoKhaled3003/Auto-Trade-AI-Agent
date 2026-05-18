import YahooFinanceCtor from 'yahoo-finance2';
import { Candle } from './types';

// v3 of yahoo-finance2 requires an explicit instance
const yahooFinance: any = new (YahooFinanceCtor as any)();

try { yahooFinance.suppressNotices?.(['yahooSurvey']); } catch { /* ignore */ }

type YahooInterval =
  | '1m' | '2m' | '5m' | '15m' | '30m' | '60m' | '90m' | '1h' | '1d';

const INTERVAL_MAP: Record<string, YahooInterval> = {
  '1m':  '1m',
  '2m':  '2m',
  '5m':  '5m',
  '15m': '15m',
  '30m': '30m',
  '1h':  '60m',
  '60m': '60m',
  '1d':  '1d',
};

function lookbackDays(intv: YahooInterval): number {
  switch (intv) {
    case '1m':                       return 5;
    case '2m':  case '5m':           return 30;
    case '15m': case '30m':          return 30;
    case '60m': case '90m': case '1h': return 60;
    case '1d':                       return 365;
    default:                         return 30;
  }
}

interface YahooBar {
  date:   Date | string;
  open?:  number | null;
  high?:  number | null;
  low?:   number | null;
  close?: number | null;
  volume?: number | null;
}

export async function fetchHistory(
  ticker:    string,
  timeframe: string,
  maxBars:   number,
): Promise<Candle[]> {
  const interval = INTERVAL_MAP[timeframe] ?? '15m';
  const days     = lookbackDays(interval);

  const period2 = new Date();
  const period1 = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const result: any = await yahooFinance.chart(ticker, {
    period1, period2, interval,
  });

  const bars: YahooBar[] = (result?.quotes ?? []) as YahooBar[];

  const candles: Candle[] = bars
    .filter(b =>
      b.open  != null && b.high  != null &&
      b.low   != null && b.close != null
    )
    .map(b => ({
      timestamp: new Date(b.date).getTime(),
      open:      b.open  as number,
      high:      b.high  as number,
      low:       b.low   as number,
      close:     b.close as number,
      volume:    (b.volume as number) ?? 0,
      timeframe,
    }));

  return candles.slice(-maxBars);
}
