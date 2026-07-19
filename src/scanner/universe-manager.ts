import type { AppConfig } from '../config/schema.js';
import type { MarketMeta, Ticker } from '../types/market.js';
import type { EventBus } from '../events/event-bus.js';
import type { IExchangeClient } from '../exchange/types.js';
import { getLogger } from '../utils/logger.js';
import { bps } from '../utils/math.js';

const log = getLogger('UniverseManager');

export interface UniverseFilters {
  minDailyVolumeUsdt: number;
  maxSpreadBps: number;
  universeSize: number;
  minListingAgeDays: number;
  quoteAsset?: string;
}

/**
 * Maintains the tradable universe of 100–200 USDT pairs.
 * Refreshes every 15 minutes by default.
 */
export class UniverseManager {
  private symbols: string[] = [];
  private markets = new Map<string, MarketMeta>();
  private tickers = new Map<string, Ticker>();
  private refreshTimer?: ReturnType<typeof setInterval>;
  private readonly filters: UniverseFilters;

  constructor(
    private readonly exchange: IExchangeClient,
    private readonly eventBus: EventBus,
    config: AppConfig,
  ) {
    this.filters = {
      minDailyVolumeUsdt: config.scanner.minDailyVolumeUsdt,
      maxSpreadBps: config.scanner.maxSpreadBps,
      universeSize: config.scanner.universeSize,
      minListingAgeDays: config.scanner.minListingAgeDays,
      quoteAsset: 'USDT',
    };
  }

  getSymbols(): string[] {
    return [...this.symbols];
  }

  getTicker(symbol: string): Ticker | undefined {
    return this.tickers.get(symbol);
  }

  getMarket(symbol: string): MarketMeta | undefined {
    return this.markets.get(symbol);
  }

  async refresh(): Promise<string[]> {
    const start = Date.now();
    const [markets, tickers] = await Promise.all([
      this.exchange.getMarkets(),
      this.exchange.getTickers(),
    ]);

    this.markets.clear();
    for (const m of markets) this.markets.set(m.symbol, m);

    this.tickers.clear();
    for (const t of tickers) this.tickers.set(t.symbol, t);

    const quote = this.filters.quoteAsset ?? 'USDT';
    const minAgeMs = this.filters.minListingAgeDays * 86_400_000;
    const now = Date.now();

    const candidates: Array<{ symbol: string; score: number }> = [];

    for (const m of markets) {
      if (m.status !== 'active') continue;
      if (!m.symbol.endsWith(quote) && m.quoteAsset !== quote) continue;
      if (m.listedAt && now - m.listedAt < minAgeMs) continue;

      const t = this.tickers.get(m.symbol);
      if (!t) continue;

      const vol =
        t.quoteVolume24h > 0 ? t.quoteVolume24h : t.volume24h * t.lastPrice;
      if (vol < this.filters.minDailyVolumeUsdt) continue;

      const spread =
        t.bid > 0 && t.ask > 0 ? bps(t.bid, t.ask) : 9999;
      if (spread > this.filters.maxSpreadBps) continue;
      if (t.lastPrice <= 0) continue;

      // Prefer high volume, tight spread
      const score = vol / (1 + spread);
      candidates.push({ symbol: m.symbol, score });
    }

    candidates.sort((a, b) => b.score - a.score);
    this.symbols = candidates
      .slice(0, this.filters.universeSize)
      .map((c) => c.symbol);

    log.info(
      {
        universe: this.symbols.length,
        scanned: markets.length,
        durationMs: Date.now() - start,
        top: this.symbols.slice(0, 5),
      },
      'Universe refreshed',
    );

    this.eventBus.emit('universe:refreshed', {
      symbols: this.symbols,
      timestamp: Date.now(),
    });

    return this.symbols;
  }

  startAutoRefresh(intervalMs: number): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(() => {
      void this.refresh().catch((err) => log.error({ err }, 'Universe refresh failed'));
    }, intervalMs);
  }

  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }
}
