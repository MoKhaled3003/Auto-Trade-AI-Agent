# SMC Trading Agent

Node.js/TypeScript agent that attaches to the **TradingView Desktop** app via Chrome DevTools Protocol (CDP) on port `9222`, scrapes live OHLC data from the active chart DOM, and emits SMC/Price-Action trading setups (BOS/MSS, Order Blocks, FVGs, Liquidity Sweeps) with risk-managed entry/SL/TP levels.

## Setup

```bash
npm install
npx playwright install chromium
```

## Run TradingView with remote debugging

```powershell
& "C:\Program Files\WindowsApps\TradingView.Desktop_3.1.0.7818_x64__n534cwy3pjxzj\TradingView.exe" --remote-debugging-port=9222
```

Open a chart for NVDA, MU, or INTC.

## Start the agent

```bash
npm run dev      # ts-node, hot dev
# or
npm run build && npm start
```

## Config (`.env`)

| Variable | Default | Description |
|---|---|---|
| `CDP_URL` | `http://localhost:9222` | CDP endpoint of TradingView |
| `TICKERS` | `NVDA,MU,INTC` | Comma-separated watchlist |
| `POLL_INTERVAL_MS` | `2000` | DOM poll frequency |
| `CANDLE_BUFFER_SIZE` | `200` | Rolling candle window |
| `TIMEFRAME` | `5m` | Chart timeframe label |
| `MIN_CONFIDENCE` | `55` | Min confluence score to emit a setup |
| `MIN_RR_RATIO` | `2.0` | Reject setups below this R:R |

## Files

- `src/index.ts` - orchestrator
- `src/scraper.ts` - CDP attachment + DOM polling
- `src/smc-engine.ts` - BOS/MSS, OB, FVG, Liquidity Sweep
- `src/risk-manager.ts` - SL/TP / R:R calculator
- `src/logger.ts` - formatted console + winston file output
- `src/types.ts` - shared interfaces

Logs are written to `./logs/setups.log` and `./logs/error.log`.
