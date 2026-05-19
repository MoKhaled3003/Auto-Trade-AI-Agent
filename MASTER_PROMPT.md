You are an expert quantitative developer and Smart Money Concepts (SMC) specialist.
Build a Node.js / TypeScript intraday day-trading agent that scrapes TradingView Desktop
via Chrome DevTools Protocol, analyses charts using SMC rules, manages user positions,
and executes paper trades on Alpaca. Below is the complete spec — implement all of it.

═══════════════════════════════════════════════════════════════════════════════
SECTION 1 — ARCHITECTURE
═══════════════════════════════════════════════════════════════════════════════

Project: smc-trading-agent  (Node.js + TypeScript)

Directory layout:
  src/
    index.ts            # orchestrator
    types.ts            # Candle, SwingPoint, OrderBlock, FairValueGap,
                        # LiquiditySweep, TradingSetup, PositionSizing, etc.
    logger.ts           # winston file logger + chalk console helpers
    scraper.ts          # TradingView CDP scraper (live ticks)
    sahm-scraper.ts     # Sahm Capital fallback (Playwright)
    sahm-discover.ts    # one-shot discovery tool for Sahm's API
    market-data.ts      # Yahoo Finance backfill (historical bars)
    smc-engine.ts       # detectSwings, analyseStructure, detectOrderBlocks,
                        # detectFVGs, detectLiquiditySweeps, scoreConfluence,
                        # hasMomentumWithVolume
    risk-manager.ts     # buildSetup() — entry zone, SL, scaled TPs, sizing
    bias.ts             # HTF bias cache (1H structure from Yahoo)
    session-rules.ts    # pre / RTH / post / closed time-of-day logic
    trade-tracker.ts    # WATCHING → ENTERED → CLOSED state machine
    portfolio.ts        # user's manually-held positions from portfolio.json
    alpaca-broker.ts    # Alpaca SDK wrapper (bracket in RTH, limit in ext-hrs)
    test-alpaca.ts      # standalone round-trip smoke test
  portfolio.json        # user's live positions (qty/entry/SL/TP per ticker)
  .env                  # all runtime config
  package.json
  tsconfig.json
  logs/

Dependencies:
  playwright, chrome-remote-interface, @alpacahq/alpaca-trade-api,
  yahoo-finance2, dotenv, chalk, winston

═══════════════════════════════════════════════════════════════════════════════
SECTION 2 — DATA SOURCES
═══════════════════════════════════════════════════════════════════════════════

A. LIVE TICKS — TradingView Desktop via CDP on port 9222
   User launches:
     & "...TradingView.exe" --remote-debugging-port=9222
   Connect with chrome-remote-interface (NOT Playwright's connectOverCDP, which
   hangs on Electron apps). List targets at http://localhost:9222/json/list,
   pick the page whose URL contains "tradingview.com/chart", attach a CDP
   session, then `Runtime.evaluate` a JS extraction script every POLL_INTERVAL_MS.

   The extractor must read the LIVE PRICE AXIS LABEL (which includes pre/post
   market) — NOT TradingView's internal series data which only contains regular
   session bars unless ETH is enabled. Build a fuzzy company-name → ticker
   resolver to map "Intel Corporation" → "INTC", "NVIDIA" → "NVDA", etc.

B. HISTORICAL BACKFILL — Yahoo Finance via yahoo-finance2 v3
   v3 requires an explicit instance: `new YahooFinance()`. Pull 300 × 15m bars
   per ticker on startup. Map "15m"→"15m", "1h"→"60m", "1d"→"1d" with
   per-interval lookback caps.

C. FALLBACK — Sahm Capital (Playwright persistent context)
   Kept for switch-back. Sahm requires HMAC-signed requests, so we drive their
   page in a real browser and intercept queryKline / queryBasic / queryTimeLine
   responses. type=2 returns daily bars.

D. EXECUTION — Alpaca Paper Trading API
   Base URL https://paper-api.alpaca.markets. Toggle `ALPACA_AUTO_TRADE` in .env
   between DRY-RUN (logs intent only) and LIVE (submits actual orders).

═══════════════════════════════════════════════════════════════════════════════
SECTION 3 — SMC ENGINE
═══════════════════════════════════════════════════════════════════════════════

Detection passes (all over the live 15m candle buffer):

  detectSwings(candles, strength=3)
    Pivot-point method: a bar's high/low is a swing if no neighbour within
    ±strength bars exceeds it.

  analyseStructure(candles, swings)
    Walks consecutive same-type swings to find BOS (continuation break)
    and MSS (reversal — the first break that opposes prior trend).
    Returns bias = bullish | bearish | ranging.

  detectOrderBlocks(candles, minImpulsePct=0.4)
    Last bearish candle before a bullish impulse (≥0.4% body), and vice versa.
    Marks mitigated when price has revisited the zone.

  detectFVGs(candles, minGapPct=0.1)
    3-candle imbalance: bull FVG = c[i].low > c[i-2].high. Marks filled.

  detectLiquiditySweeps(candles, swings, rejectPct=0.05)
    Price wicks past a prior swing then closes back through with a meaningful
    rejection wick.

  hasMomentumWithVolume(candles, direction, lookback=20)
    Latest bar's volume ≥ 1.5× the 20-bar average AND close is directional.

  scoreConfluence(currentPrice, ob, fvg, sweep, structure, direction)
    Adds up: trend alignment (25) + MSS (25) or BOS (12) + sweep (20) +
    price-in-OB (20) or near-OB (8) + price-at-FVG-midpoint (10) or near (5).
    Caps at 100.

Day-trading filters in index.ts before scoring:
  - Require recent MSS within the last 20 bars (not stale BOS)
  - Require recent liquidity sweep within the last 20 bars
  - Require momentum + volume on the latest candle
  - HTF (1H) bias must agree with LTF (15m) direction
  - Score must clear MIN_CONFIDENCE (default 70)

═══════════════════════════════════════════════════════════════════════════════
SECTION 4 — RISK MANAGEMENT
═══════════════════════════════════════════════════════════════════════════════

buildSetup() output for each setup:
  entry.low / entry.high       OB or FVG boundaries
  entry.ideal                  33% into the zone (lower for long, upper for short)
  stopLoss                     just past the sweep wick OR past OB extreme
  takeProfits[]                tp1 at MIN_RR_RATIO (default 2.5), tp2 at tp1+1.5,
                               tp3 at tp1+3
  positionSizing
    targetProfitUsd            from TARGET_PROFIT_USD (default 50)
    sharesForTarget            ceil(target / tp1Distance)
    capitalRequired            shares × entryIdeal
    maxLossUsd                 shares × riskPerShare
    profitAtTp1/2/3            shares × (tpPrice − entryIdeal)

═══════════════════════════════════════════════════════════════════════════════
SECTION 5 — TRADE TRACKER (signal-driven trades)
═══════════════════════════════════════════════════════════════════════════════

Per-ticker state machine in trade-tracker.ts:

  WATCHING   — setup registered, waiting for price to enter the zone
               Log: 📋 [WATCHING] ▲ NVDA LONG — waiting for $876.20–$879.50
               Submit Alpaca order immediately (bracket in RTH, limit in ext-hrs)

  ENTERED    — price hit zone
               Log: 🟢 [BUY ENTRY] Bought 12 shares of NVDA at $876.63
                    | Stop Loss: $874.97 | Target: $880.95

  CLOSED     — SL or TP hit (or EOD force-flat)
               Log: 🔴 [EXIT/SELL] Closed position for NVDA at $880.95
                    | Result: +$51.84 (TARGET HIT)
               Also: broker.closePosition() to flatten Alpaca side

Rules:
  - One position per ticker at a time
  - MAX_TRADES_PER_DAY (default 5)
  - MAX_CONCURRENT (default 2)
  - Anti-spam debounce on setupKey (ticker_direction_zone)
  - Daily P&L tracked, EOD summary printed on shutdown

═══════════════════════════════════════════════════════════════════════════════
SECTION 6 — PORTFOLIO MANAGER (user's manual positions)
═══════════════════════════════════════════════════════════════════════════════

portfolio.json:
  {
    "positions": [
      { "ticker": "INTC", "direction": "long", "qty": 17,
        "averageEntryPrice": 124.84, "stopLoss": 100.00,
        "takeProfit1": 135.00, "takeProfit2": 145.00 }
    ]
  }

PortfolioManager.onPrice(ticker, price, ltfBias?):
  1. Stop-loss breach → 🚨 EMERGENCY EXIT (log realized loss, mark CLOSED)
  2. TP1 hit → 🎯 TAKE PROFIT 1 (log profit, auto-move stop to breakeven)
  3. TP2 hit → 🎯 TAKE PROFIT 2 — FULL EXIT
  4. 1R reached without TP1 → 🔒 [BREAKEVEN] (stop → entry)
  5. Otherwise → throttled hold-status (1 per 2 min):
       MU | Hold | Current: $132.50 | Entry: $130.00 | P&L: +$7.50 (+1.92%) | LTF bullish

Auto-persists state changes back to portfolio.json.

═══════════════════════════════════════════════════════════════════════════════
SECTION 7 — ALPACA BROKER
═══════════════════════════════════════════════════════════════════════════════

On startup, log paper account: status, cash, buying_power, equity, mode tag.

submitBracketOrder(req) — session-aware:
  RTH:           bracket order (market entry + take_profit + stop_loss legs)
  pre/post:      plain limit order with extended_hours: true
                 (bracket not allowed outside RTH; tracker manages exits)

closePosition(ticker, currentPrice?):
  RTH:           client.closePosition(ticker) — market liquidation
  pre/post:      look up the position, submit aggressive limit on the opposite
                 side with extended_hours: true

Error handling — distinguish:
  401/403 → 🔑 check your API keys
  422    → ⚠️ rejected (market closed / PDT rule / buying power)
  429    → ⏱️ rate limited
  5xx    → ☁️ Alpaca server hiccup

═══════════════════════════════════════════════════════════════════════════════
SECTION 8 — SESSION RULES (US/Eastern)
═══════════════════════════════════════════════════════════════════════════════

Pre-market    04:00 – 09:30   TRADABLE (ext-hours flag, limit orders)
RTH open vol  09:30 – 10:00   NO new entries (volatility)
RTH-prime AM  10:00 – 11:30   TRADABLE (brackets)
Lunch         11:30 – 13:00   NO new entries
RTH-prime PM  13:00 – 15:30   TRADABLE (brackets)
RTH close     15:30 – 16:00   NO new entries
Force-flat    15:50           Close all RTH positions
Post-market   16:00 – 20:00   TRADABLE (ext-hours flag, limit orders)
Overnight     20:00 – 04:00   CLOSED

Weekends: silent.

═══════════════════════════════════════════════════════════════════════════════
SECTION 9 — .env (RUNTIME CONFIG)
═══════════════════════════════════════════════════════════════════════════════

CDP_URL=http://localhost:9222
TICKERS=NVDA,MU,INTC,AMD,TSM,AVGO,QQQ,SNDK,NOW,CAI
POLL_INTERVAL_MS=3000
CANDLE_BUFFER_SIZE=300
TIMEFRAME=15m
MIN_CONFIDENCE=70
MIN_RR_RATIO=2.5
TARGET_PROFIT_USD=50
MAX_TRADES_PER_DAY=5
MAX_CONCURRENT=2
LOG_DIR=./logs

ALPACA_PAPER_KEY_ID=<paper-key>
ALPACA_PAPER_SECRET_KEY=<paper-secret>
ALPACA_AUTO_TRADE=false        # true = real orders, false = dry-run

═══════════════════════════════════════════════════════════════════════════════
SECTION 10 — CONSOLE OUTPUT CONTRACT (BEGINNER-FRIENDLY)
═══════════════════════════════════════════════════════════════════════════════

NO repetitive per-tick status spam. Only emit:

  📂 Portfolio loaded: N positions  (startup)
  🦙 ALPACA PAPER ACCOUNT           (startup, balance summary)
  📋 [WATCHING]   when a setup registers
  🟢 [BUY ENTRY] / [SHORT ENTRY]    when price enters the zone
  🔴 [EXIT/SELL]                    when SL/TP hits, with realized P&L
  🎯 TAKE PROFIT / 🚨 EMERGENCY EXIT  for portfolio positions
  🔒 [BREAKEVEN]                    when stop trails to entry
  ❤️  Heartbeat                     every 5 min (terse stats line)
  💤 / ⏸                            outside-window status
  📊 END-OF-DAY SUMMARY             on shutdown

All numbers must have $ sign and 2 decimals. P&L in green when positive,
red when negative. No emojis other than the ones above.

═══════════════════════════════════════════════════════════════════════════════
SECTION 11 — STRATEGIC EDGE (FOR THE USER)
═══════════════════════════════════════════════════════════════════════════════

The agent's expectancy formula:
  EV = (win_rate × avg_win_R) − (loss_rate × avg_loss_R)

With strict filtering (HTF aligned + MSS + sweep + volume + 70%+ confluence),
expect ~50% win rate. With MIN_RR_RATIO=2.5 and 1R stops:
  EV = (0.50 × 2.5) − (0.50 × 1.0) = +0.75R per trade
At TARGET_PROFIT_USD=50 → +$37.50 expected per trade.

This edge only holds if the user:
  1. Takes every signal mechanically (no cherry-picking)
  2. Never widens stops or chases exits
  3. Survives drawdowns (variance can run 6 losses in a row)
  4. Lets the sample build to ≥100 trades before judging the system

═══════════════════════════════════════════════════════════════════════════════
SECTION 12 — DELIVERABLES
═══════════════════════════════════════════════════════════════════════════════

  1. package.json with `npm run dev` (ts-node) and `npm run build` (tsc)
  2. tsconfig.json: strict, ES2022 target, commonjs module
  3. Full implementations of every file in Section 1
  4. .env.example with all variables documented
  5. .gitignore: node_modules, dist, logs, .env, portfolio.json, browser-data
  6. README.md with: install → configure → launch TradingView with
     --remote-debugging-port=9222 → npm run dev
  7. test-alpaca.ts that does a single round-trip BUY+SELL of 1 share
     handling both RTH (market orders) and ext-hours (limit+ext_hours flag)

Build all of this. Use modern async/await throughout. Graceful shutdown via
SIGINT closing all open Alpaca positions if AUTO_TRADE is on. Log every
non-trivial event to ./logs/setups.log as JSON for post-trade review.
