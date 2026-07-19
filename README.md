# Algo VWAP — CoinDCX Institutional Trading Bot

Production-grade automated cryptocurrency trading system for **CoinDCX**, written in **TypeScript (Node.js 22+)**.

The bot continuously scans **100–200 USDT-M futures pairs**, ranks them with institutional order-flow and volume analysis, and trades **live CoinDCX derivatives** with **custom leverage** on **1m / 3m** timeframes — with hard risk limits, backtesting, and a real-time dashboard.

**Paper trading has been removed.** Execution is live futures only.

---

## Features

| Module | Description |
|--------|-------------|
| **Coin Scanner** | Universe of 100–200 USDT markets, refreshed every 15m (volume, spread, liquidity filters) |
| **VWAP** | Session / Daily / Weekly / Monthly + Anchored (HV, swing H/L, BOS, session start) |
| **Institutional Zones** | Volume ≥ 2.5× SMA, body/wick filters, persistent supply/demand with invalidation |
| **Market Structure** | HH/HL/LH/LL, BOS, CHoCH, internal/external structure, trend strength |
| **Liquidity** | Equal H/L, pools, stop hunts, swing failures, confirmed sweeps |
| **Scoring** | Weighted confidence (min 85) — only trade when all gates pass |
| **Ranking** | Top-10 candidates every scan cycle; execute highest-ranked only |
| **Risk** | 1% risk/trade, 3 consecutive loss halt, 3% daily DD halt, ATR stops/trails |
| **Execution** | CoinDCX **USDT-M futures** REST with custom leverage, SL/TP on entry, partial TP1/TP2, BE + ATR trail |
| **Leverage** | Global default + per-symbol map (`DERIV_LEVERAGE`, `DERIV_LEVERAGE_BY_SYMBOL`) |
| **Alerts** | Telegram + Discord formatted signals |
| **Backtest** | Replay, walk-forward, Monte Carlo, Sharpe/Sortino/CAGR/PF |
| **Dashboard** | Next.js + Tailwind + Recharts live UI |
| **Infra** | Docker Compose (Postgres, Redis, bot, dashboard), Prisma, BullMQ, workers |

---

## Architecture

```
Clean Architecture + Event-driven
─────────────────────────────────
Exchange (CoinDCX REST/WS)  →  CandleStore / Universe
         ↓
   Scanner (batch)  →  Strategy engines (pure, deterministic)
         ↓
   Ranking  →  Risk gate (margin + leverage)  →  Futures portfolio
         ↓
   EventBus  →  Alerts · API/WS · (optional) Prisma · Redis
```

**No look-ahead:** entry decisions use only **closed** candles. Swing points require right-side confirmation bars.

### Project layout

```
src/
  config/           # Zod schema, env + live derivatives JSON
  exchange/         # CoinDCX futures client (leverage, positions, exit)
  websocket/        # Market data WS + REST fallback
  scanner/          # Universe, candle store, multi-coin scan
  strategy/
    vwap/
    institutional/
    volume/
    market-structure/
    liquidity/
    scoring/
    execution/
  indicators/       # ATR, volume, momentum
  risk/             # Sizing, halt rules, stop management
  portfolio/        # Positions, partials, journal
  alerts/           # Telegram / Discord
  backtest/         # Engine, metrics, CLI
  workers/          # worker_threads analysis pool
  database/         # Prisma schema + repositories
  services/         # Orchestrator + HTTP/WS API
  di/               # tsyringe tokens
  events/           # Typed EventBus
  main.ts
apps/dashboard/     # Next.js UI
config/live.json
```

---

## Quick start

### Prerequisites

- Node.js **22+**
- pnpm **9+**
- Docker (optional, for Postgres/Redis/full stack)
- CoinDCX API keys with **Futures** permissions
- USDT in the **derivatives / futures wallet**

### Install

```bash
cp .env.example .env
# Set COINDCX_API_KEY, COINDCX_API_SECRET, DERIV_LEVERAGE
pnpm install
```

### Recommended: Binance Futures Testnet (free demo USDT)

CoinDCX has **no public demo-funded API**. Use Binance testnet to practice safely:

1. Open https://testnet.binancefuture.com → login → **API Management** → create key  
2. Put keys in `.env`:

```env
EXCHANGE=binance_testnet
BINANCE_API_KEY=...
BINANCE_API_SECRET=...
DERIV_LEVERAGE=10
```

3. Run:

```bash
pnpm install
pnpm dev
```

Full guide: [docs/BINANCE_TESTNET.md](docs/BINANCE_TESTNET.md)

### Production: CoinDCX

```env
EXCHANGE=coindcx
COINDCX_API_KEY=...
COINDCX_API_SECRET=...
```

> **Warning:** Live CoinDCX / live Binance = real money. Start with low leverage.

- HTTP API: `http://localhost:3100/api/status`
- Dashboard: `pnpm dashboard` → `http://localhost:3000`

---

## Configuration

| Source | Role |
|--------|------|
| `.env` | Secrets, leverage, ports |
| `config/live.json` | Derivatives defaults (leverage map, risk, strategy) |

### Custom leverage

```env
DERIV_LEVERAGE=10
DERIV_LEVERAGE_BY_SYMBOL={"BTCUSDT":20,"ETHUSDT":15}
DERIV_MARGIN_TYPE=isolated
DERIV_MARGIN_CURRENCY=USDT
ALLOW_SHORT=true
```

Orders call CoinDCX futures `orders/create` with `leverage` and optional `stop_loss_price` / `take_profit_price`. Leverage is also pushed via `positions/update_leverage` before entry and clamped to instrument max when `DERIV_RESPECT_MAX_LEVERAGE=true`.

**Risk sizing (leveraged):**

- Risk $ = equity × `RISK_PER_TRADE_PCT`
- Quantity = risk $ / stop distance  
- Margin ≈ notional / leverage  
- Caps: `MAX_EXPOSURE_PCT` (margin) and `MAX_NOTIONAL_TO_EQUITY`

### Entry gates (all required)

1. Higher-timeframe trend agrees  
2. Price aligned with VWAP  
3. Institutional volume zone + retest  
4. Market structure confirmed  
5. BOS or CHoCH completed  
6. Volume spike / high RVOL  
7. Strong directional candle close  
8. Risk/Reward ≥ configured min (default 1:2)  
9. Confidence score ≥ 85 (live default 90)

### Confidence weights (default)

| Factor | Weight |
|--------|--------|
| VWAP alignment | 20 |
| Institutional zone | 20 |
| Market structure | 15 |
| Volume spike | 15 |
| Liquidity sweep | 10 |
| HTF trend | 10 |
| ATR volatility | 5 |
| Retest quality | 5 |
| Momentum | 5 |

---

## Risk management

- **Risk per trade:** 1% of equity (configurable)  
- **Position size:** `quantity = riskAmount / stopDistance`  
- **Stop:** beyond institutional zone ± ATR buffer  
- **TP1 / TP2 / TP3:** 1R / 2R / next opposite zone  
- **After TP1:** stop → breakeven; partial close ~40%  
- **After TP2:** ATR trailing stop  
- **Halt:** 3 consecutive losses **or** 3% daily drawdown → resume next UTC day  

---

## Backtesting

```bash
# From public CoinDCX candles
pnpm backtest -- --symbol BTCUSDT --tf 1m --limit 1000

# From local JSON array of candles
pnpm backtest -- --symbol BTCUSDT --tf 1m --file ./data/btcusdt-1m.json

# Walk-forward + Monte Carlo
pnpm backtest -- --symbol BTCUSDT --tf 1m --limit 2000 --walkforward true --montecarlo true
```

Metrics: win rate, profit factor, Sharpe, Sortino, max DD, CAGR, average R, monthly returns, equity curve.

Replay is **bar-by-bar** with only past closed candles visible to the signal generator.

---

## Alerts

Set in `.env`:

```env
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
DISCORD_WEBHOOK_URL=...
ALERTS_ENABLED=true
```

Example:

```
🟢 BUY SIGNAL

Pair: BTCUSDT
Timeframe: 1m
Confidence: 91%

Entry: 108240
Stop Loss: 107880
TP1: 108800
TP2: 109350

Reason:
✓ Above VWAP
✓ Institutional Demand Zone
✓ BOS Confirmed
✓ High Relative Volume
✓ Strong Retest
```

---

## Docker

```bash
docker compose up -d postgres redis   # infra only
docker compose up -d --build          # full stack
```

Services:

| Service | Port |
|---------|------|
| Bot API | 3100 |
| Bot WS | 3101 |
| Dashboard | 3000 |
| Postgres | 5432 |
| Redis | 6379 |

```bash
pnpm db:generate
pnpm db:push
```

---

## Testing

```bash
pnpm test
pnpm test:unit
pnpm test:integration
pnpm typecheck
```

---

## Performance targets

| Metric | Target |
|--------|--------|
| Scan cycle (warm candles) | &lt; 2s for 100–200 pairs |
| Trade decision after signal | &lt; 300ms in same cycle |
| WS reconnect | Exponential backoff + REST poll fallback |
| Concurrency | Batch scan + optional `worker_threads` pool |

---

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Liveness |
| GET | `/api/status` | Full bot snapshot |
| GET | `/api/ranked` | Top ranked coins |
| GET | `/api/positions` | Open positions |
| GET | `/api/trades` | Recent closed trades |
| GET | `/api/risk` | Risk state |
| GET | `/api/zones` | Active institutional zones |

WebSocket (`ws://localhost:3101`): `status`, `scan`, `signal`, `position`, `trade`, `ticker`, `risk_halt`.

---

## Security

- API keys **only** via environment variables  
- Never commit `.env`  
- Live mode uses lower risk defaults  
- Futures-only; paper trading removed  

---

## Disclaimer

This software is for educational and research purposes. Cryptocurrency trading involves substantial risk of loss. Past backtest performance does not guarantee future results. You are solely responsible for any live trading decisions and compliance with local regulations and exchange terms.

---

## License

Private / proprietary — all rights reserved.
