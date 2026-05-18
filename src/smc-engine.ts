import {
  Candle, SwingPoint, OrderBlock, FairValueGap,
  LiquiditySweep, StructureBreak, MarketStructure,
} from './types';

function uuid(): string {
  return Math.random().toString(36).slice(2, 10);
}

// Swing detection (pivot-point method, strength = N candles each side)

export function detectSwings(candles: Candle[], strength = 3): SwingPoint[] {
  const swings: SwingPoint[] = [];
  const end = candles.length - strength;

  for (let i = strength; i < end; i++) {
    const c = candles[i];

    const isHigh = candles.slice(i - strength, i).every(x => x.high <= c.high) &&
                   candles.slice(i + 1, i + strength + 1).every(x => x.high <= c.high);

    const isLow  = candles.slice(i - strength, i).every(x => x.low >= c.low) &&
                   candles.slice(i + 1, i + strength + 1).every(x => x.low >= c.low);

    if (isHigh) swings.push({ index: i, price: c.high, type: 'high',
                               timestamp: c.timestamp, strength });
    if (isLow)  swings.push({ index: i, price: c.low,  type: 'low',
                               timestamp: c.timestamp, strength });
  }
  return swings;
}

// Market Structure: BOS & MSS

export function analyseStructure(
  candles:  Candle[],
  swings:   SwingPoint[],
): MarketStructure {
  const breaks: StructureBreak[] = [];

  if (swings.length < 4) {
    return { bias: 'ranging', breaks: [], swings };
  }

  for (let i = 2; i < swings.length; i++) {
    const prev = swings[i - 2];
    const curr = swings[i];

    if (curr.type === 'high' && prev.type === 'high' && curr.price > prev.price) {
      breaks.push({
        type: 'BOS', direction: 'bullish', price: curr.price,
        timestamp: curr.timestamp, swingRef: curr,
      });
    }
    if (curr.type === 'low' && prev.type === 'low' && curr.price < prev.price) {
      breaks.push({
        type: 'BOS', direction: 'bearish', price: curr.price,
        timestamp: curr.timestamp, swingRef: curr,
      });
    }
  }

  // MSS = first BOS that opposes the prior trend
  const last4 = breaks.slice(-4);
  let priorTrend: 'bullish' | 'bearish' | null = null;
  if (last4.length >= 2) {
    const byDir = last4.slice(0, -1);
    const majority = byDir.filter(b => b.direction === 'bullish').length > byDir.length / 2
      ? 'bullish' : 'bearish';
    priorTrend = majority;
    const lastBreak = breaks[breaks.length - 1];
    if (lastBreak && lastBreak.direction !== priorTrend) {
      breaks[breaks.length - 1] = { ...lastBreak, type: 'MSS' };
    }
  }

  const recentBreak = breaks.filter(b => b.type === 'BOS').slice(-1)[0];
  const bias: 'bullish' | 'bearish' | 'ranging' = recentBreak?.direction ?? 'ranging';

  return { bias, breaks, swings };
}

// Order Blocks

export function detectOrderBlocks(
  candles: Candle[],
  minImpulsePct = 0.4,
): OrderBlock[] {
  const obs: OrderBlock[] = [];

  for (let i = 1; i < candles.length - 2; i++) {
    const c    = candles[i];
    const next = candles[i + 1];

    const impulse = Math.abs(next.close - next.open) / next.open * 100;

    const isBearCandle    = c.close < c.open;
    const isBullImpulse   = next.close > next.open && impulse >= minImpulsePct;
    const bodyEngulfs     = next.close > c.high;

    if (isBearCandle && isBullImpulse && bodyEngulfs) {
      obs.push({
        id: uuid(), type: 'bullish',
        high: c.high, low: c.low, open: c.open, close: c.close,
        timestamp: c.timestamp, index: i,
        mitigated: false, impulseSize: impulse,
      });
    }

    const isBullCandle    = c.close > c.open;
    const isBearImpulse   = next.close < next.open && impulse >= minImpulsePct;
    const bodyEngulfsDn   = next.close < c.low;

    if (isBullCandle && isBearImpulse && bodyEngulfsDn) {
      obs.push({
        id: uuid(), type: 'bearish',
        high: c.high, low: c.low, open: c.open, close: c.close,
        timestamp: c.timestamp, index: i,
        mitigated: false, impulseSize: impulse,
      });
    }
  }

  const lastPrice = candles[candles.length - 1].close;
  return obs.map(ob => {
    const mitigated = ob.type === 'bullish'
      ? lastPrice < ob.low
      : lastPrice > ob.high;
    return { ...ob, mitigated };
  });
}

// Fair Value Gaps

export function detectFVGs(candles: Candle[], minGapPct = 0.1): FairValueGap[] {
  const fvgs: FairValueGap[] = [];

  for (let i = 2; i < candles.length; i++) {
    const c0 = candles[i - 2];
    const c2 = candles[i];

    if (c2.low > c0.high) {
      const gapSize = (c2.low - c0.high) / c0.high * 100;
      if (gapSize >= minGapPct) {
        fvgs.push({
          id: uuid(), type: 'bullish',
          top: c2.low, bottom: c0.high,
          midpoint: (c2.low + c0.high) / 2,
          timestamp: c2.timestamp,
          candle1: c0.high, candle3: c2.low,
          filled: false,
        });
      }
    }

    if (c2.high < c0.low) {
      const gapSize = (c0.low - c2.high) / c0.low * 100;
      if (gapSize >= minGapPct) {
        fvgs.push({
          id: uuid(), type: 'bearish',
          top: c0.low, bottom: c2.high,
          midpoint: (c0.low + c2.high) / 2,
          timestamp: c2.timestamp,
          candle1: c0.low, candle3: c2.high,
          filled: false,
        });
      }
    }
  }

  const lastClose = candles[candles.length - 1].close;
  return fvgs.map(fvg => {
    const filled = fvg.type === 'bullish'
      ? lastClose <= fvg.bottom
      : lastClose >= fvg.top;
    return { ...fvg, filled };
  });
}

// Liquidity Sweeps

export function detectLiquiditySweeps(
  candles:    Candle[],
  swings:     SwingPoint[],
  rejectPct = 0.05,
): LiquiditySweep[] {
  const sweeps: LiquiditySweep[] = [];
  const swingLows  = swings.filter(s => s.type === 'low');
  const swingHighs = swings.filter(s => s.type === 'high');

  for (let i = 5; i < candles.length; i++) {
    const c = candles[i];

    for (const sl of swingLows) {
      if (sl.index >= i) continue;
      if (c.low < sl.price) {
        const wickRejectPct = (c.close - c.low) / c.close * 100;
        if (c.close > sl.price && wickRejectPct >= rejectPct) {
          sweeps.push({
            type: 'sell_side',
            sweptPrice: sl.price,
            sweepTimestamp: c.timestamp,
            reversed: true,
            reversalCandle: c,
          });
        }
      }
    }

    for (const sh of swingHighs) {
      if (sh.index >= i) continue;
      if (c.high > sh.price) {
        const wickRejectPct = (c.high - c.close) / c.close * 100;
        if (c.close < sh.price && wickRejectPct >= rejectPct) {
          sweeps.push({
            type: 'buy_side',
            sweptPrice: sh.price,
            sweepTimestamp: c.timestamp,
            reversed: true,
            reversalCandle: c,
          });
        }
      }
    }
  }

  return sweeps;
}

// Volume / momentum check: was the latest candle accompanied by elevated volume
// and a directional close? Day-trading confluence demands this — without volume,
// a "sweep" is just a fake-out.
export function hasMomentumWithVolume(
  candles:  Candle[],
  direction: 'long' | 'short',
  lookback = 20,
): { ok: boolean; volumeRatio: number; reason: string } {
  if (candles.length < lookback + 1) return { ok: false, volumeRatio: 0, reason: 'insufficient bars' };
  const recent = candles.slice(-lookback - 1, -1);
  const last   = candles[candles.length - 1];
  const avgVol = recent.reduce((s, c) => s + (c.volume || 0), 0) / recent.length;
  const ratio  = avgVol > 0 ? (last.volume || 0) / avgVol : 0;

  const isBull = last.close > last.open;
  const isBear = last.close < last.open;
  const directional = (direction === 'long' && isBull) || (direction === 'short' && isBear);

  const ok = ratio >= 1.5 && directional;
  return {
    ok,
    volumeRatio: ratio,
    reason: ok
      ? `Volume spike ${ratio.toFixed(1)}× avg + directional close`
      : (directional ? `Volume only ${ratio.toFixed(1)}× avg (need ≥1.5×)` : 'Last candle not directional'),
  };
}

// Confluence scorer

export interface ConfluenceResult {
  score:    number;
  reasons:  string[];
}

export function scoreConfluence(
  currentPrice: number,
  ob:           OrderBlock | null,
  fvg:          FairValueGap | null,
  sweep:        LiquiditySweep | null,
  structure:    MarketStructure,
  direction:    'long' | 'short',
): ConfluenceResult {
  let score = 0;
  const reasons: string[] = [];

  const bias = structure.bias;
  const lastBreak = structure.breaks[structure.breaks.length - 1];

  if ((direction === 'long' && bias === 'bullish') ||
      (direction === 'short' && bias === 'bearish')) {
    score += 25;
    reasons.push(`Market structure bias: ${bias}`);
  }

  if (lastBreak?.type === 'MSS') {
    score += 25;
    reasons.push(`MSS confirmed at $${lastBreak.price.toFixed(2)}`);
  } else if (lastBreak?.type === 'BOS') {
    score += 12;
    reasons.push(`BOS confirmed at $${lastBreak.price.toFixed(2)}`);
  }

  if (sweep?.reversed) {
    score += 20;
    reasons.push(`Sell-side liquidity swept at $${sweep.sweptPrice.toFixed(2)}`);
  }

  if (ob && !ob.mitigated) {
    const inOB = currentPrice >= ob.low && currentPrice <= ob.high;
    if (inOB) {
      score += 20;
      reasons.push(`Price trading within ${ob.type} OB ($${ob.low.toFixed(2)} - $${ob.high.toFixed(2)})`);
    } else {
      score += 8;
      reasons.push(`Unmitigated ${ob.type} OB nearby`);
    }
  }

  if (fvg && !fvg.filled) {
    const nearFVG = Math.abs(currentPrice - fvg.midpoint) / currentPrice < 0.005;
    if (nearFVG) {
      score += 10;
      reasons.push(`Price at ${fvg.type} FVG midpoint $${fvg.midpoint.toFixed(2)}`);
    } else {
      score += 5;
      reasons.push(`Open ${fvg.type} FVG at $${fvg.bottom.toFixed(2)} - $${fvg.top.toFixed(2)}`);
    }
  }

  return { score: Math.min(score, 100), reasons };
}
