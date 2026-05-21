import { Candle } from './types';

/**
 * Fetch historical OHLC bars from Alpaca's market data API.
 * Replaces the Yahoo Finance backfill — same return shape (Candle[]).
 */

const TIMEFRAME_MAP: Record<string, string> = {
  '1m':  '1Min',
  '5m':  '5Min',
  '15m': '15Min',
  '30m': '30Min',
  '1h':  '1Hour',
  '60m': '1Hour',
  '4h':  '4Hour',
  '1d':  '1Day',
};

// Per-timeframe lookback in days. Alpaca lets us go very far back, but
// we only need enough bars to fill maxBars.
function lookbackDays(tf: string): number {
  switch (tf) {
    case '1m':  return 7;
    case '5m':  return 14;
    case '15m': return 30;
    case '30m': return 45;
    case '1h':  case '60m': return 90;
    case '4h':  return 180;
    case '1d':  return 730;
    default:    return 30;
  }
}

export async function fetchHistoryAlpaca(
  client:    any,
  ticker:    string,
  timeframe: string,
  maxBars:   number,
): Promise<Candle[]> {
  const alpTf = TIMEFRAME_MAP[timeframe] ?? '15Min';
  const days  = lookbackDays(timeframe);
  const start = new Date(Date.now() - days * 86_400_000).toISOString();
  const end   = new Date().toISOString();

  const bars: Candle[] = [];

  // getBarsV2 returns an async iterator
  const iter = client.getBarsV2(ticker, {
    start, end,
    timeframe:  alpTf,
    limit:      Math.min(maxBars, 10_000),
    adjustment: 'raw',
    feed:       'iex',
  });

  for await (const b of iter) {
    const open   = num(b.OpenPrice  ?? b.Open  ?? b.o);
    const high   = num(b.HighPrice  ?? b.High  ?? b.h);
    const low    = num(b.LowPrice   ?? b.Low   ?? b.l);
    const close  = num(b.ClosePrice ?? b.Close ?? b.c);
    const volume = num(b.Volume     ?? b.v) || 0;
    const tsRaw  = b.Timestamp ?? b.t;
    if (!open || !close || !tsRaw) continue;

    bars.push({
      timestamp: new Date(tsRaw).getTime(),
      open, high, low, close, volume,
      timeframe,
    });
  }

  return bars.slice(-maxBars);
}

function num(v: any): number {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return isFinite(n) ? n : 0;
}
