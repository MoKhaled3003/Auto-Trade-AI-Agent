// Core market data primitives

export interface Candle {
  timestamp:  number;
  open:       number;
  high:       number;
  low:        number;
  close:      number;
  volume:     number;
  timeframe:  string;
}

// SMC structural primitives

export interface SwingPoint {
  index:     number;
  price:     number;
  type:      'high' | 'low';
  timestamp: number;
  strength:  number;
}

export interface OrderBlock {
  id:          string;
  type:        'bullish' | 'bearish';
  high:        number;
  low:         number;
  open:        number;
  close:       number;
  timestamp:   number;
  index:       number;
  mitigated:   boolean;
  impulseSize: number;
}

export interface FairValueGap {
  id:        string;
  type:      'bullish' | 'bearish';
  top:       number;
  bottom:    number;
  midpoint:  number;
  timestamp: number;
  candle1:   number;
  candle3:   number;
  filled:    boolean;
}

export interface LiquiditySweep {
  type:            'buy_side' | 'sell_side';
  sweptPrice:      number;
  sweepTimestamp:  number;
  reversed:        boolean;
  reversalCandle?: Candle;
}

export interface StructureBreak {
  type:      'BOS' | 'MSS';
  direction: 'bullish' | 'bearish';
  price:     number;
  timestamp: number;
  swingRef:  SwingPoint;
}

export interface MarketStructure {
  bias:    'bullish' | 'bearish' | 'ranging';
  breaks:  StructureBreak[];
  swings:  SwingPoint[];
}

// Setup output

export interface RiskLevel {
  price:  number;
  label:  string;
  rr:     number;
}

export interface PositionSizing {
  targetProfitUsd:   number;   // user's per-trade profit target
  sharesForTarget:   number;   // shares needed to hit target at TP1
  capitalRequired:   number;   // ideal entry × shares
  maxLossUsd:        number;   // shares × (entry - stop) — what you risk
  profitAtTp1:       number;
  profitAtTp2:       number;
  profitAtTp3:       number;
}

export interface TradingSetup {
  id:              string;
  ticker:          string;
  timeframe:       string;
  direction:       'long' | 'short';
  setupType:       string;
  confidence:      number;
  entry: {
    low:  number;
    high: number;
    ideal: number;
  };
  stopLoss:        number;
  takeProfits:     RiskLevel[];
  riskReward:      number;
  marketBias:      string;
  structureNote:   string;
  keyLevels:       string[];
  timestamp:       string;
  positionSizing?: PositionSizing;
}

// Scraper output

export interface RawChartData {
  ticker:    string;
  price:     number;
  open:      number;
  high:      number;
  low:       number;
  close:     number;
  volume:    number;
  timestamp: number;
  timeframe: string;
}
