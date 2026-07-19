import type { AppConfig } from '../config/schema.js';
import type { EventBus } from '../events/event-bus.js';
import type { BotStatusSnapshot } from '../types/events.js';
import type { Timeframe } from '../types/market.js';
import { createExchangeClient } from '../exchange/factory.js';
import type { IExchangeClient } from '../exchange/types.js';
import { MarketDataWs } from '../websocket/market-data-ws.js';
import { CandleStore } from '../scanner/candle-store.js';
import { UniverseManager } from '../scanner/universe-manager.js';
import { Scanner } from '../scanner/scanner.js';
import { VwapEngine } from '../strategy/vwap/vwap-engine.js';
import { InstitutionalZoneDetector } from '../strategy/institutional/zone-detector.js';
import { MarketStructureEngine } from '../strategy/market-structure/structure-engine.js';
import { LiquidityDetector } from '../strategy/liquidity/liquidity-detector.js';
import { VolumeAnalyzer } from '../strategy/volume/volume-analyzer.js';
import { ScoringEngine } from '../strategy/scoring/scoring-engine.js';
import { RankingEngine } from '../strategy/scoring/ranking-engine.js';
import { SignalGenerator } from '../strategy/execution/signal-generator.js';
import { RiskManager } from '../risk/risk-manager.js';
import { PortfolioManager } from '../portfolio/portfolio-manager.js';
import { AlertService } from '../alerts/alert-service.js';
import { computeAtr } from '../indicators/atr.js';
import { getLogger } from '../utils/logger.js';

const log = getLogger('BotOrchestrator');

/**
 * Live CoinDCX derivatives orchestrator (custom leverage).
 */
export class BotOrchestrator {
  private exchange!: IExchangeClient;
  private marketWs!: MarketDataWs;
  private candles!: CandleStore;
  private universe!: UniverseManager;
  private scanner!: Scanner;
  private portfolio!: PortfolioManager;
  private risk!: RiskManager;
  private alerts!: AlertService;
  private zones!: InstitutionalZoneDetector;
  private startedAt = 0;
  private candleRefreshTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly config: AppConfig,
    private readonly eventBus: EventBus,
  ) {}

  async start(): Promise<void> {
    this.startedAt = Date.now();
    log.info(
      {
        exchange: this.config.exchange,
        leverage: this.config.derivatives.leverage,
        marginType: this.config.derivatives.marginType,
        marginCurrency: this.config.derivatives.marginCurrency,
        allowShort: this.config.strategy.allowShort,
      },
      'Starting derivatives bot orchestrator',
    );

    this.exchange = createExchangeClient(this.config);
    this.candles = new CandleStore(500);
    this.risk = new RiskManager(this.config, this.eventBus);
    this.portfolio = new PortfolioManager(
      this.exchange,
      this.risk,
      this.eventBus,
      this.config,
    );
    await this.portfolio.refreshBalance();

    this.zones = new InstitutionalZoneDetector({
      volumeMultiple: this.config.strategy.institutionalVolumeMultiple,
      minBodyRatio: this.config.strategy.minBodyRatio,
      maxWickRatio: this.config.strategy.maxWickRatio,
      volumeSmaPeriod: this.config.strategy.volumeSmaPeriod,
    });

    const vwap = new VwapEngine();
    const structure = new MarketStructureEngine({
      swingLeft: this.config.strategy.swingLookback,
      swingRight: this.config.strategy.swingLookback,
    });
    const liquidity = new LiquidityDetector({
      equalTolerancePct: this.config.strategy.equalLevelTolerancePct,
    });
    const volume = new VolumeAnalyzer({
      smaPeriod: this.config.strategy.volumeSmaPeriod,
      spikeMultiple: 2.0,
    });
    const scoring = new ScoringEngine(vwap, this.config);
    const ranking = new RankingEngine();
    const signals = new SignalGenerator(
      vwap,
      this.zones,
      structure,
      liquidity,
      volume,
      scoring,
      this.config,
    );

    this.universe = new UniverseManager(this.exchange, this.eventBus, this.config);
    this.scanner = new Scanner(
      this.config,
      this.universe,
      this.candles,
      signals,
      ranking,
      this.eventBus,
    );

    this.alerts = new AlertService(this.config.alerts, this.eventBus);
    this.alerts.wire();

    const tfs: Timeframe[] = [
      ...this.config.strategy.primaryTimeframes,
      ...this.config.strategy.confirmationTimeframes,
      this.config.strategy.trendTimeframe,
    ] as Timeframe[];

    this.marketWs = new MarketDataWs(
      this.config,
      this.eventBus,
      () => this.exchange.getTickers(),
      (symbol, tf, limit) => this.exchange.getCandles(symbol, tf, limit),
    );
    this.marketWs.setTimeframes(tfs);

    this.eventBus.on('candle:update', ({ candle }) => {
      this.candles.upsert(candle);
    });
    this.eventBus.on('candle:closed', ({ candle }) => {
      this.candles.upsert(candle);
      const atr =
        computeAtr(this.candles.get(candle.symbol, candle.timeframe), 14) ||
        candle.close * 0.01;
      void this.portfolio.onPrice(candle.symbol, candle.close, atr);
    });
    this.eventBus.on('ticker:update', ({ ticker }) => {
      const primary = this.config.strategy.primaryTimeframes[0] ?? '1m';
      const atr =
        computeAtr(this.candles.get(ticker.symbol, primary as Timeframe), 14) ||
        ticker.lastPrice * 0.01;
      void this.portfolio.onPrice(ticker.symbol, ticker.lastPrice, atr);
    });

    this.eventBus.on('scan:complete', ({ ranked }) => {
      void this.handleRanked(ranked);
    });

    const symbols = await this.universe.refresh();
    this.universe.startAutoRefresh(this.config.scanner.universeRefreshMs);
    this.marketWs.subscribe(symbols);
    await this.marketWs.start();

    // Warm a lighter history for fast startup (enough for indicators)
    log.info({ symbols: symbols.length }, 'Warming futures candle history…');
    const warm = await this.marketWs.warmCandles(symbols, 120);
    for (const [sym, byTf] of warm) {
      for (const [tf, cs] of byTf) {
        this.candles.set(sym, tf, cs);
      }
    }

    // Keep 1m candles fresh from REST so volume/RVOL stay valid (WS tickers have no volume)
    this.startCandleRefresh(symbols);

    this.scanner.start();
    this.eventBus.emit('system:ready', {
      mode: this.config.exchange,
      timestamp: Date.now(),
    });
    log.info(
      {
        exchange: this.config.exchange,
        relaxedEntry: this.config.strategy.relaxedEntry,
        minConfidence: this.config.risk.minConfidenceScore,
      },
      'Derivatives bot is live',
    );
  }

  /**
   * Periodically re-pull primary-timeframe candles with real volume from the exchange.
   * Without this, ticker-built candles have volume=0 and the volume gate never passes.
   */
  private startCandleRefresh(symbols: string[]): void {
    if (this.candleRefreshTimer) clearInterval(this.candleRefreshTimer);
    const primary = (this.config.strategy.primaryTimeframes[0] ?? '1m') as Timeframe;
    const refresh = async () => {
      const list = this.universe.getSymbols();
      const batch = list.length ? list : symbols;
      let i = 0;
      const concurrency = 6;
      const run = async () => {
        while (i < batch.length) {
          const sym = batch[i++]!;
          try {
            const cs = await this.exchange.getCandles(sym, primary, 80);
            if (cs.length) this.candles.set(sym, primary, cs);
          } catch {
            /* ignore single-symbol failure */
          }
        }
      };
      await Promise.all(Array.from({ length: concurrency }, () => run()));
      log.debug({ n: batch.length, tf: primary }, 'REST candle refresh done');
    };
    void refresh();
    this.candleRefreshTimer = setInterval(() => {
      void refresh();
    }, 60_000);
  }

  private async handleRanked(
    ranked: import('../types/strategy.js').CoinRankResult[],
  ): Promise<void> {
    const candidates = ranked
      .filter((r) => r.signal?.confidence.passed)
      .sort((a, b) => b.score - a.score);

    if (candidates.length === 0) return;
    const top = candidates[0]!;
    if (!top.signal) return;
    await this.portfolio.tryOpenFromSignal(top.signal);
  }

  getStatus(): BotStatusSnapshot {
    const risk = this.risk.getState();
    return {
      mode: `${this.config.exchange} x${this.config.derivatives.leverage}`,
      uptime: Date.now() - this.startedAt,
      universeSize: this.universe?.getSymbols().length ?? 0,
      openPositions: this.portfolio?.getOpenPositions().length ?? 0,
      dailyPnl: risk.dailyPnl,
      winRate: this.portfolio?.getWinRate() ?? 0,
      tradingHalted: risk.tradingHalted,
      lastScanAt: this.scanner?.getLastScanAt(),
      risk,
      topRanked: this.scanner?.getLastRanked() ?? [],
      openPositionsDetail: this.portfolio?.getOpenPositions() ?? [],
      recentTrades: this.portfolio?.getClosedTrades(20) ?? [],
      zones: this.universe
        ? this.universe
            .getSymbols()
            .flatMap((s) => this.zones.getActiveZones(s))
            .slice(0, 50)
        : [],
      timeframes: [
        ...this.config.strategy.primaryTimeframes,
        ...this.config.strategy.confirmationTimeframes,
        this.config.strategy.trendTimeframe,
      ] as Timeframe[],
    };
  }

  async stop(): Promise<void> {
    log.info('Stopping bot…');
    this.scanner?.stop();
    this.universe?.stop();
    if (this.candleRefreshTimer) clearInterval(this.candleRefreshTimer);
    await this.marketWs?.stop();
  }
}
