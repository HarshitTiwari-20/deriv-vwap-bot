import type { AppConfig } from '../config/schema.js';
import type { Candle, Timeframe } from '../types/market.js';
import type { ClosedTrade, Position } from '../types/trading.js';
import type { SetupSignal } from '../types/strategy.js';
import { VwapEngine } from '../strategy/vwap/vwap-engine.js';
import { InstitutionalZoneDetector } from '../strategy/institutional/zone-detector.js';
import { MarketStructureEngine } from '../strategy/market-structure/structure-engine.js';
import { LiquidityDetector } from '../strategy/liquidity/liquidity-detector.js';
import { VolumeAnalyzer } from '../strategy/volume/volume-analyzer.js';
import { ScoringEngine } from '../strategy/scoring/scoring-engine.js';
import { SignalGenerator } from '../strategy/execution/signal-generator.js';
import { RiskManager } from '../risk/risk-manager.js';
import { EventBus } from '../events/event-bus.js';
import { shortId } from '../utils/id.js';
import { computeAtr } from '../indicators/atr.js';
import { computeMetrics, type PerformanceMetrics } from './metrics.js';
import { getLogger } from '../utils/logger.js';

const log = getLogger('BacktestEngine');

export interface BacktestConfig {
  symbol: string;
  primaryTf: Timeframe;
  initialCapital: number;
  feeBps: number;
  slippageBps: number;
}

export interface BacktestResult {
  trades: ClosedTrade[];
  metrics: PerformanceMetrics;
  signals: number;
  skipped: number;
}

/**
 * Historical candle replay engine.
 * Strict no look-ahead: at index i, only candles[0..i] (closed) are visible.
 */
export class BacktestEngine {
  constructor(private readonly appConfig: AppConfig) {}

  run(candles: Candle[], bt: BacktestConfig): BacktestResult {
    const series = [...candles]
      .filter((c) => c.symbol === bt.symbol || !c.symbol)
      .sort((a, b) => a.openTime - b.openTime)
      .map((c) => ({ ...c, symbol: bt.symbol, timeframe: bt.primaryTf, closed: true }));

    if (series.length < 50) {
      throw new Error('Need at least 50 candles for backtest');
    }

    const bus = new EventBus();
    const vwap = new VwapEngine();
    const zones = new InstitutionalZoneDetector({
      volumeMultiple: this.appConfig.strategy.institutionalVolumeMultiple,
    });
    const structure = new MarketStructureEngine({
      swingLeft: this.appConfig.strategy.swingLookback,
      swingRight: this.appConfig.strategy.swingLookback,
    });
    const liquidity = new LiquidityDetector({
      equalTolerancePct: this.appConfig.strategy.equalLevelTolerancePct,
    });
    const volume = new VolumeAnalyzer({
      smaPeriod: this.appConfig.strategy.volumeSmaPeriod,
    });
    const scoring = new ScoringEngine(vwap, this.appConfig);
    const signals = new SignalGenerator(
      vwap,
      zones,
      structure,
      liquidity,
      volume,
      scoring,
      this.appConfig,
    );
    const risk = new RiskManager(
      {
        ...this.appConfig,
        risk: { ...this.appConfig.risk, accountBalanceUsdt: bt.initialCapital },
      },
      bus,
    );

    const trades: ClosedTrade[] = [];
    let position: Position | null = null;
    let signalCount = 0;
    let skipped = 0;
    let equity = bt.initialCapital;
    const feeRate = bt.feeBps / 10_000;
    const slip = bt.slippageBps / 10_000;

    // Warm-up: start decisions after 100 bars
    const warm = 100;
    const trendTf = this.appConfig.strategy.trendTimeframe;

    for (let i = warm; i < series.length; i++) {
      // Only past + current closed bar (current is closed in replay)
      const window = series.slice(0, i + 1);
      const bar = window[window.length - 1]!;
      const price = bar.close;
      const atr = computeAtr(window, this.appConfig.strategy.atrPeriod) || price * 0.01;

      // Manage open position on this bar (use OHLC for stop/TP simulation without look-ahead within bar: conservative)
      if (position) {
        const exit = this.simulateBar(position, bar, atr, risk);
        if (exit) {
          const fill = exit.price * (position.side === 'buy' ? 1 - slip : 1 + slip);
          const dir = position.side === 'buy' ? 1 : -1;
          const pnl =
            (fill - position.entryPrice) * position.remainingQuantity * dir -
            fill * position.remainingQuantity * feeRate;
          equity += pnl;
          risk.setBalance(equity);
          const riskPerUnit = Math.abs(position.entryPrice - position.stopLoss);
          const rMultiple =
            riskPerUnit > 0
              ? ((fill - position.entryPrice) * dir) / riskPerUnit
              : 0;
          const trade: ClosedTrade = {
            id: shortId('bt'),
            positionId: position.id,
            symbol: bt.symbol,
            side: position.side,
            entryPrice: position.entryPrice,
            exitPrice: fill,
            quantity: position.quantity,
            pnl,
            pnlPct: (pnl / (position.entryPrice * position.quantity)) * 100,
            rMultiple,
            fees: fill * position.remainingQuantity * feeRate,
            confidence: position.confidence,
            reasons: position.reasons,
            exitReason: exit.reason,
            openedAt: position.openedAt,
            closedAt: bar.closeTime,
            mode: 'live',
            leverage: this.appConfig.derivatives.leverage,
            holdMs: bar.closeTime - position.openedAt,
          };
          trades.push(trade);
          risk.onTradeClosed(pnl, position);
          position = null;
        }
      }

      if (position) continue;

      // Build multi-TF approximation: downsample primary into higher TFs from same window
      const primaryTf = bt.primaryTf;
      const ctxCandles = {
        [primaryTf]: window,
        '3m': window,
        '5m': this.downsample(window, 5),
        '15m': this.downsample(window, 15),
        '1h': this.downsample(window, 60),
      } as Record<Timeframe, Candle[]>;

      zones.clear(bt.symbol);
      const result = signals.analyze({
        symbol: bt.symbol,
        candles: ctxCandles,
        lastPrice: price,
        atr,
        spreadBps: 5,
        quoteVolume24h: bar.quoteVolume * 24 * 60,
        timestamp: bar.closeTime,
      });

      if (!result.signal) continue;
      signalCount += 1;

      const gate = risk.canOpenTrade(result.signal);
      if (!gate.allowed) {
        skipped += 1;
        continue;
      }
      const sizing = risk.sizePosition(result.signal, equity);
      if (!sizing.allowed) {
        skipped += 1;
        continue;
      }

      const entry = result.signal.entry * (result.signal.side === 'buy' ? 1 + slip : 1 - slip);
      const fee = entry * sizing.quantity * feeRate;
      equity -= fee;

      const lev = sizing.leverage;
      position = {
        id: shortId('pos'),
        symbol: bt.symbol,
        side: result.signal.side,
        entryPrice: entry,
        quantity: sizing.quantity,
        remainingQuantity: sizing.quantity,
        stopLoss: result.signal.stopLoss,
        takeProfit1: result.signal.takeProfit1,
        takeProfit2: result.signal.takeProfit2,
        takeProfit3: result.signal.takeProfit3,
        tp1Hit: false,
        tp2Hit: false,
        tp3Hit: false,
        currentStop: result.signal.stopLoss,
        riskAmount: sizing.riskAmount,
        riskPct: this.appConfig.risk.riskPerTradePct,
        unrealizedPnl: 0,
        realizedPnl: 0,
        status: 'open',
        confidence: result.signal.confidence.total,
        reasons: result.signal.reasons,
        signalId: result.signal.id,
        openedAt: bar.closeTime,
        updatedAt: bar.closeTime,
        mode: 'live',
        leverage: lev,
        marginUsed: sizing.margin,
        notional: sizing.notional,
        marginType: this.appConfig.derivatives.marginType,
        fees: fee,
      };
      risk.setOpenTradeCount(1, sizing.riskAmount, sizing.margin, sizing.notional);
    }

    // Force close at end
    if (position) {
      const last = series[series.length - 1]!;
      const fill = last.close;
      const dir = position.side === 'buy' ? 1 : -1;
      const pnl = (fill - position.entryPrice) * position.remainingQuantity * dir;
      equity += pnl;
      trades.push({
        id: shortId('bt'),
        positionId: position.id,
        symbol: bt.symbol,
        side: position.side,
        entryPrice: position.entryPrice,
        exitPrice: fill,
        quantity: position.quantity,
        pnl,
        pnlPct: (pnl / (position.entryPrice * position.quantity)) * 100,
        rMultiple: 0,
        fees: 0,
        confidence: position.confidence,
        reasons: position.reasons,
        exitReason: 'EOD',
        openedAt: position.openedAt,
        closedAt: last.closeTime,
        mode: 'live',
        leverage: position.leverage,
        holdMs: last.closeTime - position.openedAt,
      });
    }

    const metrics = computeMetrics(trades, bt.initialCapital);
    log.info(
      {
        symbol: bt.symbol,
        trades: trades.length,
        signals: signalCount,
        winRate: metrics.winRate.toFixed(1),
        pnl: metrics.totalPnl.toFixed(2),
      },
      'Backtest complete',
    );

    return { trades, metrics, signals: signalCount, skipped };
  }

  /**
   * Walk-forward: train windows unused (rules-based), rolling OOS segments.
   */
  walkForward(
    candles: Candle[],
    bt: BacktestConfig,
    folds = 4,
  ): { folds: BacktestResult[]; combined: PerformanceMetrics } {
    const n = candles.length;
    const foldSize = Math.floor(n / folds);
    const results: BacktestResult[] = [];
    const allTrades: ClosedTrade[] = [];

    for (let f = 0; f < folds; f++) {
      // OOS segment only (no fitting) — pure walk-forward evaluation
      const start = f * foldSize;
      const end = f === folds - 1 ? n : (f + 1) * foldSize;
      // Include warm-up from prior bars without trading them
      const warmStart = Math.max(0, start - 120);
      const segment = candles.slice(warmStart, end);
      // Mark first (start-warmStart) as already "passed" by running full segment
      // but risk still applies; acceptable for rules-based strategy
      const res = this.run(segment, bt);
      results.push(res);
      allTrades.push(...res.trades);
    }

    return {
      folds: results,
      combined: computeMetrics(allTrades, bt.initialCapital),
    };
  }

  /**
   * Monte Carlo: shuffle trade returns order to stress equity path.
   */
  monteCarlo(trades: ClosedTrade[], initialCapital: number, runs = 500): {
    medianMaxDd: number;
    p5FinalEquity: number;
    p95FinalEquity: number;
    medianFinalEquity: number;
  } {
    if (trades.length === 0) {
      return {
        medianMaxDd: 0,
        p5FinalEquity: initialCapital,
        p95FinalEquity: initialCapital,
        medianFinalEquity: initialCapital,
      };
    }
    const pnls = trades.map((t) => t.pnl);
    const finals: number[] = [];
    const dds: number[] = [];

    for (let r = 0; r < runs; r++) {
      const shuffled = [...pnls];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      let eq = initialCapital;
      let peak = eq;
      let maxDd = 0;
      for (const p of shuffled) {
        eq += p;
        peak = Math.max(peak, eq);
        maxDd = Math.max(maxDd, peak > 0 ? ((peak - eq) / peak) * 100 : 0);
      }
      finals.push(eq);
      dds.push(maxDd);
    }

    finals.sort((a, b) => a - b);
    dds.sort((a, b) => a - b);
    const q = (arr: number[], p: number) => arr[Math.floor(p * (arr.length - 1))]!;

    return {
      medianMaxDd: q(dds, 0.5),
      p5FinalEquity: q(finals, 0.05),
      p95FinalEquity: q(finals, 0.95),
      medianFinalEquity: q(finals, 0.5),
    };
  }

  private simulateBar(
    position: Position,
    bar: Candle,
    atr: number,
    risk: RiskManager,
  ): { price: number; reason: string } | null {
    const isLong = position.side === 'buy';
    // Conservative path: check stop before TP within bar
    if (isLong) {
      if (bar.low <= position.currentStop) {
        return { price: position.currentStop, reason: 'Stop Loss' };
      }
      if (!position.tp1Hit && bar.high >= position.takeProfit1) {
        position.tp1Hit = true;
        position.currentStop = position.entryPrice;
      }
      if (position.tp1Hit && !position.tp2Hit && bar.high >= position.takeProfit2) {
        position.tp2Hit = true;
      }
      if (position.tp2Hit) {
        position.currentStop = Math.max(position.currentStop, bar.close - atr * 1.5);
      }
      if (position.takeProfit3 !== undefined && bar.high >= position.takeProfit3) {
        return { price: position.takeProfit3, reason: 'TP3' };
      }
      if (bar.low <= position.currentStop) {
        return { price: position.currentStop, reason: 'Stop Loss' };
      }
    } else {
      if (bar.high >= position.currentStop) {
        return { price: position.currentStop, reason: 'Stop Loss' };
      }
      if (!position.tp1Hit && bar.low <= position.takeProfit1) {
        position.tp1Hit = true;
        position.currentStop = position.entryPrice;
      }
      if (position.tp1Hit && !position.tp2Hit && bar.low <= position.takeProfit2) {
        position.tp2Hit = true;
      }
      if (position.tp2Hit) {
        position.currentStop = Math.min(position.currentStop, bar.close + atr * 1.5);
      }
      if (position.takeProfit3 !== undefined && bar.low <= position.takeProfit3) {
        return { price: position.takeProfit3, reason: 'TP3' };
      }
      if (bar.high >= position.currentStop) {
        return { price: position.currentStop, reason: 'Stop Loss' };
      }
    }
    // Update stops via risk helper on close
    const upd = risk.updateStops(position, bar.close, atr);
    position.currentStop = upd.stop;
    position.tp1Hit = upd.tp1Hit;
    position.tp2Hit = upd.tp2Hit;
    position.tp3Hit = upd.tp3Hit;
    return null;
  }

  /** Approximate higher TF by aggregating N 1m bars (if primary is 1m) */
  private downsample(candles: Candle[], factor: number): Candle[] {
    if (factor <= 1 || candles.length === 0) return candles;
    const out: Candle[] = [];
    for (let i = 0; i < candles.length; i += factor) {
      const chunk = candles.slice(i, i + factor);
      if (chunk.length === 0) continue;
      const first = chunk[0]!;
      const last = chunk[chunk.length - 1]!;
      out.push({
        symbol: first.symbol,
        timeframe: first.timeframe,
        openTime: first.openTime,
        closeTime: last.closeTime,
        open: first.open,
        high: Math.max(...chunk.map((c) => c.high)),
        low: Math.min(...chunk.map((c) => c.low)),
        close: last.close,
        volume: chunk.reduce((s, c) => s + c.volume, 0),
        quoteVolume: chunk.reduce((s, c) => s + c.quoteVolume, 0),
        closed: true,
      });
    }
    return out;
  }
}
