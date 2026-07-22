import { EventEmitter } from 'node:events';
import type { AppConfig } from '../config/schema.js';
import type { Candle, Ticker, Timeframe } from '../types/market.js';
import { TIMEFRAME_MS } from '../types/market.js';
import { candleOpenTime } from '../utils/math.js';
import { getLogger } from '../utils/logger.js';
import type { EventBus } from '../events/event-bus.js';
import { WebSocket, type WsInstance } from './ws-shim.js';

const log = getLogger('MarketDataWs');

/**
 * Market data engine:
 * - Binance: combined mini-ticker / ticker streams
 * - CoinDCX: best-effort public WS
 * - Always: REST ticker poll fallback (never blocks trading loop)
 *
 * WS errors are swallowed + reconnect; they must never crash the process.
 */
export class MarketDataWs extends EventEmitter {
  private ws: WsInstance | null = null;
  private reconnectAttempt = 0;
  private closed = false;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private pollTimer?: ReturnType<typeof setInterval>;
  private readonly symbols = new Set<string>();
  private readonly timeframes = new Set<Timeframe>(['1m', '3m', '5m', '15m', '1h']);
  private readonly candleBuffers = new Map<string, Candle>();
  private lastPrices = new Map<string, number>();
  private wsEnabled = true;

  constructor(
    private readonly config: AppConfig,
    private readonly eventBus: EventBus,
    private readonly fetchTickers: () => Promise<Ticker[]>,
    private readonly fetchCandles: (
      symbol: string,
      tf: Timeframe,
      limit: number,
    ) => Promise<Candle[]>,
  ) {
    super();
    // Prevent EventEmitter crash on 'error' with zero listeners
    this.on('error', (err: Error) => {
      log.debug({ err: err?.message }, 'MarketDataWs error event (handled)');
    });
  }

  subscribe(symbols: string[]): void {
    for (const s of symbols) this.symbols.add(s.toUpperCase());
  }

  unsubscribe(symbols: string[]): void {
    for (const s of symbols) this.symbols.delete(s.toUpperCase());
  }

  setTimeframes(tfs: Timeframe[]): void {
    this.timeframes.clear();
    for (const t of tfs) this.timeframes.add(t);
  }

  getLastPrice(symbol: string): number | undefined {
    return this.lastPrices.get(symbol);
  }

  async start(): Promise<void> {
    this.closed = false;
    // REST poll first so scanner has data even if WS fails
    this.startPollingFallback();
    // WS is best-effort; never block startup
    void this.connectWs().catch((err) => {
      log.warn({ err }, 'Initial WS connect failed — REST poll active');
    });
  }

  async stop(): Promise<void> {
    this.closed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.teardownSocket();
  }

  private teardownSocket(): void {
    if (!this.ws) return;
    try {
      this.ws.removeAllListeners();
      this.ws.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  /** Resolve WS base/url for the active exchange */
  private buildWsUrl(): string | null {
    const exchange = this.config.exchange;

    if (exchange === 'binance_testnet' || exchange === 'binance') {
      const base =
        this.config.binance.wsUrl ||
        (this.config.binance.testnet
          ? 'wss://fstream.binancefuture.com'
          : 'wss://fstream.binance.com');

      // Combined stream: up to ~50 streams per connection for reliability
      const streams = [...this.symbols]
        .slice(0, 50)
        .map((s) => `${s.toLowerCase()}@ticker`);
      if (streams.length === 0) {
        // mini all-market ticker
        return `${base.replace(/\/$/, '')}/ws/!ticker@arr`;
      }
      return `${base.replace(/\/$/, '')}/stream?streams=${streams.join('/')}`;
    }

    // CoinDCX — public URL is often not a raw WS; skip if known-bad
    const url = this.config.coindcx.publicWsUrl;
    if (!url || url.includes('public.coindcx.com')) {
      // Prefer REST only for CoinDCX public (unreliable raw WS)
      return null;
    }
    return url;
  }

  private async connectWs(): Promise<void> {
    if (this.closed || !this.wsEnabled) return;

    const url = this.buildWsUrl();
    if (!url) {
      log.info('WS disabled for this exchange — using REST market data only');
      this.wsEnabled = false;
      return;
    }

    try {
      this.teardownSocket();
      const socket = new WebSocket(url);
      this.ws = socket;

      socket.on('open', (() => {
        this.reconnectAttempt = 0;
        log.info({ url: url.slice(0, 80) + '…' }, 'Market data WS connected');
        this.eventBus.emit('ws:connected', { stream: 'market' });
        this.emit('connected');
        this.startHeartbeat();
      }) as (...args: never[]) => void);

      socket.on('message', ((data: Buffer | string) => {
        try {
          this.handleMessage(data.toString());
        } catch (err) {
          log.debug({ err }, 'WS message parse error');
        }
      }) as (...args: never[]) => void);

      socket.on('close', ((code: number, reason: Buffer) => {
        log.warn(
          { code, reason: reason?.toString?.() ?? '' },
          'WS closed — will reconnect; REST poll continues',
        );
        this.eventBus.emit('ws:disconnected', {
          stream: 'market',
          reason: reason?.toString?.() ?? '',
        });
        this.scheduleReconnect();
      }) as (...args: never[]) => void);

      socket.on('error', ((err: Error) => {
        // Do NOT re-emit uncaught 'error' — crashes Node if no listeners
        log.warn(
          { err: err?.message ?? String(err) },
          'WS error — relying on REST poll until reconnect',
        );
        this.eventBus.emit('ws:error', {
          stream: 'market',
          error: err instanceof Error ? err : new Error(String(err)),
        });
        // After repeated failures, disable WS and stay on REST
        if (this.reconnectAttempt >= 5) {
          log.warn('Disabling WS after repeated failures; REST-only mode');
          this.wsEnabled = false;
          this.teardownSocket();
        }
      }) as (...args: never[]) => void);
    } catch (err) {
      log.warn({ err }, 'WS connect threw — REST poll active');
      this.scheduleReconnect();
    }
  }

  private handleMessage(raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // Binance combined stream wrapper: { stream, data }
    const payload =
      msg && typeof msg === 'object' && 'data' in (msg as object)
        ? (msg as { data: unknown }).data
        : msg;

    // Binance all-market ticker array
    if (Array.isArray(payload)) {
      for (const item of payload) {
        if (item && typeof item === 'object') this.ingestTickerLike(item as Record<string, unknown>);
      }
      return;
    }

    if (payload && typeof payload === 'object') {
      this.ingestTickerLike(payload as Record<string, unknown>);
    }
  }

  private ingestTickerLike(msg: Record<string, unknown>): void {
    // Binance 24hr ticker: s=symbol, c=last, b=bid, a=ask, v=volume, q=quoteVolume
    const symbol = String(msg.s ?? msg.symbol ?? msg.market ?? '')
      .replace(/-/, '')
      .toUpperCase();
    const price = Number(
      msg.c ?? msg.last_price ?? msg.lastPrice ?? msg.price ?? msg.p ?? NaN,
    );
    if (!symbol || !Number.isFinite(price)) return;

    // Filter to subscribed universe when set
    if (this.symbols.size > 0 && !this.symbols.has(symbol)) return;

    this.lastPrices.set(symbol, price);
    const ticker: Ticker = {
      symbol,
      lastPrice: price,
      bid: Number(msg.b ?? msg.bid ?? price),
      ask: Number(msg.a ?? msg.ask ?? price),
      volume24h: Number(msg.v ?? msg.volume ?? 0),
      quoteVolume24h: Number(msg.q ?? msg.quoteVolume ?? 0),
      high24h: Number(msg.h ?? msg.high ?? price),
      low24h: Number(msg.l ?? msg.low ?? price),
      change24hPct: Number(msg.P ?? msg.change ?? 0),
      timestamp: Number(msg.E ?? msg.timestamp ?? Date.now()),
    };
    this.emit('ticker', ticker);
    this.eventBus.emit('ticker:update', { ticker });
    this.updateLiveCandles(symbol, price, ticker.timestamp);
  }

  private updateLiveCandles(symbol: string, price: number, ts: number): void {
    for (const tf of this.timeframes) {
      const tfMs = TIMEFRAME_MS[tf];
      const openTime = candleOpenTime(ts, tfMs);
      const key = `${symbol}:${tf}`;
      let c = this.candleBuffers.get(key);
      if (!c || c.openTime !== openTime) {
        if (c && c.openTime < openTime) {
          c.closed = true;
          c.closeTime = c.openTime + tfMs - 1;
          this.emit('candleClosed', c);
          this.eventBus.emit('candle:closed', { candle: { ...c } });
        }
        c = {
          symbol,
          timeframe: tf,
          openTime,
          closeTime: openTime + tfMs - 1,
          open: price,
          high: price,
          low: price,
          close: price,
          volume: 0,
          quoteVolume: 0,
          closed: false,
        };
        this.candleBuffers.set(key, c);
      } else {
        c.high = Math.max(c.high, price);
        c.low = Math.min(c.low, price);
        c.close = price;
      }
      this.emit('candle', { ...c });
      this.eventBus.emit('candle:update', { candle: { ...c } });
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try {
          this.ws.ping();
        } catch {
          /* ignore */
        }
      }
    }, 20_000);
  }

  private scheduleReconnect(): void {
    if (this.closed || !this.wsEnabled) return;
    this.reconnectAttempt += 1;
    if (this.reconnectAttempt > 8) {
      log.warn('WS reconnect budget exhausted — REST-only mode');
      this.wsEnabled = false;
      return;
    }
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(this.reconnectAttempt, 6));
    log.info({ delay, attempt: this.reconnectAttempt }, 'Reconnecting WS');
    setTimeout(() => {
      if (!this.closed && this.wsEnabled) void this.connectWs();
    }, delay);
  }

  private startPollingFallback(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    // Faster poll when WS is off
    const interval = 3_000;
    this.pollTimer = setInterval(() => {
      void this.pollOnce();
    }, interval);
    void this.pollOnce();
  }

  private async pollOnce(): Promise<void> {
    try {
      const tickers = await this.fetchTickers();
      const want = this.symbols.size > 0 ? this.symbols : null;
      for (const t of tickers) {
        if (want && !want.has(t.symbol)) continue;
        this.lastPrices.set(t.symbol, t.lastPrice);
        this.emit('ticker', t);
        this.eventBus.emit('ticker:update', { ticker: t });
        this.updateLiveCandles(t.symbol, t.lastPrice, t.timestamp || Date.now());
      }
    } catch (err) {
      log.debug({ err }, 'Ticker poll failed');
    }
  }

  /**
   * Warm candles for many symbols.
   * @param onlyTimeframes — if set, only these TFs (use primary first for fast scan start)
   */
  async warmCandles(
    symbols: string[],
    limit = 200,
    onlyTimeframes?: Timeframe[],
  ): Promise<Map<string, Map<Timeframe, Candle[]>>> {
    const store = new Map<string, Map<Timeframe, Candle[]>>();
    for (const s of symbols) store.set(s, new Map());
    const tfs = onlyTimeframes?.length ? onlyTimeframes : [...this.timeframes];
    type Job = { sym: string; tf: Timeframe };
    const jobs: Job[] = [];
    for (const sym of symbols) {
      for (const tf of tfs) jobs.push({ sym, tf });
    }
    const concurrency = 20;
    let i = 0;
    let done = 0;
    const total = jobs.length;
    const run = async () => {
      while (i < jobs.length) {
        const job = jobs[i++]!;
        try {
          const candles = await this.fetchCandles(job.sym, job.tf, limit);
          store.get(job.sym)?.set(job.tf, candles);
          const last = candles[candles.length - 1];
          if (last) this.lastPrices.set(job.sym, last.close);
        } catch (err) {
          log.debug({ err, sym: job.sym, tf: job.tf }, 'warmCandles failed');
          store.get(job.sym)?.set(job.tf, []);
        }
        done += 1;
        if (done % 50 === 0 || done === total) {
          log.info(
            { done, total, symbols: symbols.length, tfs: tfs.length },
            'Candle warm progress',
          );
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => run()));
    return store;
  }
}
