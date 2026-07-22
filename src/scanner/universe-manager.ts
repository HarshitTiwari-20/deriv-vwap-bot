import type { AppConfig } from '../config/schema.js';
import type { MarketMeta, Ticker } from '../types/market.js';
import type { EventBus } from '../events/event-bus.js';
import type { IExchangeClient } from '../exchange/types.js';
import { getLogger } from '../utils/logger.js';
import { bps } from '../utils/math.js';

const log = getLogger('UniverseManager');

/** Soft boost for liquid names — not a hard allowlist for scanning */
const LIQUID_BOOST = new Set(
  [
    'BTCUSDT',
    'ETHUSDT',
    'BNBUSDT',
    'SOLUSDT',
    'XRPUSDT',
    'DOGEUSDT',
    'ADAUSDT',
    'AVAXUSDT',
    'LINKUSDT',
    'DOTUSDT',
    'LTCUSDT',
    'BCHUSDT',
    'TRXUSDT',
    'ATOMUSDT',
    'NEARUSDT',
    'APTUSDT',
    'ARBUSDT',
    'OPUSDT',
    'SUIUSDT',
    'INJUSDT',
    'FILUSDT',
    'UNIUSDT',
    'LDOUSDT',
    'AAVEUSDT',
    'MKRUSDT',
  ].map((s) => s),
);

export interface UniverseFilters {
  minDailyVolumeUsdt: number;
  maxSpreadBps: number;
  universeSize: number;
  minListingAgeDays: number;
  quoteAsset?: string;
}

/**
 * Maintains tradable scan universe of 100–200 USDT pairs.
 * Micro mode still scans broadly; trade sizing enforces affordability later.
 */
export class UniverseManager {
  private symbols: string[] = [];
  private markets = new Map<string, MarketMeta>();
  private tickers = new Map<string, Ticker>();
  private refreshTimer?: ReturnType<typeof setInterval>;
  private readonly filters: UniverseFilters;
  private readonly preferred: Set<string>;

  constructor(
    private readonly exchange: IExchangeClient,
    private readonly eventBus: EventBus,
    private readonly config: AppConfig,
  ) {
    this.filters = {
      minDailyVolumeUsdt: config.scanner.minDailyVolumeUsdt,
      maxSpreadBps: config.scanner.maxSpreadBps,
      universeSize: config.scanner.universeSize,
      minListingAgeDays: config.scanner.minListingAgeDays,
      quoteAsset: 'USDT',
    };
    this.preferred = new Set(
      (config.derivatives.preferredSymbols ?? []).map((s) =>
        s.toUpperCase().replace(/[-_/]/g, ''),
      ),
    );
  }

  getSymbols(): string[] {
    return [...this.symbols];
  }

  getTicker(symbol: string): Ticker | undefined {
    return this.tickers.get(symbol) ?? this.tickers.get(symbol.toUpperCase());
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
    for (const t of tickers) {
      const key = t.symbol.toUpperCase().replace(/[-_/]/g, '');
      this.tickers.set(t.symbol, t);
      this.tickers.set(key, t);
    }

    const quote = this.filters.quoteAsset ?? 'USDT';
    const minAgeMs = this.filters.minListingAgeDays * 86_400_000;
    const now = Date.now();
    // Target 100–200 scan universe
    const targetSize = Math.min(200, Math.max(100, this.filters.universeSize));

    const candidates: Array<{ symbol: string; score: number }> = [];

    for (const m of markets) {
      if (m.status !== 'active') continue;
      if (!m.symbol.endsWith(quote) && m.quoteAsset !== quote && m.quoteAsset !== 'USDT') {
        continue;
      }
      if (m.listedAt && now - m.listedAt < minAgeMs) continue;

      const sym = m.symbol.toUpperCase().replace(/[-_/]/g, '');
      if (!sym.endsWith('USDT')) continue;

      const t = this.tickers.get(m.symbol) ?? this.tickers.get(sym);

      let vol = 0;
      let spread = 25;
      let last = 0;
      if (t) {
        last = t.lastPrice;
        vol = t.quoteVolume24h > 0 ? t.quoteVolume24h : t.volume24h * t.lastPrice;
        spread = t.bid > 0 && t.ask > 0 ? bps(t.bid, t.ask) : 25;
      }

      // Soft volume filter — keep mid-caps for a wide scan
      const minVol = Math.min(this.filters.minDailyVolumeUsdt, 150_000);
      if (vol > 0 && vol < minVol) continue;
      // If no ticker volume at all, still include (rank low) so universe can fill 100–200
      if (spread > this.filters.maxSpreadBps && vol > 0) continue;
      if (last <= 0 && vol <= 0) {
        // allow without price — scanner will skip until candles warm
      }

      let score = (vol || 1) / (1 + spread);
      if (this.preferred.has(sym) || LIQUID_BOOST.has(sym)) score *= 1.35;
      candidates.push({ symbol: m.symbol, score });
    }

    candidates.sort((a, b) => b.score - a.score);
    this.symbols = candidates.slice(0, targetSize).map((c) => c.symbol);

    // Ensure preferred liquid names are always in the scan set
    for (const p of this.preferred) {
      if (this.symbols.includes(p)) continue;
      if (this.markets.has(p) || markets.some((m) => m.symbol === p)) {
        this.symbols.unshift(p);
      }
    }
    // Dedupe + re-cap
    this.symbols = [...new Set(this.symbols)].slice(0, targetSize);

    log.info(
      {
        universe: this.symbols.length,
        scanned: markets.length,
        candidates: candidates.length,
        targetSize,
        durationMs: Date.now() - start,
        top: this.symbols.slice(0, 10),
      },
      'Universe refreshed (wide scan)',
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
