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

// Hard caps. Stop must always sit on the correct side of entry, and
// the risk per share is capped so a stale sweep can't blow up sizing.
const MAX_RISK_PCT_OF_PRICE = 0.03;   // 3% — beyond this we tighten
const MIN_STOP_BUFFER_PCT   = 0.001;  // 10 bps minimum gap entry↔stop

export function buildSetup(p: BuildSetupParams): TradingSetup | null {
  // ── 1. Entry zone ─────────────────────────────────────────────────────
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

  // Sanity — must be a valid range
  if (entryLow >= entryHigh) return null;

  const entryIdeal = p.direction === 'long'
    ? entryLow  + (entryHigh - entryLow) * 0.33   // 33% from bottom (buy the dip)
    : entryHigh - (entryHigh - entryLow) * 0.33;  // 33% from top (sell the rip)

  // ── 2. Stop loss — pick the tightest VALID candidate ──────────────────
  // Invariants enforced here:
  //   LONG  → stop strictly BELOW entry, gap ≥ MIN_STOP_BUFFER_PCT
  //   SHORT → stop strictly ABOVE entry, gap ≥ MIN_STOP_BUFFER_PCT
  // We collect every reasonable candidate (sweep wick, OB extreme, zone edge)
  // then keep only those on the correct side, then pick the one CLOSEST
  // to entry (smallest stop = least risk).

  const stopLoss = pickStopLoss(p, entryIdeal, entryLow, entryHigh);
  if (stopLoss === null) return null;

  const riskPerShare = Math.abs(entryIdeal - stopLoss);
  if (riskPerShare <= 0) return null;

  // Final invariant — defensive double-check
  if (p.direction === 'long'  && stopLoss >= entryIdeal) return null;
  if (p.direction === 'short' && stopLoss <= entryIdeal) return null;

  // ── 3. Take Profits — first TP anchored at MIN_RR_RATIO ───────────────
  const sign  = p.direction === 'long' ? 1 : -1;
  const minRR = parseFloat(process.env.MIN_RR_RATIO ?? '2');

  const tp1RR = Math.max(minRR, 1);
  const tp2RR = tp1RR + 1.5;
  const tp3RR = tp1RR + 3;

  const tps: RiskLevel[] = [
    { price: round4(entryIdeal + sign * riskPerShare * tp1RR), label: 'Internal liquidity / prior swing',          rr: tp1RR },
    { price: round4(entryIdeal + sign * riskPerShare * tp2RR), label: 'External liquidity pool / equal highs-lows', rr: tp2RR },
    { price: round4(entryIdeal + sign * riskPerShare * tp3RR), label: 'HTF premium/discount array',                rr: tp3RR },
  ];

  // Verify each TP is on the correct side of entry
  for (const tp of tps) {
    if (p.direction === 'long'  && tp.price <= entryIdeal) return null;
    if (p.direction === 'short' && tp.price >= entryIdeal) return null;
    if (tp.price <= 0) return null;
  }

  // ── 4. Position sizing ────────────────────────────────────────────────
  const targetProfitUsd = parseFloat(process.env.TARGET_PROFIT_USD ?? '50');
  const tp1Distance     = Math.abs(tps[0].price - entryIdeal);
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
      low:   round4(entryLow),
      high:  round4(entryHigh),
      ideal: round4(entryIdeal),
    },
    stopLoss:     round4(stopLoss),
    takeProfits:  tps,
    riskReward:   tps[0].rr,
    marketBias:   p.marketBias,
    structureNote: p.structureNote,
    keyLevels:    p.keyLevels,
    timestamp:    new Date().toISOString(),
    positionSizing,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function pickStopLoss(
  p:          BuildSetupParams,
  entryIdeal: number,
  entryLow:   number,
  entryHigh:  number,
): number | null {
  const minBuffer  = entryIdeal * MIN_STOP_BUFFER_PCT;          // ≥10 bps gap
  const maxRisk    = entryIdeal * MAX_RISK_PCT_OF_PRICE;         // ≤3% risk cap
  const isLong     = p.direction === 'long';

  // Candidate stop levels — only structural extremes, NOT raw sweep prices
  // (sweep can be far away and inflate the stop).
  const candidates: number[] = [];

  if (p.ob) {
    candidates.push(isLong ? p.ob.low * 0.9985 : p.ob.high * 1.0015);
  }
  if (p.fvg) {
    candidates.push(isLong ? p.fvg.bottom * 0.9985 : p.fvg.top * 1.0015);
  }
  // Zone edge as fallback
  candidates.push(isLong ? entryLow * 0.9985 : entryHigh * 1.0015);

  // Sweep wick only if it's close enough to entry to be meaningful
  if (p.sweep) {
    const sweepStop = isLong ? p.sweep.sweptPrice * 0.9985 : p.sweep.sweptPrice * 1.0015;
    const distance  = Math.abs(entryIdeal - sweepStop);
    if (distance <= maxRisk * 2) candidates.push(sweepStop);
  }

  // Keep only candidates on the CORRECT side of entry (with buffer)
  const valid = candidates.filter(s =>
    isLong ? (s < entryIdeal - minBuffer) : (s > entryIdeal + minBuffer)
  );

  // Pick the tightest (closest to entry = smallest risk)
  let chosen: number;
  if (valid.length === 0) {
    // No valid candidate — use a hard 1.5% stop
    chosen = isLong ? entryIdeal * 0.985 : entryIdeal * 1.015;
  } else {
    chosen = isLong
      ? Math.max(...valid)    // highest stop below entry = tightest for long
      : Math.min(...valid);   // lowest stop above entry = tightest for short
  }

  // Cap the stop at MAX_RISK_PCT — never risk more than 3% per trade
  if (isLong && entryIdeal - chosen > maxRisk) chosen = entryIdeal - maxRisk;
  if (!isLong && chosen - entryIdeal > maxRisk) chosen = entryIdeal + maxRisk;

  return chosen;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
