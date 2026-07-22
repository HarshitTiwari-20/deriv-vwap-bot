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
  private positionSyncTimer?: ReturnType<typeof setInterval>;
  private positionManageTimer?: ReturnType<typeof setInterval>;

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
    const bal = await this.portfolio.refreshBalance();
    if (bal) {
      this.risk.setSessionStartBalance(bal.total);
    }
    // Import any positions already open on CoinDCX (restart / manual / missed fill)
    await this.portfolio.syncExchangePositions();
    this.startPositionSync();

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
      () => this.risk.getProfile(),
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

    // Fast path: warm primary TF for all pairs so scanner can start in ~30–60s
    const primary = (this.config.strategy.primaryTimeframes[0] ?? '1m') as Timeframe;
    const confirmTfs = [
      ...this.config.strategy.confirmationTimeframes,
      this.config.strategy.trendTimeframe,
      ...this.config.strategy.primaryTimeframes.slice(1),
    ] as Timeframe[];

    log.info(
      { symbols: symbols.length, tf: primary },
      'Warming primary TF for full universe scan…',
    );
    const warmPrimary = await this.marketWs.warmCandles(symbols, 80, [primary]);
    for (const [sym, byTf] of warmPrimary) {
      for (const [tf, cs] of byTf) {
        this.candles.set(sym, tf, cs);
      }
    }

    this.startCandleRefresh(symbols);
    this.scanner.start();
    this.eventBus.emit('system:ready', {
      mode: this.config.exchange,
      timestamp: Date.now(),
    });
    log.info(
      {
        exchange: this.config.exchange,
        universe: symbols.length,
        minConfidence: this.config.risk.minConfidenceScore,
      },
      'Bot live — scanning universe (best-of-best execution). Background TF warm continues…',
    );

    // Background: warm remaining TFs without blocking API / first scans
    void (async () => {
      try {
        const extra = [...new Set(confirmTfs)];
        log.info({ symbols: symbols.length, tfs: extra }, 'Background multi-TF warm start');
        const warmRest = await this.marketWs.warmCandles(symbols, 80, extra);
        for (const [sym, byTf] of warmRest) {
          for (const [tf, cs] of byTf) {
            this.candles.set(sym, tf, cs);
          }
        }
        log.info({ symbols: symbols.length }, 'Background multi-TF warm complete');
      } catch (err) {
        log.warn({ err }, 'Background candle warm failed');
      }
    })();
  }

  /** Keep dashboard in sync with exchange open positions every 20s */
  private startPositionSync(): void {
    if (this.positionSyncTimer) clearInterval(this.positionSyncTimer);
    this.positionSyncTimer = setInterval(() => {
      void this.portfolio?.syncExchangePositions().catch((err) =>
        log.debug({ err }, 'position sync tick failed'),
      );
    }, 20_000);

    // Active SL/TP manager — every 3s using exchange mark prices
    if (this.positionManageTimer) clearInterval(this.positionManageTimer);
    this.positionManageTimer = setInterval(() => {
      void this.portfolio?.manageOpenPositions().catch((err) =>
        log.debug({ err }, 'position manage tick failed'),
      );
      // Ensure open symbols stay in market subscription set
      const openSyms = this.portfolio?.getOpenPositions().map((p) => p.symbol) ?? [];
      if (openSyms.length && this.marketWs) {
        this.marketWs.subscribe(openSyms);
      }
    }, 3_000);
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
    // Best-of-best: prefer indicator path + tight stops (affordable min-lot risk on micro)
    const candidates = ranked
      .filter((r) => r.signal?.confidence.passed)
      .sort((a, b) => {
        const sa = a.signal!;
        const sb = b.signal!;
        const indA = sa.reasons?.some((x) => x.includes('path:indicators')) ? 1 : 0;
        const indB = sb.reasons?.some((x) => x.includes('path:indicators')) ? 1 : 0;
        if (indB !== indA) return indB - indA;
        const stopA = Math.abs(sa.entry - sa.stopLoss) / Math.max(sa.entry, 1e-12);
        const stopB = Math.abs(sb.entry - sb.stopLoss) / Math.max(sb.entry, 1e-12);
        // Tighter stop first → lower min-lot INR risk
        if (Math.abs(stopA - stopB) > 0.0005) return stopA - stopB;
        const confDelta = (sb.confidence.total ?? 0) - (sa.confidence.total ?? 0);
        if (Math.abs(confDelta) > 1) return confDelta;
        return b.score - a.score;
      });

    if (candidates.length === 0) return;

    // Try up to top 12 so we skip pairs whose min margin / risk > wallet
    for (const c of candidates.slice(0, 12)) {
      if (!c.signal) continue;
      const stopPct =
        (Math.abs(c.signal.entry - c.signal.stopLoss) / Math.max(c.signal.entry, 1e-12)) * 100;
      log.info(
        {
          pick: c.symbol,
          rank: c.rank,
          score: c.score,
          conf: c.signal.confidence.total,
          side: c.signal.side,
          stopPct: Number(stopPct.toFixed(3)),
          pool: candidates.length,
          scanned: ranked.length,
          path: c.signal.reasons?.find((x) => x.startsWith('path:')) ?? '?',
        },
        'Best-of-best trade candidate',
      );
      const pos = await this.portfolio.tryOpenFromSignal(c.signal);
      if (pos) return;
    }
  }

  getStatus(): BotStatusSnapshot {
    const risk = this.risk?.getState() ?? {
      accountBalance: this.config.risk.accountBalanceUsdt,
      equity: this.config.risk.accountBalanceUsdt,
      openRisk: 0,
      openExposure: 0,
      openNotional: 0,
      dailyPnl: 0,
      dailyPnlPct: 0,
      consecutiveLosses: 0,
      consecutiveWins: 0,
      tradingHalted: false,
      killSwitchActive: false,
      openTradeCount: 0,
      winRate: 0,
      totalTrades: 0,
      maxDrawdownPct: 0,
      defaultLeverage: this.config.derivatives.leverage,
      marginCurrency: this.config.derivatives.marginCurrency,
      sessionStartBalance: this.config.risk.accountBalanceUsdt,
    };
    const ready = Boolean(this.scanner && this.portfolio && this.risk);
    return {
      mode: ready
        ? `${this.config.exchange} ${this.config.derivatives.marginCurrency}-M x${this.config.derivatives.leverage}`
        : `${this.config.exchange} starting…`,
      uptime: this.startedAt > 0 ? Date.now() - this.startedAt : 0,
      universeSize: this.universe?.getSymbols().length ?? 0,
      openPositions: this.portfolio?.getOpenPositions().length ?? 0,
      dailyPnl: risk.dailyPnl,
      winRate: this.portfolio?.getWinRate() ?? 0,
      tradingHalted: risk.tradingHalted || risk.killSwitchActive,
      killSwitchActive: risk.killSwitchActive,
      marginCurrency: this.config.derivatives.marginCurrency,
      leverage: this.config.derivatives.leverage,
      lastScanAt: this.scanner?.getLastScanAt(),
      lastScanDurationMs: this.scanner?.getLastScanDurationMs(),
      signalCount: (this.scanner?.getFullScan() ?? []).filter(
        (r) => r.signal?.confidence.passed,
      ).length,
      risk,
      topRanked: this.scanner?.getLastRanked() ?? [],
      scannedPairs: this.scanner?.getFullScan() ?? this.scanner?.getLastRanked() ?? [],
      openPositionsDetail: this.portfolio?.getOpenPositions() ?? [],
      recentTrades: this.portfolio?.getClosedTrades(20) ?? [],
      zones:
        this.universe && this.zones
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

  /**
   * Kill switch: halt all new trades, cancel open orders, flatten positions.
   */
  async killSwitch(reason = 'Manual kill switch'): Promise<{
    ok: boolean;
    closed: number;
    failed: number;
    ordersCancelled: boolean;
    message: string;
  }> {
    if (!this.risk || !this.portfolio) {
      return {
        ok: false,
        closed: 0,
        failed: 0,
        ordersCancelled: false,
        message: 'Bot not started',
      };
    }
    this.risk.activateKillSwitch(reason);
    let ordersCancelled = false;
    if (this.exchange?.cancelAllOpenOrders) {
      try {
        await this.exchange.cancelAllOpenOrders();
        ordersCancelled = true;
      } catch (err) {
        log.warn({ err }, 'cancelAllOpenOrders during kill switch failed');
      }
    }
    const { closed, failed } = await this.portfolio.closeAllPositions(reason);
    log.error({ reason, closed, failed, ordersCancelled }, 'Kill switch executed');
    return {
      ok: failed === 0,
      closed,
      failed,
      ordersCancelled,
      message: `Kill switch ON — closed ${closed} pos, ${failed} failed, orders cancelled=${ordersCancelled}`,
    };
  }

  /** Clear kill switch and allow trading again. */
  resumeTrading(): { ok: boolean; message: string } {
    if (!this.risk) return { ok: false, message: 'Bot not started' };
    this.risk.resumeKillSwitch();
    return { ok: true, message: 'Kill switch cleared — trading resumed' };
  }

  /**
   * Transfer free futures profits to spot wallet (CoinDCX INR/USDT-M).
   */
  async redeemProfits(opts?: {
    keepBalance?: number;
    allFree?: boolean;
  }): Promise<{
    ok: boolean;
    amount: number;
    currency: string;
    message: string;
  }> {
    if (!this.portfolio) {
      return {
        ok: false,
        amount: 0,
        currency: this.config.derivatives.marginCurrency,
        message: 'Bot not started',
      };
    }
    return this.portfolio.redeemProfits(opts);
  }

  async stop(): Promise<void> {
    log.info('Stopping bot…');
    this.scanner?.stop();
    this.universe?.stop();
    if (this.candleRefreshTimer) clearInterval(this.candleRefreshTimer);
    if (this.positionSyncTimer) clearInterval(this.positionSyncTimer);
    if (this.positionManageTimer) clearInterval(this.positionManageTimer);
    await this.marketWs?.stop();
  }
}
