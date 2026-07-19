# Testing with Binance Futures Testnet

CoinDCX does **not** offer a public demo/paper API with funded accounts.  
For safe end-to-end testing of this bot, use **Binance USD-M Futures Testnet** (free virtual USDT).

## Why Binance Testnet?

| | CoinDCX | Binance Futures Testnet |
|--|---------|-------------------------|
| Demo funds | ❌ Not available via public API | ✅ Free virtual USDT |
| Real futures API | ✅ Live only | ✅ Full REST (orders, leverage, positions) |
| Risk | Real money | Fake money |

Strategy logic is exchange-agnostic. Test on Binance testnet, then switch `EXCHANGE=coindcx` for production.

---

## Setup (5 minutes)

### 1. Open the testnet site

https://testnet.binancefuture.com

- This is **separate** from your live Binance account.
- Register / log in with GitHub or email (as offered on the page).

### 2. Create API keys

1. Click the profile / API icon → **API Management**
2. Create a new API key
3. Copy **API Key** and **Secret Key** (secret shown once)

You should see a demo wallet already credited with virtual USDT (often ~5,000–10,000 USDT; you can request more on some testnet UIs).

### 3. Configure the bot

```bash
cp .env.example .env
```

Edit `.env`:

```env
EXCHANGE=binance_testnet

BINANCE_API_KEY=your_testnet_key
BINANCE_API_SECRET=your_testnet_secret

DERIV_LEVERAGE=10
DERIV_LEVERAGE_BY_SYMBOL={"BTCUSDT":20,"ETHUSDT":15}
ALLOW_SHORT=true
```

### 4. Run

```bash
pnpm install
pnpm dev
```

Dashboard: http://localhost:3000 (with `pnpm dashboard`)  
Status API: http://localhost:3100/api/status  

Mode should show something like `binance_testnet x10`.

---

## Switch to production later

### CoinDCX (your target live venue)

```env
EXCHANGE=coindcx
COINDCX_API_KEY=...
COINDCX_API_SECRET=...
```

### Binance live (real money — careful)

```env
EXCHANGE=binance
BINANCE_API_KEY=your_LIVE_key
BINANCE_API_SECRET=your_LIVE_secret
# base URL defaults to https://fapi.binance.com
```

---

## Notes

- Testnet keys **do not work** on `fapi.binance.com` (mainnet).
- Live keys **do not work** on `testnet.binancefuture.com`.
- Leverage, isolated/cross, long/short, SL/TP are supported on the Binance adapter.
- Public candle history for backtests uses Binance mainnet public klines (no key required).

## Troubleshooting

| Error | Fix |
|-------|-----|
| `-2015 Invalid API-key` | Wrong network: use testnet keys with `EXCHANGE=binance_testnet` |
| `-1021 Timestamp` | Clock skew; bot auto-syncs server time — retry |
| `-2019 Margin is insufficient` | Request more testnet funds on the testnet UI |
| Empty universe | Lower `MIN_DAILY_VOLUME_USDT` or check network |
