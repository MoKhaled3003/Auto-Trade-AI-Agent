/**
 * US equity session rules in NY time.
 *
 *   Pre-market:    04:00 – 09:30 ET   (tradable, ext-hours flag required)
 *   RTH:           09:30 – 16:00 ET   (tradable, bracket orders allowed)
 *   Post-market:   16:00 – 20:00 ET   (tradable, ext-hours flag required)
 *   Overnight:     20:00 – 04:00 ET   (closed)
 *
 * Within RTH we still skip:
 *   first 30 min (open volatility)
 *   lunch 11:30-13:00 ET (low volume)
 *   last 30 min — no new entries (use existing positions to ride close)
 */

const TZ = 'America/New_York';

export function nyTimeOfDayMinutes(date = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const h = parseInt(parts.find(p => p.type === 'hour')!.value, 10);
  const m = parseInt(parts.find(p => p.type === 'minute')!.value, 10);
  return (h % 24) * 60 + m;
}

export function nyWeekday(date = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, weekday: 'short',
  }).formatToParts(date);
  const day = parts.find(p => p.type === 'weekday')!.value;
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(day);
}

const PRE_OPEN_MIN    =  4 * 60;          // 04:00 ET
const RTH_OPEN_MIN    =  9 * 60 + 30;     // 09:30 ET
const RTH_CLOSE_MIN   = 16 * 60;          // 16:00 ET
const POST_CLOSE_MIN  = 20 * 60;          // 20:00 ET
const RTH_SKIP_OPEN   = 10 * 60;          // skip first 30m of RTH
const RTH_SKIP_CLOSE  = 15 * 60 + 30;     // no new entries last 30m of RTH
const RTH_FORCE_FLAT  = 15 * 60 + 50;     // close RTH-bracket positions by 15:50
const LUNCH_START     = 11 * 60 + 30;
const LUNCH_END       = 13 * 60;

export type SessionKind = 'pre' | 'rth' | 'rth-prime' | 'post' | 'closed';

export interface SessionState {
  kind:              SessionKind;
  canEnterNewTrade:  boolean;
  shouldForceFlat:   boolean;
  marketOpen:        boolean;
  extendedHours:     boolean;   // requires extended_hours flag on Alpaca orders
  reason:            string;
}

export function getSessionState(date = new Date()): SessionState {
  const wd  = nyWeekday(date);
  const min = nyTimeOfDayMinutes(date);

  if (wd === 0 || wd === 6) {
    return { kind: 'closed', canEnterNewTrade: false, shouldForceFlat: false,
             marketOpen: false, extendedHours: false, reason: 'Weekend' };
  }

  // Pre-market
  if (min >= PRE_OPEN_MIN && min < RTH_OPEN_MIN) {
    return { kind: 'pre', canEnterNewTrade: true, shouldForceFlat: false,
             marketOpen: true, extendedHours: true, reason: 'Pre-market (limit orders only)' };
  }

  // RTH
  if (min >= RTH_OPEN_MIN && min < RTH_CLOSE_MIN) {
    if (min >= RTH_FORCE_FLAT) {
      return { kind: 'rth', canEnterNewTrade: false, shouldForceFlat: true,
               marketOpen: true, extendedHours: false, reason: 'EOD force-flat window' };
    }
    if (min < RTH_SKIP_OPEN) {
      return { kind: 'rth', canEnterNewTrade: false, shouldForceFlat: false,
               marketOpen: true, extendedHours: false, reason: 'First 30m of RTH (volatility)' };
    }
    if (min >= RTH_SKIP_CLOSE) {
      return { kind: 'rth', canEnterNewTrade: false, shouldForceFlat: false,
               marketOpen: true, extendedHours: false, reason: 'Last 30m of RTH — no new entries' };
    }
    if (min >= LUNCH_START && min < LUNCH_END) {
      return { kind: 'rth', canEnterNewTrade: false, shouldForceFlat: false,
               marketOpen: true, extendedHours: false, reason: 'Lunch chop (11:30-13:00 ET)' };
    }
    return { kind: 'rth-prime', canEnterNewTrade: true, shouldForceFlat: false,
             marketOpen: true, extendedHours: false, reason: 'Prime RTH window' };
  }

  // Post-market
  if (min >= RTH_CLOSE_MIN && min < POST_CLOSE_MIN) {
    return { kind: 'post', canEnterNewTrade: true, shouldForceFlat: false,
             marketOpen: true, extendedHours: true, reason: 'Post-market (limit orders only)' };
  }

  return { kind: 'closed', canEnterNewTrade: false, shouldForceFlat: false,
           marketOpen: false, extendedHours: false, reason: 'Overnight (closed)' };
}
