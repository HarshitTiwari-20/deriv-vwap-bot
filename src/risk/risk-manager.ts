import type { AppConfig } from '../config/schema.js';
import { resolveLeverage } from '../config/index.js';
import type { EventBus } from '../events/event-bus.js';
import type {
  Position,
  PositionSizeResult,
  RiskLimits,
  RiskState,
} from '../types/trading.js';
import type { SetupSignal } from '../types/strategy.js';
import { getLogger } from '../utils/logger.js';

const log = getLogger('RiskManager');

/**
 * Leveraged derivatives position sizing + daily halt rules.
 *
 * Risk model:
 * - Risk $ = equity * riskPerTradePct%
 * - quantity = risk$ / stopDistance  (same as spot for R-multiple)
 * - margin ≈ notional / leverage
 * - Caps: max margin exposure % and max total notional vs equity
 */
export class RiskManager {
  private state: RiskState;
  private readonly limits: RiskLimits;
  private dayKey: string;

  constructor(
    private readonly config: AppConfig,
    private readonly eventBus: EventBus,
  ) {
    this.limits = {
      riskPerTradePct: config.risk.riskPerTradePct,
      maxDailyDrawdownPct: config.risk.maxDailyDrawdownPct,
      maxConsecutiveLosses: config.risk.maxConsecutiveLosses,
      maxOpenTrades: config.risk.maxOpenTrades,
      maxExposurePct: config.risk.maxExposurePct,
      maxNotionalToEquity: config.risk.maxNotionalToEquity,
      minConfidenceScore: config.risk.minConfidenceScore,
      minRiskReward: config.risk.minRiskReward,
    };
    const bal = config.risk.accountBalanceUsdt;
    this.state = {
      accountBalance: bal,
      equity: bal,
      openRisk: 0,
      openExposure: 0,
      openNotional: 0,
      dailyPnl: 0,
      dailyPnlPct: 0,
      consecutiveLosses: 0,
      consecutiveWins: 0,
      tradingHalted: false,
      openTradeCount: 0,
      winRate: 0,
      totalTrades: 0,
      maxDrawdownPct: 0,
      defaultLeverage: config.derivatives.leverage,
    };
    this.dayKey = this.utcDayKey();
  }

  getState(): RiskState {
    this.maybeRollDay();
    return { ...this.state };
  }

  getLimits(): RiskLimits {
    return { ...this.limits };
  }

  setBalance(balance: number): void {
    this.state.accountBalance = balance;
    this.state.equity = balance + this.state.dailyPnl;
  }

  setOpenTradeCount(
    n: number,
    openRisk: number,
    openMargin: number,
    openNotional = 0,
  ): void {
    this.state.openTradeCount = n;
    this.state.openRisk = openRisk;
    this.state.openExposure = openMargin;
    this.state.openNotional = openNotional;
  }

  private utcDayKey(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private maybeRollDay(): void {
    const key = this.utcDayKey();
    if (key !== this.dayKey) {
      log.info({ prev: this.dayKey, next: key }, 'New trading day — reset daily risk');
      this.dayKey = key;
      this.state.dailyPnl = 0;
      this.state.dailyPnlPct = 0;
      if (this.state.tradingHalted) {
        this.state.tradingHalted = false;
        this.state.haltReason = undefined;
        this.state.haltUntil = undefined;
        this.state.consecutiveLosses = 0;
        this.eventBus.emit('risk:resume', { state: this.getState() });
      }
    }
  }

  canOpenTrade(signal: SetupSignal): { allowed: boolean; reason?: string } {
    this.maybeRollDay();

    if (this.state.tradingHalted) {
      return { allowed: false, reason: this.state.haltReason ?? 'Trading halted' };
    }
    if (signal.confidence.total < this.limits.minConfidenceScore) {
      return {
        allowed: false,
        reason: `Confidence ${signal.confidence.total} < ${this.limits.minConfidenceScore}`,
      };
    }
    if (signal.riskReward < this.limits.minRiskReward) {
      return {
        allowed: false,
        reason: `RR ${signal.riskReward.toFixed(2)} < ${this.limits.minRiskReward}`,
      };
    }
    if (this.state.openTradeCount >= this.limits.maxOpenTrades) {
      return { allowed: false, reason: 'Max open trades reached' };
    }
    if (signal.expiresAt < Date.now()) {
      return { allowed: false, reason: 'Signal expired' };
    }
    return { allowed: true };
  }

  /**
   * Position size with custom leverage.
   * quantity = riskAmount / stopDistance
   * margin = (quantity * entry) / leverage
   */
  sizePosition(signal: SetupSignal, balance?: number, leverageOverride?: number): PositionSizeResult {
    const bal = balance ?? this.state.accountBalance;
    const leverage = Math.max(
      1,
      Math.floor(leverageOverride ?? resolveLeverage(this.config, signal.symbol)),
    );
    const riskAmount = bal * (this.limits.riskPerTradePct / 100);
    const stopDistance = Math.abs(signal.entry - signal.stopLoss);

    if (stopDistance <= 0) {
      return {
        quantity: 0,
        notional: 0,
        margin: 0,
        leverage,
        riskAmount: 0,
        stopDistance: 0,
        stopDistancePct: 0,
        allowed: false,
        reason: 'Invalid stop distance',
      };
    }

    let quantity = riskAmount / stopDistance;
    let notional = quantity * signal.entry;
    let margin = notional / leverage;

    // Cap by remaining margin budget
    const maxMargin = bal * (this.limits.maxExposurePct / 100);
    const remainingMargin = Math.max(0, maxMargin - this.state.openExposure);
    if (margin > remainingMargin) {
      margin = remainingMargin;
      notional = margin * leverage;
      quantity = notional / signal.entry;
    }

    // Cap total notional vs equity
    const maxNotional = bal * this.limits.maxNotionalToEquity;
    const remainingNotional = Math.max(0, maxNotional - this.state.openNotional);
    if (notional > remainingNotional) {
      notional = remainingNotional;
      quantity = notional / signal.entry;
      margin = notional / leverage;
    }

    if (notional < 5 || margin < 1) {
      return {
        quantity: 0,
        notional: 0,
        margin: 0,
        leverage,
        riskAmount,
        stopDistance,
        stopDistancePct: (stopDistance / signal.entry) * 100,
        allowed: false,
        reason: 'Size too small after leverage/exposure caps',
      };
    }

    const actualRisk = quantity * stopDistance;

    return {
      quantity,
      notional,
      margin,
      leverage,
      riskAmount: actualRisk,
      stopDistance,
      stopDistancePct: (stopDistance / signal.entry) * 100,
      allowed: true,
    };
  }

  onTradeClosed(pnl: number, _position: Position): void {
    this.maybeRollDay();
    this.state.dailyPnl += pnl;
    this.state.dailyPnlPct = (this.state.dailyPnl / this.state.accountBalance) * 100;
    this.state.accountBalance += pnl;
    this.state.equity = this.state.accountBalance;
    this.state.totalTrades += 1;

    if (pnl < 0) {
      this.state.consecutiveLosses += 1;
      this.state.consecutiveWins = 0;
    } else {
      this.state.consecutiveWins += 1;
      this.state.consecutiveLosses = 0;
    }

    if (this.state.dailyPnlPct < 0) {
      this.state.maxDrawdownPct = Math.max(
        this.state.maxDrawdownPct,
        Math.abs(this.state.dailyPnlPct),
      );
    }

    if (this.state.consecutiveLosses >= this.limits.maxConsecutiveLosses) {
      this.halt(
        `${this.state.consecutiveLosses} consecutive losses — halt until next day`,
      );
    }
    if (this.state.dailyPnlPct <= -this.limits.maxDailyDrawdownPct) {
      this.halt(
        `Daily drawdown ${this.state.dailyPnlPct.toFixed(2)}% exceeds limit`,
      );
    }
  }

  halt(reason: string): void {
    this.state.tradingHalted = true;
    this.state.haltReason = reason;
    const d = new Date();
    d.setUTCHours(24, 0, 0, 0);
    this.state.haltUntil = d.getTime();
    log.warn({ reason }, 'Trading HALTED');
    this.eventBus.emit('risk:halt', { state: this.getState(), reason });
  }

  updateStops(
    position: Position,
    lastPrice: number,
    atr: number,
  ): { stop: number; tp1Hit: boolean; tp2Hit: boolean; tp3Hit: boolean; close?: 'tp3' | 'sl' } {
    let stop = position.currentStop;
    let tp1Hit = position.tp1Hit;
    let tp2Hit = position.tp2Hit;
    let tp3Hit = position.tp3Hit;
    let close: 'tp3' | 'sl' | undefined;

    const isLong = position.side === 'buy';

    if (isLong && lastPrice <= stop) return { stop, tp1Hit, tp2Hit, tp3Hit, close: 'sl' };
    if (!isLong && lastPrice >= stop) return { stop, tp1Hit, tp2Hit, tp3Hit, close: 'sl' };

    if (!tp1Hit) {
      if (isLong && lastPrice >= position.takeProfit1) {
        tp1Hit = true;
        stop = position.entryPrice;
      }
      if (!isLong && lastPrice <= position.takeProfit1) {
        tp1Hit = true;
        stop = position.entryPrice;
      }
    }

    if (tp1Hit && !tp2Hit) {
      if (isLong && lastPrice >= position.takeProfit2) tp2Hit = true;
      if (!isLong && lastPrice <= position.takeProfit2) tp2Hit = true;
    }

    if (tp2Hit && atr > 0) {
      if (isLong) stop = Math.max(stop, lastPrice - atr * 1.5);
      else stop = Math.min(stop, lastPrice + atr * 1.5);
    }

    if (position.takeProfit3 !== undefined && !tp3Hit) {
      if (isLong && lastPrice >= position.takeProfit3) {
        tp3Hit = true;
        close = 'tp3';
      }
      if (!isLong && lastPrice <= position.takeProfit3) {
        tp3Hit = true;
        close = 'tp3';
      }
    }

    return { stop, tp1Hit, tp2Hit, tp3Hit, close };
  }
}
