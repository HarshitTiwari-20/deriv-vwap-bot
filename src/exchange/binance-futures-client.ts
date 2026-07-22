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

const log = getLogger('BinanceFutures');

/** Binance interval map */
const TF_MAP: Record<Timeframe, string> = {
  '1m': '1m',
  '3m': '3m',
  '5m': '5m',
  '15m': '15m',
  '1h': '1h',
  '4h': '4h',
  '1d': '1d',
};

/**
 * Binance USD-M Futures client (mainnet or testnet).
 *
 * Testnet (recommended for testing — free demo USDT):
 *   1. Open https://testnet.binancefuture.com
 *   2. Login / register testnet account (separate from live)
 *   3. API Management → create key/secret
 *   4. Set EXCHANGE=binance_testnet + BINANCE_API_KEY / BINANCE_API_SECRET
 *
 * REST base (testnet): https://testnet.binancefuture.com
 * Docs: https://developers.binance.com/docs/derivatives/usds-margined-futures
 */
export class BinanceFuturesClient implements IExchangeClient {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly limiter = new RateLimiter(15, 12);
  private instrumentCache = new Map<string, FuturesInstrumentMeta>();
  private timeOffsetMs = 0;

  constructor(
    private readonly cfg: AppConfig['binance'],
    private readonly appConfig: AppConfig,
  ) {
    this.baseUrl = cfg.baseUrl.replace(/\/$/, '');
    this.apiKey = cfg.apiKey;
    this.apiSecret = cfg.apiSecret;
    this.name = cfg.testnet ? 'binance-futures-testnet' : 'binance-futures';
  }

  private async syncTime(): Promise<void> {
    try {
      const data = await this.publicGet<{ serverTime: number }>('/fapi/v1/time');
      this.timeOffsetMs = data.serverTime - Date.now();
    } catch {
      this.timeOffsetMs = 0;
    }
  }

  private ts(): number {
    return Date.now() + this.timeOffsetMs;
  }

  private sign(query: string): string {
    return createHmac('sha256', this.apiSecret).update(query).digest('hex');
  }

  private async publicGet<T>(
    path: string,
    params: Record<string, string | number | boolean | undefined> = {},
  ): Promise<T> {
    await this.limiter.acquire();
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') q.set(k, String(v));
    }
    const qs = q.toString();
    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ''}`;
    return withRetry(async () => {
      const res = await fetch(url, { method: 'GET' });
      if (!res.ok) {
        const text = await res.text();
        const err = new Error(`Binance GET ${path} ${res.status}: ${text}`) as Error & {
          status: number;
        };
        err.status = res.status;
        throw err;
      }
      return (await res.json()) as T;
    });
  }

  private async signedRequest<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    params: Record<string, string | number | boolean | undefined> = {},
  ): Promise<T> {
    if (!this.apiKey || !this.apiSecret) {
      throw new Error(
        'Binance API key/secret required. For testnet: https://testnet.binancefuture.com → API Management',
      );
    }
    await this.limiter.acquire();
    if (this.timeOffsetMs === 0) await this.syncTime();

    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') q.set(k, String(v));
    }
    q.set('timestamp', String(this.ts()));
    q.set('recvWindow', '5000');
    const query = q.toString();
    const signature = this.sign(query);
    const url = `${this.baseUrl}${path}?${query}&signature=${signature}`;

    return withRetry(async () => {
      const res = await fetch(url, {
        method,
        headers: {
          'X-MBX-APIKEY': this.apiKey,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });
      if (!res.ok) {
        const text = await res.text();
        // Resync clock on -1021
        if (text.includes('-1021')) {
          await this.syncTime();
        }
        const err = new Error(`Binance ${method} ${path} ${res.status}: ${text}`) as Error & {
          status: number;
        };
        err.status = res.status;
        throw err;
      }
      return (await res.json()) as T;
    }, {
      onRetry: (err, attempt, delay) =>
        log.warn({ err, attempt, delay, path }, 'Retrying Binance signed request'),
    });
  }

  toPair(symbol: string): string {
    return symbol.toUpperCase().replace(/[-_/]/g, '');
  }

  async getMarkets(): Promise<MarketMeta[]> {
    const data = await this.publicGet<{
      symbols: Array<Record<string, unknown>>;
    }>('/fapi/v1/exchangeInfo');

    const metas: MarketMeta[] = [];
    for (const s of data.symbols ?? []) {
      if (String(s.contractType) !== 'PERPETUAL') continue;
      if (String(s.quoteAsset) !== 'USDT') continue;
      if (String(s.status) !== 'TRADING') continue;

      const symbol = String(s.symbol);
      const filters = (s.filters as Array<Record<string, string>>) ?? [];
      const lot = filters.find((f) => f.filterType === 'LOT_SIZE');
      const priceF = filters.find((f) => f.filterType === 'PRICE_FILTER');
      const notional = filters.find(
        (f) => f.filterType === 'MIN_NOTIONAL' || f.filterType === 'NOTIONAL',
      );

      const meta: FuturesInstrumentMeta = {
        symbol,
        pair: symbol,
        baseAsset: String(s.baseAsset ?? ''),
        quoteAsset: 'USDT',
        status: 'active',
        minQuantity: Number(lot?.minQty ?? 0.001),
        maxQuantity: Number(lot?.maxQty ?? 1e9),
        stepSize: Number(lot?.stepSize ?? 0.001),
        tickSize: Number(priceF?.tickSize ?? 0.01),
        minNotional: Number(notional?.notional ?? notional?.minNotional ?? 5),
        maxLeverageLong: 125,
        maxLeverageShort: 125,
        quantityIncrement: Number(lot?.stepSize ?? 0.001),
        priceIncrement: Number(priceF?.tickSize ?? 0.01),
        minTradeSize: Number(lot?.minQty ?? 0.001),
        unitContractValue: 1,
      };
      this.instrumentCache.set(symbol, meta);
      metas.push(meta);
    }
    log.info({ count: metas.length, testnet: this.cfg.testnet }, 'Binance futures markets loaded');
    return metas;
  }

  async getInstrument(symbol: string): Promise<FuturesInstrumentMeta | undefined> {
    const s = this.toPair(symbol);
    if (this.instrumentCache.has(s)) return this.instrumentCache.get(s);
    await this.getMarkets();
    return this.instrumentCache.get(s);
  }

  async getTickers(): Promise<Ticker[]> {
    const data = await this.publicGet<
      Array<{
        symbol: string;
        lastPrice: string;
        bidPrice: string;
        askPrice: string;
        volume: string;
        quoteVolume: string;
        highPrice: string;
        lowPrice: string;
        priceChangePercent: string;
        closeTime: number;
      }>
    >('/fapi/v1/ticker/24hr');

    return (data ?? []).map((t) => ({
      symbol: t.symbol,
      lastPrice: Number(t.lastPrice),
      bid: Number(t.bidPrice || t.lastPrice),
      ask: Number(t.askPrice || t.lastPrice),
      volume24h: Number(t.volume),
      quoteVolume24h: Number(t.quoteVolume),
      high24h: Number(t.highPrice),
      low24h: Number(t.lowPrice),
      change24hPct: Number(t.priceChangePercent),
      timestamp: t.closeTime || Date.now(),
    }));
  }

  async getTicker(symbol: string): Promise<Ticker> {
    const s = this.toPair(symbol);
    const t = await this.publicGet<{
      symbol: string;
      lastPrice: string;
      bidPrice: string;
      askPrice: string;
      volume: string;
      quoteVolume: string;
      highPrice: string;
      lowPrice: string;
      priceChangePercent: string;
      closeTime: number;
    }>('/fapi/v1/ticker/24hr', { symbol: s });
    return {
      symbol: t.symbol,
      lastPrice: Number(t.lastPrice),
      bid: Number(t.bidPrice || t.lastPrice),
      ask: Number(t.askPrice || t.lastPrice),
      volume24h: Number(t.volume),
      quoteVolume24h: Number(t.quoteVolume),
      high24h: Number(t.highPrice),
      low24h: Number(t.lowPrice),
      change24hPct: Number(t.priceChangePercent),
      timestamp: t.closeTime || Date.now(),
    };
  }

  async getCandles(symbol: string, timeframe: Timeframe, limit = 200): Promise<Candle[]> {
    const s = this.toPair(symbol);
    const interval = TF_MAP[timeframe] ?? '1m';
    const raw = await this.publicGet<
      Array<[number, string, string, string, string, string, number, string, ...unknown[]]>
    >('/fapi/v1/klines', {
      symbol: s,
      interval,
      limit: Math.min(limit, 1500),
    });

    const tfMs = TIMEFRAME_MS[timeframe];
    return (raw ?? []).map((k) => {
      const openTime = Number(k[0]);
      return {
        symbol: s,
        timeframe,
        openTime,
        closeTime: openTime + tfMs - 1,
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5]),
        quoteVolume: Number(k[7] ?? 0),
        trades: Number(k[8] ?? 0),
        closed: openTime + tfMs <= Date.now(),
      } satisfies Candle;
    });
  }

  async getBalances(): Promise<Balance[]> {
    const data = await this.signedRequest<
      Array<{
        asset: string;
        balance: string;
        availableBalance: string;
        crossWalletBalance?: string;
      }>
    >('GET', '/fapi/v2/balance');

    return (data ?? [])
      .filter((b) => Number(b.balance) !== 0 || b.asset === 'USDT')
      .map((b) => {
        const total = Number(b.balance);
        const available = Number(b.availableBalance ?? b.balance);
        return {
          currency: b.asset,
          available,
          locked: Math.max(0, total - available),
          total,
        };
      });
  }

  async resolveOrderLeverage(symbol: string, requested?: number): Promise<number> {
    let lev = requested ?? resolveLeverage(this.appConfig, symbol);
    if (this.appConfig.derivatives.respectInstrumentMaxLeverage) {
      // Bracket from leverage bracket endpoint when possible
      try {
        const brackets = await this.signedRequest<
          Array<{ symbol: string; brackets: Array<{ initialLeverage: number }> }>
        >('GET', '/fapi/v1/leverageBracket', { symbol: this.toPair(symbol) });
        const max = brackets?.[0]?.brackets?.[0]?.initialLeverage;
        if (max) lev = Math.min(lev, max);
      } catch {
        lev = Math.min(lev, 125);
      }
    }
    return Math.max(1, Math.floor(lev));
  }

  async updateLeverage(symbol: string, leverage: number): Promise<void> {
    await this.signedRequest('POST', '/fapi/v1/leverage', {
      symbol: this.toPair(symbol),
      leverage: Math.floor(leverage),
    });
  }

  async setMarginType(symbol: string, marginType: 'ISOLATED' | 'CROSSED'): Promise<void> {
    try {
      await this.signedRequest('POST', '/fapi/v1/marginType', {
        symbol: this.toPair(symbol),
        marginType,
      });
    } catch (err) {
      // -4046 = no need to change margin type
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('-4046') && !msg.includes('No need to change')) {
        log.warn({ err, symbol }, 'setMarginType failed');
      }
    }
  }

  async placeOrder(request: OrderRequest): Promise<Order> {
    const symbol = this.toPair(request.symbol);
    const leverage = await this.resolveOrderLeverage(symbol, request.leverage);

    await this.updateLeverage(symbol, leverage);
    await this.setMarginType(
      symbol,
      this.appConfig.derivatives.marginType === 'crossed' ? 'CROSSED' : 'ISOLATED',
    );

    // Round quantity to step size
    const inst = await this.getInstrument(symbol);
    let qty = request.quantity;
    if (inst) {
      const step = inst.stepSize || inst.quantityIncrement || 0.001;
      qty = Math.floor(qty / step) * step;
      // fix float noise
      const precision = Math.max(0, (step.toString().split('.')[1] ?? '').length);
      qty = Number(qty.toFixed(precision));
    }
    if (qty <= 0) throw new Error(`Quantity rounded to 0 for ${symbol}`);

    const side = request.side === 'buy' ? 'BUY' : 'SELL';
    const params: Record<string, string | number | boolean> = {
      symbol,
      side,
      type: request.type === 'market' ? 'MARKET' : 'LIMIT',
      quantity: qty,
      newClientOrderId: request.clientOrderId ?? shortId('b'),
    };

    if (request.type === 'limit' && request.price !== undefined) {
      params.price = request.price;
      params.timeInForce = 'GTC';
    }

    if (request.reduceOnly) {
      params.reduceOnly = 'true';
    }

    const data = await this.signedRequest<Record<string, unknown>>('POST', '/fapi/v1/order', params);

    // Exchange SL/TP: many Binance futures accounts require Algo Order API (-4120).
    // Software stop management in PortfolioManager handles SL/TP1/TP2/trail instead.
    // Optional attempt only when attachSlTpOnEntry is true; failures are non-fatal.
    if (this.appConfig.derivatives.attachSlTpOnEntry && !request.reduceOnly) {
      await this.tryPlaceAlgoExitOrders(symbol, side, request);
    }

    return this.mapOrder(data, request, leverage);
  }

  async cancelOrder(orderId: string, symbol?: string): Promise<Order> {
    if (!symbol) throw new Error('Binance cancelOrder requires symbol');
    const data = await this.signedRequest<Record<string, unknown>>('DELETE', '/fapi/v1/order', {
      symbol: this.toPair(symbol),
      orderId,
    });
    return this.mapOrder(data, {
      symbol,
      side: 'buy',
      type: 'market',
      quantity: 0,
    });
  }

  async getOrder(orderId: string, symbol?: string): Promise<Order> {
    if (!symbol) throw new Error('Binance getOrder requires symbol');
    const data = await this.signedRequest<Record<string, unknown>>('GET', '/fapi/v1/order', {
      symbol: this.toPair(symbol),
      orderId,
    });
    return this.mapOrder(data, {
      symbol,
      side: String(data.side).toLowerCase() === 'sell' ? 'sell' : 'buy',
      type: 'market',
      quantity: Number(data.origQty ?? 0),
    });
  }

  async getOpenOrders(symbol?: string): Promise<Order[]> {
    const params: Record<string, string> = {};
    if (symbol) params.symbol = this.toPair(symbol);
    const data = await this.signedRequest<Array<Record<string, unknown>>>(
      'GET',
      '/fapi/v1/openOrders',
      params,
    );
    return (data ?? []).map((o) =>
      this.mapOrder(o, {
        symbol: String(o.symbol ?? symbol ?? ''),
        side: String(o.side).toLowerCase() === 'sell' ? 'sell' : 'buy',
        type: 'limit',
        quantity: Number(o.origQty ?? 0),
      }),
    );
  }

  async getFuturesPositions(): Promise<FuturesPosition[]> {
    const data = await this.signedRequest<
      Array<{
        symbol: string;
        positionAmt: string;
        entryPrice: string;
        markPrice: string;
        liquidationPrice: string;
        leverage: string;
        marginType: string;
        isolatedMargin: string;
        unRealizedProfit: string;
        positionSide: string;
      }>
    >('GET', '/fapi/v2/positionRisk');

    return (data ?? [])
      .filter((p) => Number(p.positionAmt) !== 0)
      .map((p) => {
        const size = Number(p.positionAmt);
        return {
          id: `${p.symbol}:${p.positionSide}`,
          symbol: p.symbol,
          pair: p.symbol,
          side: size > 0 ? 'buy' : size < 0 ? 'sell' : 'flat',
          size: Math.abs(size),
          entryPrice: Number(p.entryPrice),
          markPrice: Number(p.markPrice),
          liquidationPrice: Number(p.liquidationPrice),
          leverage: Number(p.leverage),
          marginType: String(p.marginType).toLowerCase() === 'crossed' ? 'crossed' : 'isolated',
          lockedMargin: Number(p.isolatedMargin || 0),
          unrealizedPnl: Number(p.unRealizedProfit),
          takeProfit: null,
          stopLoss: null,
        } satisfies FuturesPosition;
      });
  }

  async exitFuturesPosition(positionId: string): Promise<void> {
    // positionId format SYMBOL:BOTH or just look up by symbol
    const symbol = positionId.includes(':') ? positionId.split(':')[0]! : positionId;
    const positions = await this.getFuturesPositions();
    const pos = positions.find((p) => p.symbol === symbol || p.id === positionId);
    if (!pos || pos.size === 0) return;

    await this.placeOrder({
      symbol: pos.symbol,
      side: pos.side === 'buy' ? 'sell' : 'buy',
      type: 'market',
      quantity: pos.size,
      reduceOnly: true,
      leverage: pos.leverage,
    });
  }

  async cancelAllOpenOrders(): Promise<void> {
    const open = await this.getOpenOrders();
    const bySymbol = new Set(open.map((o) => o.symbol).filter(Boolean));
    for (const symbol of bySymbol) {
      try {
        await this.signedRequest('DELETE', '/fapi/v1/allOpenOrders', {
          symbol: this.toPair(symbol),
        });
      } catch (err) {
        log.warn({ err, symbol }, 'cancelAllOpenOrders failed for symbol');
      }
    }
  }

  /**
   * Binance testnet/mainnet has no spot↔futures transfer in this adapter.
   * Redeem is a no-op with a clear error so the UI can explain.
   */
  async transferFuturesWallet(
    transferType: 'deposit' | 'withdraw',
    amount: number,
    currency = 'USDT',
  ): Promise<import('./types.js').WalletTransferResult> {
    throw new Error(
      `Wallet transfer (${transferType} ${amount} ${currency}) is only supported on CoinDCX. ` +
        'On Binance, move funds via the exchange UI or transfer API separately.',
    );
  }

  /**
   * Best-effort conditional exits. Prefer algo endpoint; fall back silently.
   * Bot always manages stops in-process regardless.
   */
  private async tryPlaceAlgoExitOrders(
    symbol: string,
    entrySide: string,
    request: OrderRequest,
  ): Promise<void> {
    const closeSide = entrySide === 'BUY' ? 'SELL' : 'BUY';
    const attempts: Array<{ label: string; path: string; body: Record<string, string | number> }> =
      [];

    if (request.stopLossPrice !== undefined) {
      attempts.push({
        label: 'SL',
        path: '/fapi/v1/algoOrder',
        body: {
          algoType: 'CONDITIONAL',
          symbol,
          side: closeSide,
          type: 'STOP_MARKET',
          triggerPrice: request.stopLossPrice,
          closePosition: 'true',
          workingType: 'MARK_PRICE',
        },
      });
    }
    if (request.takeProfitPrice !== undefined) {
      attempts.push({
        label: 'TP',
        path: '/fapi/v1/algoOrder',
        body: {
          algoType: 'CONDITIONAL',
          symbol,
          side: closeSide,
          type: 'TAKE_PROFIT_MARKET',
          triggerPrice: request.takeProfitPrice,
          closePosition: 'true',
          workingType: 'MARK_PRICE',
        },
      });
    }

    for (const a of attempts) {
      try {
        await this.signedRequest('POST', a.path, a.body);
        log.info({ symbol, type: a.label }, 'Algo exit order placed');
      } catch {
        // Non-fatal — PortfolioManager enforces SL/TP on price updates
        log.debug({ symbol, type: a.label }, 'Algo exit order skipped (managed in software)');
      }
    }
  }

  private mapOrder(
    raw: Record<string, unknown>,
    req: OrderRequest,
    leverage?: number,
  ): Order {
    const statusRaw = String(raw.status ?? 'NEW').toUpperCase();
    const statusMap: Record<string, Order['status']> = {
      NEW: 'open',
      PARTIALLY_FILLED: 'partially_filled',
      FILLED: 'filled',
      CANCELED: 'cancelled',
      CANCELLED: 'cancelled',
      REJECTED: 'rejected',
      EXPIRED: 'expired',
    };
    return {
      id: String(raw.orderId ?? shortId('ord')),
      clientOrderId: String(raw.clientOrderId ?? req.clientOrderId ?? ''),
      exchangeOrderId: String(raw.orderId ?? ''),
      symbol: String(raw.symbol ?? req.symbol),
      side: String(raw.side ?? req.side).toUpperCase() === 'SELL' ? 'sell' : 'buy',
      type: req.type,
      quantity: Number(raw.origQty ?? req.quantity),
      filledQuantity: Number(raw.executedQty ?? 0),
      price: raw.price !== undefined ? Number(raw.price) : req.price,
      avgFillPrice:
        raw.avgPrice !== undefined && Number(raw.avgPrice) > 0
          ? Number(raw.avgPrice)
          : undefined,
      status: statusMap[statusRaw] ?? 'open',
      leverage: leverage ?? req.leverage,
      createdAt: Number(raw.updateTime ?? Date.now()),
      updatedAt: Date.now(),
      mode: 'live',
    };
  }
}
