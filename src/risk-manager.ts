import { OrderBlock, FairValueGap, LiquiditySweep, RiskLevel, TradingSetup, PositionSizing } from './types';

interface BuildSetupParams {
  ticker:       string;
  timeframe:    string;
  direction:    'long' | 'short';
  currentPrice: number;
  ob:           OrderBlock | null;
  fvg:          FairValueGap | null;
  sweep:        LiquiditySweep | null;
  setupType:    string;
  confidence:   number;
  marketBias:   string;
  structureNote: string;
  keyLevels:    string[];
}

export function buildSetup(p: BuildSetupParams): TradingSetup | null {
  // Entry zone
  let entryLow:  number;
  let entryHigh: number;

  if (p.ob && !p.ob.mitigated) {
    entryLow  = p.ob.low;
    entryHigh = p.ob.high;
  } else if (p.fvg && !p.fvg.filled) {
    entryLow  = p.fvg.bottom;
    entryHigh = p.fvg.top;
  } else {
    entryLow  = p.currentPrice * 0.9995;
    entryHigh = p.currentPrice * 1.0005;
  }

  const entryIdeal = p.direction === 'long'
    ? entryLow  + (entryHigh - entryLow) * 0.33
    : entryHigh - (entryHigh - entryLow) * 0.33;

  // Stop Loss
  let stopLoss: number;

  if (p.direction === 'long') {
    if (p.sweep) {
      stopLoss = p.sweep.sweptPrice * 0.9985;
    } else if (p.ob) {
      stopLoss = p.ob.low * 0.9985;
    } else {
      stopLoss = entryLow  * 0.9985;
    }
  } else {
    if (p.sweep) {
      stopLoss = p.sweep.sweptPrice * 1.0015;
    } else if (p.ob) {
      stopLoss = p.ob.high * 1.0015;
    } else {
      stopLoss = entryHigh * 1.0015;
    }
  }

  const riskPerShare = Math.abs(entryIdeal - stopLoss);
  if (riskPerShare <= 0) return null;

  // Take Profits — first TP anchored at MIN_RR_RATIO, others scale up
  const sign  = p.direction === 'long' ? 1 : -1;
  const minRR = parseFloat(process.env.MIN_RR_RATIO ?? '2');

  const tp1RR = Math.max(minRR, 2);
  const tp2RR = tp1RR + 1.5;
  const tp3RR = tp1RR + 3;

  const tps: RiskLevel[] = [
    {
      price: entryIdeal + sign * riskPerShare * tp1RR,
      label: 'Internal liquidity / prior swing',
      rr:    tp1RR,
    },
    {
      price: entryIdeal + sign * riskPerShare * tp2RR,
      label: 'External liquidity pool / equal highs-lows',
      rr:    tp2RR,
    },
    {
      price: entryIdeal + sign * riskPerShare * tp3RR,
      label: 'HTF premium/discount array',
      rr:    tp3RR,
    },
  ];

  // ── Position sizing for user's per-trade profit target ────────────────────
  const targetProfitUsd = parseFloat(process.env.TARGET_PROFIT_USD ?? '50');
  const tp1Distance     = Math.abs(tps[0].price - entryIdeal);

  // Always round UP — half a share doesn't exist, and we want to MEET the target
  const sharesForTarget = tp1Distance > 0
    ? Math.max(1, Math.ceil(targetProfitUsd / tp1Distance))
    : 1;

  const positionSizing: PositionSizing = {
    targetProfitUsd,
    sharesForTarget,
    capitalRequired:  sharesForTarget * entryIdeal,
    maxLossUsd:       sharesForTarget * riskPerShare,
    profitAtTp1:      sharesForTarget * Math.abs(tps[0].price - entryIdeal),
    profitAtTp2:      sharesForTarget * Math.abs(tps[1].price - entryIdeal),
    profitAtTp3:      sharesForTarget * Math.abs(tps[2].price - entryIdeal),
  };

  return {
    id:           Math.random().toString(36).slice(2, 10),
    ticker:       p.ticker,
    timeframe:    p.timeframe,
    direction:    p.direction,
    setupType:    p.setupType,
    confidence:   p.confidence,
    entry: {
      low:   entryLow,
      high:  entryHigh,
      ideal: entryIdeal,
    },
    stopLoss,
    takeProfits:  tps,
    riskReward:   tps[0].rr,
    marketBias:   p.marketBias,
    structureNote: p.structureNote,
    keyLevels:    p.keyLevels,
    timestamp:    new Date().toISOString(),
    positionSizing,
  };
}
