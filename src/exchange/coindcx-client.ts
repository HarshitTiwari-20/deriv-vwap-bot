import { createHmac } from 'node:crypto';
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
    const payload = Buffer.from(JSON.stringify(body)).toString();
    return createHmac('sha256', this.apiSecret).update(payload).digest('hex');
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

  private async signedPost<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    if (!this.apiKey || !this.apiSecret) {
      throw new Error('CoinDCX API credentials not configured');
    }
    await this.limiter.acquire();
    const timestamp = Date.now();
    const payloadBody = { ...body, timestamp };
    const signature = this.sign(payloadBody);

    return withRetry(async () => {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AUTH-APIKEY': this.apiKey,
          'X-AUTH-SIGNATURE': signature,
        },
        body: JSON.stringify(payloadBody),
      });
      if (!res.ok) {
        const text = await res.text();
        const err = new Error(`CoinDCX POST ${path} ${res.status}: ${text}`) as Error & {
          status: number;
        };
        err.status = res.status;
        throw err;
      }
      return (await res.json()) as T;
    }, {
      onRetry: (err, attempt, delay) =>
        log.warn({ err, attempt, delay, path }, 'Retrying signed POST'),
    });
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

    const metas: MarketMeta[] = [];
    // Warm instrument details with limited concurrency
    const pairs = instruments ?? [];
    const concurrency = 8;
    let i = 0;
    const run = async () => {
      while (i < pairs.length) {
        const pair = pairs[i++]!;
        try {
          const detail = await this.fetchInstrumentByPair(pair);
          if (detail) {
            this.instrumentCache.set(detail.symbol, detail);
            this.pairBySymbol.set(detail.symbol, detail.pair);
            metas.push(detail);
          }
        } catch (err) {
          log.debug({ err, pair }, 'instrument detail failed');
          const symbol = this.fromPair(pair);
          this.pairBySymbol.set(symbol, pair);
          metas.push({
            symbol,
            baseAsset: symbol.replace(/USDT$|INR$/i, ''),
            quoteAsset: this.marginCurrency,
            status: 'active',
            minQuantity: 0.001,
            maxQuantity: 1e9,
            stepSize: 0.001,
            tickSize: 0.01,
            minNotional: 5,
          });
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => run()));
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
    // Prefer futures current prices when available; fall back to instrument LTP via candles
    try {
      const data = await this.publicGet<
        Record<string, { last_price?: string | number; volume?: string | number; high?: number; low?: number; bid?: number; ask?: number }>
        | Array<Record<string, unknown>>
      >(this.baseUrl, '/exchange/v1/derivatives/futures/data/current_prices', {
        margin_currency_short_name: this.marginCurrency,
      } as never);
      // endpoint shape may vary
      if (Array.isArray(data)) {
        return data.map((t) => this.mapTicker(t));
      }
      return Object.entries(data).map(([pair, t]) =>
        this.mapTicker({ pair, ...(t as object) }),
      );
    } catch {
      // Fallback: build thin tickers from known pairs
      const out: Ticker[] = [];
      for (const [symbol, pair] of this.pairBySymbol) {
        try {
          const candles = await this.getCandles(symbol, '1m', 2);
          const last = candles[candles.length - 1];
          if (!last) continue;
          out.push({
            symbol,
            lastPrice: last.close,
            bid: last.close,
            ask: last.close,
            volume24h: last.volume,
            quoteVolume24h: last.quoteVolume,
            high24h: last.high,
            low24h: last.low,
            change24hPct: 0,
            timestamp: Date.now(),
          });
        } catch {
          log.debug({ pair }, 'ticker fallback failed');
        }
      }
      return out;
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

  async getBalances(): Promise<Balance[]> {
    const data = await this.signedPost<
      Array<{
        currency_short_name?: string;
        balance?: string | number;
        locked_balance?: string | number;
      }>
    >('/exchange/v1/derivatives/futures/wallets', {});

    return (Array.isArray(data) ? data : []).map((b) => {
      const available = Number(b.balance ?? 0);
      const locked = Number(b.locked_balance ?? 0);
      return {
        currency: String(b.currency_short_name ?? '').toUpperCase(),
        available,
        locked,
        total: available + locked,
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
      total_quantity: request.quantity,
      leverage,
      notification: 'no_notification',
      hidden: false,
      post_only: false,
      margin_currency_short_name: this.marginCurrency,
    };

    if (request.type === 'limit' && request.price !== undefined) {
      orderBody.price = request.price;
      orderBody.time_in_force = 'good_till_cancel';
    }
    // Do not send time_in_force for market orders (per CoinDCX docs)

    if (this.appConfig.derivatives.attachSlTpOnEntry) {
      if (request.stopLossPrice !== undefined) orderBody.stop_loss_price = request.stopLossPrice;
      if (request.takeProfitPrice !== undefined)
        orderBody.take_profit_price = request.takeProfitPrice;
    }

    const data = await this.signedPost<
      Array<Record<string, unknown>> | { orders?: Array<Record<string, unknown>> }
    >('/exchange/v1/derivatives/futures/orders/create', { order: orderBody });

    const raw = Array.isArray(data) ? data[0] : data.orders?.[0] ?? (data as Record<string, unknown>);
    return this.mapOrder(raw as Record<string, unknown>, request, leverage);
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
        const size = Number(p.active_pos ?? 0);
        const side: FuturesPosition['side'] =
          size > 0 ? 'buy' : size < 0 ? 'sell' : 'flat';
        return {
          id: String(p.id ?? ''),
          symbol: this.fromPair(String(p.pair ?? '')),
          pair: String(p.pair ?? ''),
          side,
          size: Math.abs(size),
          entryPrice: Number(p.avg_price ?? 0),
          markPrice: Number(p.mark_price ?? 0),
          liquidationPrice: Number(p.liquidation_price ?? 0),
          leverage: Number(p.leverage ?? this.appConfig.derivatives.leverage),
          marginType: String(p.margin_type ?? 'isolated') === 'crossed' ? 'crossed' : 'isolated',
          lockedMargin: Number(p.locked_margin ?? p.locked_user_margin ?? 0),
          takeProfit: p.take_profit_trigger != null ? Number(p.take_profit_trigger) : null,
          stopLoss: p.stop_loss_trigger != null ? Number(p.stop_loss_trigger) : null,
        } satisfies FuturesPosition;
      })
      .filter((p) => p.size > 0);
  }

  async exitFuturesPosition(positionId: string): Promise<void> {
    await this.signedPost('/exchange/v1/derivatives/futures/positions/exit', {
      id: positionId,
    });
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
