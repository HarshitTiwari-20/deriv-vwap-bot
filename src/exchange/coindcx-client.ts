import { createHmac } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { URL } from 'node:url';
import type { AppConfig } from '../config/schema.js';
import { resolveLeverage } from '../config/index.js';
import type { Candle, MarketMeta, Ticker, Timeframe } from '../types/market.js';
import { TIMEFRAME_MS } from '../types/market.js';
import type {
  Balance,
  FuturesPosition,
  Order,
  OrderRequest,
} from '../types/trading.js';
import { getLogger } from '../utils/logger.js';
import { RateLimiter, withRetry } from '../utils/retry.js';
import { shortId } from '../utils/id.js';
import type { FuturesInstrumentMeta, IExchangeClient } from './types.js';

const log = getLogger('CoinDcxFutures');

/**
 * CoinDCX futures candle resolutions (native API only supports these).
 * 3m / 15m / 4h are derived by aggregation.
 */
const NATIVE_RES: Partial<Record<Timeframe, string>> = {
  '1m': '1',
  '5m': '5',
  '1h': '60',
  '1d': '1D',
};

/**
 * CoinDCX USDT-M Derivatives (Futures) client with custom leverage.
 * Docs: https://docs.coindcx.com/#futures-end-points
 */
export class CoinDcxClient implements IExchangeClient {
  readonly name = 'coindcx-futures';
  private readonly baseUrl: string;
  private readonly publicBaseUrl: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly marginCurrency: 'USDT' | 'INR';
  private readonly limiter = new RateLimiter(10, 8);
  private instrumentCache = new Map<string, FuturesInstrumentMeta>();
  private pairBySymbol = new Map<string, string>();

  constructor(
    private readonly config: AppConfig['coindcx'],
    private readonly appConfig: AppConfig,
  ) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.publicBaseUrl = (config.publicBaseUrl ?? 'https://public.coindcx.com').replace(
      /\/$/,
      '',
    );
    this.apiKey = config.apiKey;
    this.apiSecret = config.apiSecret;
    this.marginCurrency = appConfig.derivatives.marginCurrency;
  }

  private sign(body: object): string {
    // Compact JSON — CoinDCX HMAC must match exact payload bytes
    const payload = JSON.stringify(body);
    return createHmac('sha256', this.apiSecret).update(payload).digest('hex');
  }

  /**
   * Low-level signed HTTP. CoinDCX wallet endpoints require GET *with* a signed JSON body
   * (fetch forbids GET bodies, so we use node:http(s)).
   */
  private rawSignedRequest(
    method: 'GET' | 'POST',
    path: string,
    body: Record<string, unknown> = {},
  ): Promise<{ status: number; text: string }> {
    if (!this.apiKey || !this.apiSecret) {
      throw new Error('CoinDCX API credentials not configured');
    }
    const timestamp = Date.now();
    const payloadBody = { ...body, timestamp };
    const jsonBody = JSON.stringify(payloadBody);
    const signature = this.sign(payloadBody);
    const url = new URL(`${this.baseUrl}${path}`);
    const transport = url.protocol === 'http:' ? httpRequest : httpsRequest;

    return new Promise((resolve, reject) => {
      const req = transport(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (url.protocol === 'http:' ? 80 : 443),
          path: `${url.pathname}${url.search}`,
          method,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(jsonBody),
            'X-AUTH-APIKEY': this.apiKey,
            'X-AUTH-SIGNATURE': signature,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
          res.on('end', () => {
            resolve({
              status: res.statusCode ?? 0,
              text: Buffer.concat(chunks).toString('utf8'),
            });
          });
        },
      );
      req.on('error', reject);
      req.write(jsonBody);
      req.end();
    });
  }

  private async publicGet<T>(
    base: string,
    path: string,
    query?: Record<string, string>,
  ): Promise<T> {
    await this.limiter.acquire();
    const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
    const url = `${base}${path}${qs}`;
    return withRetry(async () => {
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        const text = await res.text();
        const err = new Error(`CoinDCX GET ${path} ${res.status}: ${text}`) as Error & {
          status: number;
        };
        err.status = res.status;
        throw err;
      }
      return (await res.json()) as T;
    }, {
      onRetry: (err, attempt, delay) =>
        log.warn({ err, attempt, delay, path }, 'Retrying public GET'),
    });
  }

  /** Authenticated GET (used by futures wallets — docs require GET, not POST). */
  private async signedGet<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    await this.limiter.acquire();
    return withRetry(
      async () => {
        const { status, text } = await this.rawSignedRequest('GET', path, body);
        if (status < 200 || status >= 300) {
          const err = new Error(`CoinDCX GET ${path} ${status}: ${text}`) as Error & {
            status: number;
          };
          err.status = status;
          throw err;
        }
        return (text ? JSON.parse(text) : null) as T;
      },
      {
        onRetry: (err, attempt, delay) =>
          log.warn({ err, attempt, delay, path }, 'Retrying signed GET'),
      },
    );
  }

  private async signedPost<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    await this.limiter.acquire();
    return withRetry(
      async () => {
        const { status, text } = await this.rawSignedRequest('POST', path, body);
        if (status < 200 || status >= 300) {
          const err = new Error(`CoinDCX POST ${path} ${status}: ${text}`) as Error & {
            status: number;
          };
          err.status = status;
          throw err;
        }
        return (text ? JSON.parse(text) : null) as T;
      },
      {
        onRetry: (err, attempt, delay) =>
          log.warn({ err, attempt, delay, path }, 'Retrying signed POST'),
      },
    );
  }

  /** BTCUSDT → B-BTC_USDT */
  toPair(symbol: string): string {
    const s = symbol.toUpperCase().replace(/[-_/]/g, '');
    if (this.pairBySymbol.has(s)) return this.pairBySymbol.get(s)!;
    if (s.endsWith('USDT')) return `B-${s.slice(0, -4)}_USDT`;
    if (s.endsWith('INR')) return `B-${s.slice(0, -3)}_INR`;
    return `B-${s}`;
  }

  /** B-BTC_USDT → BTCUSDT */
  fromPair(pair: string): string {
    return pair.replace(/^B-/, '').replace(/_/g, '').toUpperCase();
  }

  async getMarkets(): Promise<MarketMeta[]> {
    const instruments = await this.publicGet<string[]>(
      this.baseUrl,
      '/exchange/v1/derivatives/futures/data/active_instruments',
      { 'margin_currency_short_name[]': this.marginCurrency },
    );

    const pairs = instruments ?? [];
    // Fast path: thin metas for ALL pairs (no N× detail HTTP — that froze the dashboard for minutes).
    // Full instrument detail is fetched on-demand via getInstrument() before orders.
    const metas: MarketMeta[] = [];
    for (const pair of pairs) {
      const symbol = this.fromPair(pair);
      this.pairBySymbol.set(symbol, pair);
      const thin = {
        symbol,
        pair,
        baseAsset: symbol.replace(/USDT$|INR$/i, ''),
        quoteAsset: this.marginCurrency === 'INR' ? 'USDT' : this.marginCurrency,
        status: 'active' as const,
        minQuantity: 0.001,
        maxQuantity: 1e9,
        stepSize: 0.001,
        tickSize: 0.01,
        minNotional: 6,
        maxLeverageLong: this.appConfig.derivatives.leverage,
        maxLeverageShort: this.appConfig.derivatives.leverage,
        quantityIncrement: 0.001,
        priceIncrement: 0.01,
        minTradeSize: 0.001,
        unitContractValue: 1,
      };
      metas.push(thin);
    }
    log.info({ markets: metas.length }, 'Markets loaded (fast thin meta)');

    // Warm a small set of preferred details in background (non-blocking)
    const preferred = (this.appConfig.derivatives.preferredSymbols ?? []).slice(0, 30);
    if (preferred.length) {
      void (async () => {
        for (const s of preferred) {
          try {
            await this.getInstrument(s);
          } catch {
            /* ignore */
          }
        }
      })();
    }
    return metas;
  }

  private async fetchInstrumentByPair(pair: string): Promise<FuturesInstrumentMeta | undefined> {
    const data = await this.publicGet<{
      instrument?: Record<string, unknown>;
    }>(this.baseUrl, '/exchange/v1/derivatives/futures/data/instrument', {
      pair,
      margin_currency_short_name: this.marginCurrency,
    });
    const inst = data.instrument ?? (data as unknown as Record<string, unknown>);
    if (!inst || typeof inst !== 'object') return undefined;

    const pairStr = String(inst.pair ?? pair);
    const symbol = this.fromPair(pairStr);
    return {
      symbol,
      pair: pairStr,
      baseAsset: symbol.replace(/USDT$|INR$/i, ''),
      quoteAsset: this.marginCurrency,
      status: 'active',
      minQuantity: Number(inst.min_quantity ?? inst.min_trade_size ?? 0.001),
      maxQuantity: Number(inst.max_quantity ?? 1e9),
      stepSize: Number(inst.quantity_increment ?? inst.min_quantity ?? 0.001),
      tickSize: Number(inst.price_increment ?? 0.01),
      minNotional: Number(inst.min_notional ?? 5),
      maxLeverageLong: Number(inst.max_leverage_long ?? inst.max_leverage ?? 20),
      maxLeverageShort: Number(inst.max_leverage_short ?? inst.max_leverage ?? 20),
      quantityIncrement: Number(inst.quantity_increment ?? 0.001),
      priceIncrement: Number(inst.price_increment ?? 0.01),
      minTradeSize: Number(inst.min_trade_size ?? 0.001),
      unitContractValue: Number(inst.unit_contract_value ?? 1),
    };
  }

  async getInstrument(symbol: string): Promise<FuturesInstrumentMeta | undefined> {
    const s = symbol.toUpperCase().replace(/[-_/]/g, '');
    if (this.instrumentCache.has(s)) return this.instrumentCache.get(s);
    const pair = this.toPair(s);
    const meta = await this.fetchInstrumentByPair(pair);
    if (meta) {
      this.instrumentCache.set(s, meta);
      this.pairBySymbol.set(s, meta.pair);
    }
    return meta;
  }

  async getTickers(): Promise<Ticker[]> {
    // Futures current_prices is often 404 on CoinDCX — use public /exchange/ticker (USDT markets)
    // for fast volume ranking. Never fall back to per-pair candles (would hang on 400+ pairs).
    try {
      const data = await this.publicGet<
        Record<string, { last_price?: string | number; volume?: string | number; high?: number; low?: number; bid?: number; ask?: number }>
        | Array<Record<string, unknown>>
      >(this.baseUrl, '/exchange/v1/derivatives/futures/data/current_prices', {
        margin_currency_short_name: this.marginCurrency,
      } as never);
      if (Array.isArray(data) && data.length > 0) {
        return data.map((t) => this.mapTicker(t));
      }
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        const entries = Object.entries(data as Record<string, object>);
        if (entries.length > 0 && !('status' in (data as object))) {
          return entries.map(([pair, t]) => this.mapTicker({ pair, ...t }));
        }
      }
    } catch (err) {
      log.debug({ err }, 'futures current_prices unavailable');
    }

    try {
      const spot = await this.publicGet<
        Array<{
          market?: string;
          last_price?: string | number;
          volume?: string | number;
          high?: string | number;
          low?: string | number;
          bid?: string | number;
          ask?: string | number;
          change_24_hour?: string | number;
          timestamp?: number;
        }>
      >(this.baseUrl, '/exchange/ticker');
      const rows = Array.isArray(spot) ? spot : [];
      const out: Ticker[] = [];
      for (const t of rows) {
        const market = String(t.market ?? '').toUpperCase();
        if (!market.endsWith('USDT')) continue;
        // Skip INR quoted
        if (market.endsWith('INR') || market.includes('INR')) continue;
        const last = Number(t.last_price ?? 0);
        const vol = Number(t.volume ?? 0);
        out.push({
          symbol: market,
          lastPrice: last,
          bid: Number(t.bid ?? last),
          ask: Number(t.ask ?? last),
          volume24h: vol,
          quoteVolume24h: vol * last,
          high24h: Number(t.high ?? last),
          low24h: Number(t.low ?? last),
          change24hPct: Number(t.change_24_hour ?? 0),
          timestamp: Number(t.timestamp ?? Date.now()) * (Number(t.timestamp) < 1e12 ? 1000 : 1),
        });
      }
      log.info({ tickers: out.length }, 'Tickers from public /exchange/ticker');
      return out;
    } catch (err) {
      log.warn({ err }, 'Ticker fetch failed — empty list');
      return [];
    }
  }

  private mapTicker(t: Record<string, unknown>): Ticker {
    const pair = String(t.pair ?? t.market ?? t.symbol ?? '');
    const symbol = this.fromPair(pair).replace(/-/g, '') || String(t.symbol ?? '');
    const last = Number(t.last_price ?? t.lastPrice ?? t.price ?? t.mark_price ?? 0);
    return {
      symbol,
      lastPrice: last,
      bid: Number(t.bid ?? last),
      ask: Number(t.ask ?? last),
      volume24h: Number(t.volume ?? t.volume24h ?? 0),
      quoteVolume24h: Number(t.quote_volume ?? t.quoteVolume24h ?? 0) || last * Number(t.volume ?? 0),
      high24h: Number(t.high ?? t.high24h ?? last),
      low24h: Number(t.low ?? t.low24h ?? last),
      change24hPct: Number(t.change_24_hour ?? t.change24h ?? 0),
      timestamp: Number(t.timestamp ?? Date.now()),
    };
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const all = await this.getTickers();
    const s = symbol.toUpperCase().replace(/[-_/]/g, '');
    const t = all.find((x) => x.symbol === s);
    if (!t) throw new Error(`Ticker not found: ${symbol}`);
    return t;
  }

  async getCandles(symbol: string, timeframe: Timeframe, limit = 200): Promise<Candle[]> {
    const pair = this.toPair(symbol);
    const native = NATIVE_RES[timeframe];

    if (native) {
      return this.fetchNativeCandles(symbol, pair, timeframe, native, limit);
    }

    // Aggregate from finer TF
    if (timeframe === '3m') {
      const base = await this.fetchNativeCandles(symbol, pair, '1m', '1', limit * 3);
      return this.aggregateCandles(base, 3, '3m');
    }
    if (timeframe === '15m') {
      const base = await this.fetchNativeCandles(symbol, pair, '5m', '5', limit * 3);
      return this.aggregateCandles(base, 3, '15m');
    }
    if (timeframe === '4h') {
      const base = await this.fetchNativeCandles(symbol, pair, '1h', '60', limit * 4);
      return this.aggregateCandles(base, 4, '4h');
    }

    return this.fetchNativeCandles(symbol, pair, '1m', '1', limit);
  }

  private async fetchNativeCandles(
    symbol: string,
    pair: string,
    timeframe: Timeframe,
    resolution: string,
    limit: number,
  ): Promise<Candle[]> {
    const to = Math.floor(Date.now() / 1000);
    const tfMs = TIMEFRAME_MS[timeframe] ?? 60_000;
    const from = to - Math.ceil((limit * tfMs) / 1000);

    try {
      const data = await this.publicGet<{
        s?: string;
        data?: Array<{
          open?: number;
          high?: number;
          low?: number;
          close?: number;
          volume?: number;
          time?: number;
        }>;
      }>(this.publicBaseUrl, '/market_data/candlesticks', {
        pair,
        from: String(from),
        to: String(to),
        resolution,
        pcode: 'f',
      });

      const rows = data.data ?? [];
      return rows
        .map((c) => {
          const openTime = Number(c.time ?? 0);
          // API may return seconds or ms
          const ot = openTime < 1e12 ? openTime * 1000 : openTime;
          return {
            symbol: symbol.toUpperCase().replace(/[-_/]/g, ''),
            timeframe,
            openTime: ot,
            closeTime: ot + tfMs - 1,
            open: Number(c.open),
            high: Number(c.high),
            low: Number(c.low),
            close: Number(c.close),
            volume: Number(c.volume ?? 0),
            quoteVolume: Number(c.volume ?? 0) * Number(c.close),
            closed: ot + tfMs <= Date.now(),
          } satisfies Candle;
        })
        .filter((c) => Number.isFinite(c.open) && c.openTime > 0)
        .sort((a, b) => a.openTime - b.openTime)
        .slice(-limit);
    } catch (err) {
      log.warn({ err, symbol, timeframe }, 'Failed to fetch futures candles');
      return [];
    }
  }

  private aggregateCandles(candles: Candle[], factor: number, tf: Timeframe): Candle[] {
    if (factor <= 1 || candles.length === 0) return candles;
    const out: Candle[] = [];
    for (let i = 0; i < candles.length; i += factor) {
      const chunk = candles.slice(i, i + factor);
      if (chunk.length === 0) continue;
      const first = chunk[0]!;
      const last = chunk[chunk.length - 1]!;
      out.push({
        symbol: first.symbol,
        timeframe: tf,
        openTime: first.openTime,
        closeTime: last.closeTime,
        open: first.open,
        high: Math.max(...chunk.map((c) => c.high)),
        low: Math.min(...chunk.map((c) => c.low)),
        close: last.close,
        volume: chunk.reduce((s, c) => s + c.volume, 0),
        quoteVolume: chunk.reduce((s, c) => s + c.quoteVolume, 0),
        closed: last.closed,
      });
    }
    return out;
  }

  private usdtInrCache?: { rate: number; at: number };

  /**
   * Live USDTINR for converting contract notionals (USDT) → margin (INR).
   */
  async getUsdtInrRate(): Promise<number> {
    const override = this.appConfig.derivatives.usdtInrRate;
    if (override && override > 0) return override;
    const now = Date.now();
    if (this.usdtInrCache && now - this.usdtInrCache.at < 60_000) {
      return this.usdtInrCache.rate;
    }
    try {
      const tickers = await this.publicGet<
        Array<{ market?: string; last_price?: string | number }>
      >(this.baseUrl, '/exchange/ticker');
      const row = (Array.isArray(tickers) ? tickers : []).find(
        (t) => String(t.market).toUpperCase() === 'USDTINR',
      );
      const rate = Number(row?.last_price ?? 0);
      if (rate > 0) {
        this.usdtInrCache = { rate, at: now };
        return rate;
      }
    } catch (err) {
      log.warn({ err }, 'USDTINR ticker fetch failed');
    }
    return this.usdtInrCache?.rate ?? 99;
  }

  /**
   * Futures wallet balances (USDT + INR).
   * Docs: GET /exchange/v1/derivatives/futures/wallets (signed body with timestamp).
   * Note: `balance` in the payload is free/available; locked_* are in-margin.
   */
  async getBalances(): Promise<Balance[]> {
    const data = await this.signedGet<
      Array<{
        currency_short_name?: string;
        balance?: string | number;
        locked_balance?: string | number;
        cross_order_margin?: string | number;
        cross_user_margin?: string | number;
        /** Some responses expose equity / wallet balance under alternate keys */
        equity?: string | number;
        wallet_balance?: string | number;
        available_balance?: string | number;
      }>
    >('/exchange/v1/derivatives/futures/wallets', {});

    const rows = Array.isArray(data) ? data : [];
    return rows.map((b) => {
      const lockedIso = Number(b.locked_balance ?? 0);
      const lockedCross =
        Number(b.cross_order_margin ?? 0) + Number(b.cross_user_margin ?? 0);
      const locked = lockedIso + lockedCross;

      // Prefer explicit available/equity fields when present
      const free = Number(
        b.available_balance ?? b.balance ?? b.wallet_balance ?? b.equity ?? 0,
      );
      // Free balance already excludes locked margin on CoinDCX; total ≈ free + locked
      const totalRaw = Number(b.equity ?? b.wallet_balance ?? 0);
      const total = totalRaw > 0 ? totalRaw : free + locked;

      return {
        currency: String(b.currency_short_name ?? '').toUpperCase(),
        available: free,
        locked,
        total: total > 0 ? total : free,
      };
    });
  }

  /**
   * Clamp leverage to instrument max and config.
   */
  async resolveOrderLeverage(symbol: string, side: 'buy' | 'sell', requested?: number): Promise<number> {
    let lev = requested ?? resolveLeverage(this.appConfig, symbol);
    if (this.appConfig.derivatives.respectInstrumentMaxLeverage) {
      const inst = await this.getInstrument(symbol);
      if (inst) {
        const max =
          side === 'buy' ? inst.maxLeverageLong : inst.maxLeverageShort || inst.maxLeverageLong;
        if (max > 0) lev = Math.min(lev, Math.floor(max));
      }
    }
    return Math.max(1, Math.floor(lev));
  }

  async updateLeverage(symbol: string, leverage: number): Promise<void> {
    const pair = this.toPair(symbol);
    await this.signedPost('/exchange/v1/derivatives/futures/positions/update_leverage', {
      pair,
      leverage,
      margin_currency_short_name: this.marginCurrency,
    });
  }

  private tickDecimals(tick: number): number {
    if (!(tick > 0) || !Number.isFinite(tick)) return 8;
    // Prefer decimal string over scientific notation (e.g. 1e-5 → still 5 places)
    const s = tick >= 1e-12 && tick < 1 ? tick.toFixed(12).replace(/0+$/, '') : String(tick);
    const dot = s.indexOf('.');
    if (dot < 0) return 0;
    return Math.min(s.length - dot - 1, 12);
  }

  private roundToTick(price: number, tick: number): number {
    if (!(tick > 0) || !Number.isFinite(price)) return price;
    const rounded = Math.round(price / tick) * tick;
    return Number(rounded.toFixed(this.tickDecimals(tick)));
  }

  /** Tick-aligned price as a plain decimal string (API rejects non-divisible floats). */
  private formatPriceForApi(price: number, tick: number): string {
    const rounded = this.roundToTick(price, tick);
    return rounded.toFixed(this.tickDecimals(tick));
  }

  async placeOrder(request: OrderRequest): Promise<Order> {
    const pair = this.toPair(request.symbol);
    const leverage = await this.resolveOrderLeverage(
      request.symbol,
      request.side,
      request.leverage,
    );

    try {
      await this.updateLeverage(request.symbol, leverage);
    } catch (err) {
      log.warn({ err, symbol: request.symbol, leverage }, 'update_leverage failed (continuing)');
    }

    let qty = request.quantity;
    let tick = 0.0001;
    try {
      const inst = await this.getInstrument(request.symbol);
      if (inst) {
        const step = inst.stepSize || inst.quantityIncrement || 0.001;
        tick = inst.priceIncrement || inst.tickSize || tick;
        if (step > 0) {
          qty = Math.floor(qty / step) * step;
          const precision = Math.max(0, (String(step).split('.')[1] ?? '').length);
          qty = Number(qty.toFixed(precision));
        }
      }
    } catch {
      /* use raw qty */
    }
    if (!(qty > 0)) throw new Error(`Quantity rounded to 0 for ${request.symbol}`);

    const orderType =
      request.type === 'market'
        ? 'market_order'
        : request.type === 'limit'
          ? 'limit_order'
          : request.type;

    const orderBody: Record<string, unknown> = {
      side: request.side,
      pair,
      order_type: orderType,
      total_quantity: qty,
      leverage,
      notification: 'no_notification',
      hidden: false,
      post_only: false,
      margin_currency_short_name: this.marginCurrency,
    };

    if (request.type === 'limit' && request.price !== undefined) {
      orderBody.price = this.roundToTick(request.price, tick);
      orderBody.time_in_force = 'good_till_cancel';
    }

    // Optional exchange SL/TP — must be tick-rounded and on the correct side of entry.
    // CoinDCX often 422s bad TP/SL; we retry without them and manage exits in software.
    const attachSlTp =
      this.appConfig.derivatives.attachSlTpOnEntry && !request.reduceOnly;
    if (attachSlTp) {
      const ref =
        request.price && request.price > 0
          ? request.price
          : request.stopLossPrice && request.takeProfitPrice
            ? (request.stopLossPrice + request.takeProfitPrice) / 2
            : undefined;
      if (request.stopLossPrice !== undefined) {
        const sl = this.roundToTick(request.stopLossPrice, tick);
        // For market entry, exchange validates vs mark; keep raw rounded value
        orderBody.stop_loss_price = sl;
      }
      if (request.takeProfitPrice !== undefined) {
        orderBody.take_profit_price = this.roundToTick(request.takeProfitPrice, tick);
      }
      void ref;
    }

    const create = async (body: Record<string, unknown>) => {
      const data = await this.signedPost<
        Array<Record<string, unknown>> | { orders?: Array<Record<string, unknown>> }
      >('/exchange/v1/derivatives/futures/orders/create', { order: body });
      const raw = Array.isArray(data)
        ? data[0]
        : data.orders?.[0] ?? (data as Record<string, unknown>);
      return this.mapOrder(raw as Record<string, unknown>, { ...request, quantity: qty }, leverage);
    };

    try {
      return await create(orderBody);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isTpSl =
        /TP\s*\/\s*SL|take_profit|stop_loss|correct values for TP/i.test(msg) ||
        (msg.includes('422') && /TP|SL|stop|profit/i.test(msg));
      if (
        isTpSl &&
        (orderBody.stop_loss_price !== undefined || orderBody.take_profit_price !== undefined)
      ) {
        log.warn(
          {
            symbol: request.symbol,
            sl: orderBody.stop_loss_price,
            tp: orderBody.take_profit_price,
          },
          'Exchange rejected SL/TP — retrying entry without attach (software manages exits)',
        );
        delete orderBody.stop_loss_price;
        delete orderBody.take_profit_price;
        return await create(orderBody);
      }
      throw err;
    }
  }

  async cancelOrder(orderId: string, _symbol?: string): Promise<Order> {
    await this.signedPost('/exchange/v1/derivatives/futures/orders/cancel', { id: orderId });
    return {
      id: orderId,
      symbol: _symbol ?? '',
      side: 'buy',
      type: 'market',
      quantity: 0,
      filledQuantity: 0,
      status: 'cancelled',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      mode: 'live',
    };
  }

  async getOrder(orderId: string, symbol?: string): Promise<Order> {
    const data = await this.signedPost<Array<Record<string, unknown>>>(
      '/exchange/v1/derivatives/futures/orders',
      {
        status: 'open,filled,partially_filled,cancelled,rejected',
        side: 'buy,sell',
        page: '1',
        size: '50',
        margin_currency_short_name: [this.marginCurrency],
      },
    );
    const rows = Array.isArray(data) ? data : [];
    const raw = rows.find((o) => String(o.id) === orderId);
    if (!raw) throw new Error(`Order not found: ${orderId}`);
    return this.mapOrder(raw, {
      symbol: symbol ?? this.fromPair(String(raw.pair ?? '')),
      side: String(raw.side) === 'sell' ? 'sell' : 'buy',
      type: 'market',
      quantity: Number(raw.total_quantity ?? 0),
    });
  }

  async getOpenOrders(symbol?: string): Promise<Order[]> {
    const data = await this.signedPost<Array<Record<string, unknown>>>(
      '/exchange/v1/derivatives/futures/orders',
      {
        status: 'open,partially_filled,init',
        side: 'buy,sell',
        page: '1',
        size: '100',
        margin_currency_short_name: [this.marginCurrency],
      },
    );
    const rows = Array.isArray(data) ? data : [];
    return rows
      .map((o) =>
        this.mapOrder(o, {
          symbol: this.fromPair(String(o.pair ?? symbol ?? '')),
          side: String(o.side) === 'sell' ? 'sell' : 'buy',
          type: 'limit',
          quantity: Number(o.total_quantity ?? 0),
        }),
      )
      .filter((o) => !symbol || o.symbol === symbol.toUpperCase().replace(/[-_/]/g, ''));
  }

  async getFuturesPositions(): Promise<FuturesPosition[]> {
    const data = await this.signedPost<Array<Record<string, unknown>>>(
      '/exchange/v1/derivatives/futures/positions',
      {
        page: '1',
        size: '100',
        margin_currency_short_name: [this.marginCurrency],
      },
    );
    const rows = Array.isArray(data) ? data : [];
    return rows
      .map((p) => {
        const sizeRaw = Number(p.active_pos ?? 0);
        const size = Math.abs(sizeRaw);
        const side: FuturesPosition['side'] =
          sizeRaw > 0 ? 'buy' : sizeRaw < 0 ? 'sell' : 'flat';
        const entry = Number(p.avg_price ?? 0);
        const mark = Number(p.mark_price ?? 0);
        const dir = side === 'buy' ? 1 : side === 'sell' ? -1 : 0;
        const locked = Number(
          p.locked_user_margin ?? p.locked_margin ?? p.ideal_margin ?? 0,
        );
        return {
          id: String(p.id ?? ''),
          symbol: this.fromPair(String(p.pair ?? '')),
          pair: String(p.pair ?? ''),
          side,
          size,
          entryPrice: entry,
          markPrice: mark,
          liquidationPrice: Number(p.liquidation_price ?? 0),
          leverage: Number(p.leverage ?? this.appConfig.derivatives.leverage),
          marginType: String(p.margin_type ?? 'isolated') === 'crossed' ? 'crossed' : 'isolated',
          lockedMargin: locked,
          unrealizedPnl:
            entry > 0 && mark > 0 && size > 0 ? (mark - entry) * size * dir : undefined,
          takeProfit:
            p.take_profit_trigger != null && Number(p.take_profit_trigger) > 0
              ? Number(p.take_profit_trigger)
              : null,
          stopLoss:
            p.stop_loss_trigger != null && Number(p.stop_loss_trigger) > 0
              ? Number(p.stop_loss_trigger)
              : null,
        } satisfies FuturesPosition;
      })
      .filter((p) => p.size > 0);
  }

  async exitFuturesPosition(positionId: string): Promise<void> {
    await this.signedPost('/exchange/v1/derivatives/futures/positions/exit', {
      id: positionId,
    });
  }

  /**
   * Attach exchange-native TP/SL to an open position (survives bot restarts).
   * Uses market trigger orders so fills are reliable on small accounts.
   * Prices are rounded to the instrument price_increment (tick).
   */
  async createPositionTpsl(
    positionId: string,
    opts: { stopLoss?: number; takeProfit?: number; symbol?: string },
  ): Promise<void> {
    if (!positionId) throw new Error('createPositionTpsl requires position id');
    if (opts.stopLoss === undefined && opts.takeProfit === undefined) {
      throw new Error('createPositionTpsl needs stopLoss and/or takeProfit');
    }

    // Resolve tick so stop_price is divisible by price_increment (CoinDCX 422 otherwise).
    let tick = 0.00001;
    if (opts.symbol) {
      try {
        const inst = await this.getInstrument(opts.symbol);
        if (inst) {
          tick = inst.priceIncrement || inst.tickSize || tick;
        }
      } catch (err) {
        log.warn(
          { err, symbol: opts.symbol },
          'createPositionTpsl: instrument lookup failed — using default tick',
        );
      }
    } else {
      log.warn({ positionId }, 'createPositionTpsl without symbol — using default tick 0.00001');
    }

    const body: Record<string, unknown> = { id: positionId };
    let slStr: string | undefined;
    let tpStr: string | undefined;
    if (opts.takeProfit !== undefined && opts.takeProfit > 0) {
      tpStr = this.formatPriceForApi(opts.takeProfit, tick);
      body.take_profit = {
        stop_price: tpStr,
        order_type: 'take_profit_market',
      };
    }
    if (opts.stopLoss !== undefined && opts.stopLoss > 0) {
      slStr = this.formatPriceForApi(opts.stopLoss, tick);
      body.stop_loss = {
        stop_price: slStr,
        order_type: 'stop_market',
      };
    }

    try {
      await this.signedPost(
        '/exchange/v1/derivatives/futures/positions/create_tpsl',
        body,
      );
      log.info(
        { positionId, symbol: opts.symbol, sl: slStr, tp: tpStr, tick },
        'Exchange TP/SL attached',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Already exists is OK
      if (/already exists|TP already|SL already/i.test(msg)) {
        log.info({ positionId }, 'Exchange TP/SL already present');
        return;
      }
      throw err;
    }
  }

  /** Cancel all open futures orders (all pairs for this margin currency). */
  async cancelAllOpenOrders(): Promise<void> {
    try {
      // Docs: POST /exchange/v1/derivatives/futures/positions/cancel_all_open_orders
      await this.signedPost(
        '/exchange/v1/derivatives/futures/positions/cancel_all_open_orders',
        {
          margin_currency_short_name: this.marginCurrency,
        },
      );
    } catch (err) {
      // Fallback: cancel each open order individually
      log.warn({ err }, 'cancel_all failed — falling back to per-order cancel');
      const open = await this.getOpenOrders();
      for (const o of open) {
        try {
          await this.cancelOrder(o.id, o.symbol);
        } catch (e) {
          log.warn({ err: e, id: o.id }, 'cancel order failed');
        }
      }
    }
  }

  /**
   * Transfer between spot and derivatives futures wallet.
   * withdraw = futures → spot (bank / redeem profits)
   * deposit  = spot → futures
   * Docs: POST /exchange/v1/derivatives/futures/wallets/transfer
   */
  async transferFuturesWallet(
    transferType: 'deposit' | 'withdraw',
    amount: number,
    currency?: string,
  ): Promise<import('./types.js').WalletTransferResult> {
    const cur = (currency ?? this.marginCurrency).toUpperCase();
    if (!(amount > 0) || !Number.isFinite(amount)) {
      throw new Error(`Invalid transfer amount: ${amount}`);
    }
    // CoinDCX accepts float amounts; keep reasonable precision for INR/USDT
    const rounded =
      cur === 'INR' ? Math.floor(amount * 100) / 100 : Math.floor(amount * 1e6) / 1e6;
    if (rounded <= 0) throw new Error('Transfer amount rounds to zero');

    const data = await this.signedPost<unknown>(
      '/exchange/v1/derivatives/futures/wallets/transfer',
      {
        transfer_type: transferType,
        amount: rounded,
        currency_short_name: cur,
      },
    );
    log.info({ transferType, amount: rounded, currency: cur }, 'Futures wallet transfer');
    return {
      ok: true,
      currency: cur,
      amount: rounded,
      transferType,
      raw: data,
    };
  }

  private mapOrder(
    raw: Record<string, unknown>,
    req: OrderRequest,
    leverage?: number,
  ): Order {
    const statusRaw = String(raw.status ?? 'open').toLowerCase();
    const statusMap: Record<string, Order['status']> = {
      open: 'open',
      initial: 'pending',
      init: 'pending',
      partial: 'partially_filled',
      partially_filled: 'partially_filled',
      filled: 'filled',
      complete: 'filled',
      cancelled: 'cancelled',
      canceled: 'cancelled',
      rejected: 'rejected',
      pending: 'pending',
    };
    return {
      id: String(raw.id ?? shortId('ord')),
      clientOrderId: String(raw.client_order_id ?? req.clientOrderId ?? ''),
      exchangeOrderId: String(raw.id ?? ''),
      symbol: this.fromPair(String(raw.pair ?? req.symbol)),
      side: String(raw.side ?? req.side).toLowerCase() === 'sell' ? 'sell' : 'buy',
      type: req.type,
      quantity: Number(raw.total_quantity ?? req.quantity),
      filledQuantity: Number(
        raw.total_quantity !== undefined && raw.remaining_quantity !== undefined
          ? Number(raw.total_quantity) - Number(raw.remaining_quantity)
          : raw.filled_quantity ?? 0,
      ),
      price: raw.price !== undefined ? Number(raw.price) : req.price,
      avgFillPrice: raw.avg_price !== undefined ? Number(raw.avg_price) : undefined,
      status: statusMap[statusRaw] ?? 'open',
      fee: raw.fee_amount !== undefined ? Number(raw.fee_amount) : undefined,
      leverage: Number(raw.leverage ?? leverage ?? req.leverage ?? 1),
      createdAt: Number(raw.created_at ?? Date.now()),
      updatedAt: Date.now(),
      mode: 'live',
    };
  }
}
