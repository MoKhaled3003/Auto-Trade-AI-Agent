import { fetchHistory }                  from './market-data';
import { detectSwings, analyseStructure } from './smc-engine';
import { logInfo, logWarn }               from './logger';

type Bias = 'bullish' | 'bearish' | 'ranging';

interface BiasCacheEntry {
  bias:      Bias;
  timestamp: number;
  source:    string;
}

const cache  = new Map<string, BiasCacheEntry>();
const TTL_MS = 15 * 60 * 1000;

const HTF_TIMEFRAME = '1h';
const HTF_BARS      = 120;

export async function getHTFBias(ticker: string): Promise<Bias> {
  const cached = cache.get(ticker);
  if (cached && Date.now() - cached.timestamp < TTL_MS) {
    return cached.bias;
  }

  try {
    const bars = await fetchHistory(ticker, HTF_TIMEFRAME, HTF_BARS);
    if (bars.length < 20) {
      logWarn(`[${ticker}] HTF bias: insufficient bars (${bars.length})`);
      return 'ranging';
    }

    const swings    = detectSwings(bars, 3);
    const structure = analyseStructure(bars, swings);

    cache.set(ticker, {
      bias: structure.bias,
      timestamp: Date.now(),
      source: `${HTF_TIMEFRAME} structure (${bars.length} bars, ${structure.breaks.length} breaks)`,
    });

    logInfo(`[${ticker}] HTF bias updated: ${structure.bias} ` +
            `(${HTF_TIMEFRAME}, ${structure.breaks.length} breaks)`);

    return structure.bias;
  } catch (err) {
    logWarn(`[${ticker}] HTF bias fetch failed: ${err instanceof Error ? err.message : err}`);
    return 'ranging';
  }
}
