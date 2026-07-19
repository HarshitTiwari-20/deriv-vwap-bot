import type { AppConfig } from '../config/schema.js';
import type { EventBus } from '../events/event-bus.js';
import type { Timeframe } from '../types/market.js';
import type { CoinRankResult } from '../types/strategy.js';
import { getLogger } from '../utils/logger.js';
import { bps } from '../utils/math.js';
import type { CandleStore } from './candle-store.js';
import type { UniverseManager } from './universe-manager.js';
import type { SignalGenerator } from '../strategy/execution/signal-generator.js';
import type { RankingEngine } from '../strategy/scoring/ranking-engine.js';

const log = getLogger('Scanner');

/**
 * Multi-coin scanner. Cycles through universe, runs strategy analysis,
 * ranks candidates. Target: full scan < 2s for warm in-memory candles.
 */
export class Scanner {
  private running = false;
  private timer?: ReturnType<typeof setInterval>;
  private lastRanked: CoinRankResult[] = [];
  private lastScanAt = 0;
  private readonly timeframes: Timeframe[];

  constructor(
    private readonly config: AppConfig,
    private readonly universe: UniverseManager,
    private readonly candles: CandleStore,
    private readonly signals: SignalGenerator,
    private readonly ranking: RankingEngine,
    private readonly eventBus: EventBus,
  ) {
    this.timeframes = [
      ...config.strategy.primaryTimeframes,
      ...config.strategy.confirmationTimeframes,
      config.strategy.trendTimeframe,
    ] as Timeframe[];
  }

  getLastRanked(): CoinRankResult[] {
    return this.lastRanked;
  }

  getLastScanAt(): number {
    return this.lastScanAt;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const cycle = this.config.scanner.scanCycleMs;
    this.timer = setInterval(() => {
      void this.scanCycle().catch((err) => log.error({ err }, 'Scan cycle failed'));
    }, cycle);
    void this.scanCycle();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
  }

  async scanCycle(): Promise<CoinRankResult[]> {
    const start = Date.now();
    const symbols = this.universe.getSymbols();
    if (symbols.length === 0) {
      log.debug('Empty universe — skip scan');
      return [];
    }

    const rankInputs: Parameters<RankingEngine['rank']>[0] = [];
    const topSignals: CoinRankResult[] = [];

    // Process in batches to keep event loop responsive
    const batchSize = 25;
    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize);
      for (const symbol of batch) {
        const ticker = this.universe.getTicker(symbol);
        const snap = this.candles.snapshot(symbol, this.timeframes);
        const lastPrice =
          ticker?.lastPrice ??
          snap[this.timeframes[0]!]?.slice(-1)[0]?.close ??
          0;
        if (lastPrice <= 0) continue;

        const spreadBps =
          ticker && ticker.bid > 0 && ticker.ask > 0
            ? bps(ticker.bid, ticker.ask)
            : 20;

        const result = this.signals.analyze({
          symbol,
          candles: snap,
          lastPrice,
          atr: 0,
          spreadBps,
          quoteVolume24h: ticker?.quoteVolume24h ?? 0,
          timestamp: Date.now(),
        });

        rankInputs.push({
          symbol,
          ...result.rankFactors,
          spreadBps,
          signal: result.signal,
        });

        if (result.signal) {
          this.eventBus.emit('signal:generated', { signal: result.signal });
        }
      }
      // Yield to event loop between batches
      if (i + batchSize < symbols.length) {
        await new Promise((r) => setImmediate(r));
      }
    }

    const ranked = this.ranking.rank(rankInputs, 10);
    this.lastRanked = ranked;
    this.lastScanAt = Date.now();
    const durationMs = this.lastScanAt - start;

    log.info(
      {
        symbols: symbols.length,
        durationMs,
        top: ranked.slice(0, 3).map((r) => `${r.symbol}:${r.score}`),
        signals: ranked.filter((r) => r.signal?.confidence.passed).length,
      },
      'Scan complete',
    );

    this.eventBus.emit('scan:complete', {
      ranked,
      durationMs,
      timestamp: this.lastScanAt,
    });

    return ranked;
  }
}
