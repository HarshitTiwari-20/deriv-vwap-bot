import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { AppConfig } from '../config/schema.js';
import { resolveLeverage } from '../config/index.js';
import type { EventBus } from '../events/event-bus.js';
import type {
  Position,
  PositionSizeResult,
  RiskLimits,
  RiskState,
  SizePositionOptions,
} from '../types/trading.js';
import type { SetupSignal } from '../types/strategy.js';
import { getLogger } from '../utils/logger.js';
import {
  computeAdaptiveProfile,
  type AdaptiveProfile,
} from './adaptive-limits.js';

const log = getLogger('RiskManager');

/** Soft risk halt duration (consecutive losses / daily DD). Kill switch is separate. */
const HALT_DURATION_MS = 30 * 60 * 1000;

interface DayPnlSnapshot {
  dayKey: string;
  dayStartBalance: number;
  realizedPnl: number;
  totalTrades: number;
}

/**
 * Leveraged derivatives position sizing + 30m soft halt + kill switch.
 *
 * INR-margin model (CoinDCX USDT-INR-M):
 * - Contract prices/notionals are in USDT
 * - Wallet / margin / risk budgets are in INR
 * - marginInr = notionalUsdt * usdtInr / leverage
 * - qty = riskInr / (stopUsdt * usdtInr)
 *
 * Micro mode: size toward exchange min lot; reject if SL risk exceeds hard cap.
 */
export class RiskManager {
  private state: RiskState;
  private limits: RiskLimits;
  private dayKey: string;
  private readonly marginCurrency: string;
  private readonly autoAdapt: boolean;
  private profile: AdaptiveProfile;
  private lastUsdtInr = 99;
  private tradesToday = 0;
  /** Wallet equity at UTC day start — daily PnL = equityNow - dayStartBalance */
  private dayStartBalance = 0;
  /** Sum of closed-trade PnL in margin currency (journal) */
  private realizedPnlToday = 0;
  private walletPrimed = false;
  private readonly dayPnlPath = resolve(process.cwd(), 'data', 'day-pnl.json');

  constructor(
    private readonly config: AppConfig,
    private readonly eventBus: EventBus,
  ) {
    this.marginCurrency = config.derivatives.marginCurrency;
    this.autoAdapt = config.risk.autoAdaptToBalance !== false;
    const bal = config.risk.accountBalanceUsdt;
    this.dayKey = this.utcDayKey();
    this.loadDaySnapshot(bal);
    this.profile = computeAdaptiveProfile({
      balance: bal,
      marginCurrency: this.marginCurrency,
      usdtInr: config.derivatives.usdtInrRate || 99,
      configLeverage: config.derivatives.leverage,
    });
    this.limits = this.limitsFromProfile(this.profile, config);
    this.state = {
      accountBalance: bal,
      equity: bal,
      openRisk: 0,
      openExposure: 0,
      openNotional: 0,
      dailyPnl: bal - this.dayStartBalance,
      dailyPnlPct:
        this.dayStartBalance > 0
          ? ((bal - this.dayStartBalance) / this.dayStartBalance) * 100
          : 0,
      consecutiveLosses: 0,
      consecutiveWins: 0,
      tradingHalted: false,
      killSwitchActive: false,
      openTradeCount: 0,
      winRate: 0,
      totalTrades: 0,
      maxDrawdownPct: 0,
      defaultLeverage: config.derivatives.leverage,
      marginCurrency: this.marginCurrency,
      sessionStartBalance: this.dayStartBalance || bal,
      capitalTier: this.profile.tier,
      capitalTierLabel: this.profile.label,
      adaptiveMaxOpenTrades: this.profile.maxOpenTrades,
      adaptiveEquityUsdt: this.profile.equityUsdt,
    };
    log.info(
      {
        autoAdapt: this.autoAdapt,
        tier: this.profile.tier,
        maxOpen: this.profile.maxOpenTrades,
        equityUsdt: this.profile.equityUsdt,
        dayStartBalance: this.dayStartBalance,
        dailyPnl: this.state.dailyPnl,
      },
      'Risk manager ready (balance-adaptive + daily PnL)',
    );
  }

  private loadDaySnapshot(fallbackBalance: number): void {
    try {
      if (existsSync(this.dayPnlPath)) {
        const snap = JSON.parse(readFileSync(this.dayPnlPath, 'utf8')) as DayPnlSnapshot;
        if (snap.dayKey === this.dayKey && snap.dayStartBalance > 0) {
          // Ignore corrupt / test leftovers (e.g. 10000 start with ₹40 wallet)
          const absurd =
            fallbackBalance > 0 &&
            (snap.dayStartBalance > fallbackBalance * 15 ||
              snap.dayStartBalance < fallbackBalance * 0.05);
          if (!absurd) {
            this.dayStartBalance = snap.dayStartBalance;
            this.realizedPnlToday = snap.realizedPnl ?? 0;
            this.tradesToday = snap.totalTrades ?? 0;
            return;
          }
          log.warn({ snap, fallbackBalance }, 'Ignoring invalid day-pnl snapshot');
        }
      }
    } catch (err) {
      log.debug({ err }, 'day-pnl load failed');
    }
    this.dayStartBalance = fallbackBalance > 0 ? fallbackBalance : 0;
    this.realizedPnlToday = 0;
    this.tradesToday = 0;
  }

  private persistDaySnapshot(): void {
    if (process.env.NODE_ENV === 'test' || process.env.SKIP_DAY_PNL_PERSIST === '1') return;
    try {
      mkdirSync(dirname(this.dayPnlPath), { recursive: true });
      const snap: DayPnlSnapshot = {
        dayKey: this.dayKey,
        dayStartBalance: this.dayStartBalance,
        realizedPnl: this.realizedPnlToday,
        totalTrades: this.tradesToday,
      };
      writeFileSync(this.dayPnlPath, JSON.stringify(snap, null, 2));
    } catch (err) {
      log.debug({ err }, 'day-pnl persist failed');
    }
  }

  private recomputeDailyPnl(equityNow: number, openUnrealized = 0): void {
    if (this.dayStartBalance <= 0 && equityNow > 0) {
      this.dayStartBalance = equityNow;
      this.persistDaySnapshot();
    }
    // Wallet equity already reflects open uPnL on CoinDCX futures; don't double-count
    this.state.dailyPnl = equityNow - this.dayStartBalance;
    this.state.dailyPnlPct =
      this.dayStartBalance > 0
        ? (this.state.dailyPnl / this.dayStartBalance) * 100
        : 0;
    this.state.sessionStartBalance = this.dayStartBalance;
    void openUnrealized;
  }

  private limitsFromProfile(p: AdaptiveProfile, config: AppConfig): RiskLimits {
    if (!this.autoAdapt) {
      return {
        riskPerTradePct: config.risk.riskPerTradePct,
        maxDailyDrawdownPct: config.risk.maxDailyDrawdownPct,
        maxConsecutiveLosses: config.risk.maxConsecutiveLosses,
        maxOpenTrades: config.risk.maxOpenTrades,
        maxExposurePct: config.risk.maxExposurePct,
        maxNotionalToEquity: config.risk.maxNotionalToEquity,
        minConfidenceScore: config.risk.minConfidenceScore,
        minRiskReward: config.risk.minRiskReward,
      };
    }
    return {
      riskPerTradePct: p.riskPerTradePct,
      maxDailyDrawdownPct: p.maxDailyDrawdownPct,
      maxConsecutiveLosses: p.maxConsecutiveLosses,
      maxOpenTrades: p.maxOpenTrades,
      maxExposurePct: p.maxExposurePct,
      maxNotionalToEquity: p.maxNotionalToEquity,
      minConfidenceScore: p.minConfidenceScore,
      minRiskReward: p.minRiskReward,
    };
  }

  /** Live adaptive profile (tier, open-trade cap, TP style, …) */
  getProfile(): AdaptiveProfile {
    return this.profile;
  }

  isMicroMode(): boolean {
    return this.autoAdapt ? this.profile.isMicro : this.config.derivatives.microAccountMode === true;
  }

  getState(): RiskState {
    this.maybeRollDay();
    this.maybeClearExpiredHalt();
    return {
      ...this.state,
      capitalTier: this.profile.tier,
      capitalTierLabel: this.profile.label,
      adaptiveMaxOpenTrades: this.limits.maxOpenTrades,
      adaptiveEquityUsdt: this.profile.equityUsdt,
      defaultLeverage: Math.min(
        this.config.derivatives.leverage,
        this.profile.leverageCap,
      ),
    };
  }

  getLimits(): RiskLimits {
    return { ...this.limits };
  }

  /**
   * Update equity from futures wallet (source of truth).
   * Daily PnL = walletNow − dayStartBalance (persisted across restarts).
   */
  setBalance(balance: number, usdtInr?: number, openUnrealized = 0): void {
    this.maybeRollDay(balance);
    if (usdtInr && usdtInr > 0) this.lastUsdtInr = usdtInr;

    const prev = this.state.accountBalance;
    // Deposit / withdrawal (only after first successful wallet poll)
    if (this.walletPrimed && prev > 0 && this.dayStartBalance > 0) {
      const jump = balance - prev;
      const threshold = Math.max(
        this.dayStartBalance * 0.08,
        this.marginCurrency === 'INR' ? 20 : 0.5,
      );
      if (Math.abs(jump) >= threshold) {
        this.dayStartBalance += jump;
        this.persistDaySnapshot();
        log.info(
          { jump, dayStartBalance: this.dayStartBalance, balance },
          'Adjusted day-start for deposit/withdrawal',
        );
      }
    }

    this.state.accountBalance = balance;
    this.state.equity = balance + openUnrealized;
    // First wallet read of the day: lock day-start baseline
    if (this.dayStartBalance <= 0 && balance > 0) {
      this.dayStartBalance = balance;
      this.persistDaySnapshot();
    }
    // First live wallet read of process: if no valid snapshot, start day here
    if (!this.walletPrimed && balance > 0) {
      if (this.dayStartBalance <= 0 || this.dayStartBalance === this.config.risk.accountBalanceUsdt) {
        // Prefer live wallet over stale config default as day start
        this.dayStartBalance = balance;
        this.persistDaySnapshot();
      }
      this.walletPrimed = true;
    } else {
      this.walletPrimed = true;
    }
    this.recomputeDailyPnl(balance, openUnrealized);
    this.recomputeAdaptive(balance);
    if (this.state.dailyPnlPct < 0) {
      this.state.maxDrawdownPct = Math.max(
        this.state.maxDrawdownPct,
        Math.abs(this.state.dailyPnlPct),
      );
    }
  }

  /**
   * Seed day-start balance once at bot boot (only if no snapshot for today).
   */
  setSessionStartBalance(balance: number): void {
    if (!(balance > 0)) return;
    this.maybeRollDay(balance);
    if (this.dayStartBalance <= 0) {
      this.dayStartBalance = balance;
      this.state.sessionStartBalance = balance;
      this.persistDaySnapshot();
    }
    this.recomputeDailyPnl(this.state.accountBalance || balance);
  }

  getUsdtInr(): number {
    return this.lastUsdtInr;
  }

  /** Convert contract (USDT) PnL → margin currency units for journal */
  toMarginPnl(pnlUsdt: number): number {
    if (this.marginCurrency === 'INR') return pnlUsdt * this.lastUsdtInr;
    return pnlUsdt;
  }

  setUsdtInr(rate: number): void {
    if (rate > 0) {
      this.lastUsdtInr = rate;
      this.recomputeAdaptive(this.state.accountBalance);
    }
  }

  private recomputeAdaptive(balance: number): void {
    if (!this.autoAdapt) return;
    const next = computeAdaptiveProfile({
      balance,
      marginCurrency: this.marginCurrency,
      usdtInr: this.lastUsdtInr,
      configLeverage: this.config.derivatives.leverage,
    });
    const prevTier = this.profile.tier;
    const prevOpen = this.profile.maxOpenTrades;
    this.profile = next;
    this.limits = this.limitsFromProfile(next, this.config);
    this.state.capitalTier = next.tier;
    this.state.capitalTierLabel = next.label;
    this.state.adaptiveMaxOpenTrades = next.maxOpenTrades;
    this.state.adaptiveEquityUsdt = next.equityUsdt;
    if (prevTier !== next.tier || prevOpen !== next.maxOpenTrades) {
      log.info(
        {
          tier: next.tier,
          label: next.label,
          balance,
          equityUsdt: next.equityUsdt,
          maxOpenTrades: next.maxOpenTrades,
          maxTradesPerDay: next.maxTradesPerDay,
          maxExposurePct: next.maxExposurePct,
          maxRiskPerTradePct: next.maxRiskPerTradePct,
        },
        'Capital tier updated from wallet balance',
      );
    }
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

  private maybeRollDay(currentBalance?: number): void {
    const key = this.utcDayKey();
    if (key !== this.dayKey) {
      const bal = currentBalance ?? this.state.accountBalance;
      log.info(
        { prev: this.dayKey, next: key, dayStart: bal },
        'New trading day — reset daily PnL baseline',
      );
      this.dayKey = key;
      this.dayStartBalance = bal > 0 ? bal : this.dayStartBalance;
      this.realizedPnlToday = 0;
      this.tradesToday = 0;
      this.state.dailyPnl = 0;
      this.state.dailyPnlPct = 0;
      this.state.sessionStartBalance = this.dayStartBalance;
      this.persistDaySnapshot();
      if (this.state.tradingHalted && !this.state.killSwitchActive) {
        this.state.tradingHalted = false;
        this.state.haltReason = undefined;
        this.state.haltUntil = undefined;
        this.state.consecutiveLosses = 0;
        this.eventBus.emit('risk:resume', { state: this.getState() });
      } else if (this.state.tradingHalted && this.state.killSwitchActive) {
        this.state.consecutiveLosses = 0;
      }
    }
  }

  canOpenTrade(signal: SetupSignal): { allowed: boolean; reason?: string } {
    this.maybeRollDay();
    this.maybeClearExpiredHalt();

    if (this.state.killSwitchActive) {
      return {
        allowed: false,
        reason: this.state.killSwitchReason ?? 'Kill switch active',
      };
    }
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
      return {
        allowed: false,
        reason: `Max open trades reached (${this.limits.maxOpenTrades} for tier ${this.profile.tier})`,
      };
    }
    const maxDay = this.autoAdapt
      ? this.profile.maxTradesPerDay
      : this.config.risk.maxTradesPerDay;
    if (maxDay > 0 && this.tradesToday >= maxDay) {
      return { allowed: false, reason: `Max trades per day (${maxDay}) reached` };
    }
    if (signal.expiresAt < Date.now()) {
      return { allowed: false, reason: 'Signal expired' };
    }
    // Adaptive stop width: tighter on small capital, looser when funded
    if (this.isMicroMode() || this.autoAdapt) {
      const stopPct = (Math.abs(signal.entry - signal.stopLoss) / signal.entry) * 100;
      const maxStop = this.profile.maxStopPct;
      if (stopPct > maxStop + 0.05) {
        return {
          allowed: false,
          reason: `Stop ${stopPct.toFixed(2)}% too wide for ${this.profile.tier} tier (max ${maxStop}%)`,
        };
      }
    }
    return { allowed: true };
  }

  /**
   * Size position with correct INR↔USDT conversion when margin is INR.
   */
  sizePosition(
    signal: SetupSignal,
    balanceOrOpts?: number | SizePositionOptions,
    leverageOverrideLegacy?: number,
  ): PositionSizeResult {
    const opts: SizePositionOptions =
      typeof balanceOrOpts === 'object' && balanceOrOpts !== null
        ? balanceOrOpts
        : {
            balance: typeof balanceOrOpts === 'number' ? balanceOrOpts : undefined,
            leverageOverride: leverageOverrideLegacy,
          };

    const bal = opts.balance ?? this.state.accountBalance;
    const isInr = this.marginCurrency === 'INR';
    const usdtInr = isInr
      ? Math.max(1, opts.usdtInrRate ?? (this.config.derivatives.usdtInrRate || 99))
      : 1;

    let leverage = Math.max(
      1,
      Math.floor(opts.leverageOverride ?? resolveLeverage(this.config, signal.symbol)),
    );
    if (opts.maxLeverage && opts.maxLeverage > 0) {
      leverage = Math.min(leverage, Math.floor(opts.maxLeverage));
    }

    const stopDistance = Math.abs(signal.entry - signal.stopLoss);
    const stopDistancePct = signal.entry > 0 ? (stopDistance / signal.entry) * 100 : 0;

    const fail = (reason: string): PositionSizeResult => ({
      quantity: 0,
      notional: 0,
      margin: 0,
      leverage,
      riskAmount: 0,
      stopDistance,
      stopDistancePct,
      allowed: false,
      reason,
      usdtInrRate: usdtInr,
    });

    if (stopDistance <= 0 || !(bal > 0)) {
      return fail('Invalid stop distance or balance');
    }

    // Risk budget from adaptive tier (or static config)
    const riskPct = this.limits.riskPerTradePct;
    const hardRiskPct = this.autoAdapt
      ? this.profile.maxRiskPerTradePct
      : this.config.risk.maxRiskPerTradePct > 0
        ? this.config.risk.maxRiskPerTradePct
        : riskPct;
    const riskBudget = bal * (riskPct / 100);
    const hardRiskCap = bal * (hardRiskPct / 100);

    // Soft leverage cap by tier
    if (this.autoAdapt && leverage > this.profile.leverageCap) {
      leverage = this.profile.leverageCap;
    }

    // qty from risk: riskWallet = qty * stopUsdt * usdtInr
    let quantity = riskBudget / (stopDistance * usdtInr);
    let notionalUsdt = quantity * signal.entry;
    let marginWallet = (notionalUsdt * usdtInr) / leverage;

    // Cap by margin exposure budget
    const maxMargin = bal * (this.limits.maxExposurePct / 100);
    const remainingMargin = Math.max(0, maxMargin - this.state.openExposure);
    if (marginWallet > remainingMargin && remainingMargin > 0) {
      marginWallet = remainingMargin;
      notionalUsdt = (marginWallet * leverage) / usdtInr;
      quantity = notionalUsdt / signal.entry;
    }

    // Free balance buffer — micro needs room for exchange min-lot margin
    const freeFrac = this.isMicroMode() ? 0.96 : 0.95;
    const freeCap = bal * freeFrac - this.state.openExposure;
    if (marginWallet > freeCap && freeCap > 0) {
      marginWallet = freeCap;
      notionalUsdt = (marginWallet * leverage) / usdtInr;
      quantity = notionalUsdt / signal.entry;
    }

    // Cap qty so stop loss ≤ hard risk even before min-lot bump
    if (stopDistance > 0) {
      const maxQtyByRisk = hardRiskCap / (stopDistance * usdtInr);
      if (quantity > maxQtyByRisk) {
        quantity = maxQtyByRisk;
        notionalUsdt = quantity * signal.entry;
        marginWallet = (notionalUsdt * usdtInr) / leverage;
      }
    }

    // Cap notional vs equity (notional measured in wallet units: notionalUsdt * usdtInr)
    const notionalWallet = notionalUsdt * usdtInr;
    const maxNotionalWallet = bal * this.limits.maxNotionalToEquity;
    const remainingNotionalW = Math.max(0, maxNotionalWallet - this.state.openNotional * (isInr ? usdtInr : 1));
    // openNotional stored as USDT notional historically — keep USDT for notional caps internally
    const maxNotionalUsdt = (bal / usdtInr) * this.limits.maxNotionalToEquity;
    const remainingNotionalUsdt = Math.max(0, maxNotionalUsdt - this.state.openNotional);
    if (notionalUsdt > remainingNotionalUsdt) {
      notionalUsdt = remainingNotionalUsdt;
      quantity = notionalUsdt / signal.entry;
      marginWallet = (notionalUsdt * usdtInr) / leverage;
    }

    // Min-lot bump only if SL risk still within hard cap
    const minQty = opts.minQuantity && opts.minQuantity > 0 ? opts.minQuantity : 0;
    const step = opts.stepSize && opts.stepSize > 0 ? opts.stepSize : 0;
    const minNotionalUsdt = opts.minNotionalUsdt && opts.minNotionalUsdt > 0 ? opts.minNotionalUsdt : 5;

    if (
      this.isMicroMode() ||
      quantity * signal.entry < minNotionalUsdt ||
      (minQty > 0 && quantity < minQty)
    ) {
      let minLotQty = minQty > 0 ? minQty : minNotionalUsdt / signal.entry;
      if (quantity * signal.entry < minNotionalUsdt) {
        minLotQty = Math.max(minLotQty, minNotionalUsdt / signal.entry);
      }
      if (step > 0) {
        minLotQty = Math.ceil(minLotQty / step) * step;
        const prec = Math.max(0, (String(step).split('.')[1] ?? '').length);
        minLotQty = Number(minLotQty.toFixed(prec));
      }
      if (minLotQty > quantity) {
        const minNotional = minLotQty * signal.entry;
        const minMargin = (minNotional * usdtInr) / leverage;
        const minRisk = minLotQty * stopDistance * usdtInr;

        if (minMargin > freeCap || minMargin > remainingMargin) {
          return fail(
            `Min lot margin ${minMargin.toFixed(2)} ${this.marginCurrency} exceeds free budget`,
          );
        }
        // Prefer skip trade over oversized loss on min lot
        if (minRisk > hardRiskCap) {
          return fail(
            `Skip: min-lot loss risk ${minRisk.toFixed(2)} ${this.marginCurrency} > cap ${hardRiskCap.toFixed(2)} — wait for tighter stop`,
          );
        }
        quantity = minLotQty;
        notionalUsdt = minNotional;
        marginWallet = minMargin;
      }
    }

    // Round down to step for non-min path
    if (step > 0 && quantity > 0) {
      quantity = Math.floor(quantity / step) * step;
      const prec = Math.max(0, (String(step).split('.')[1] ?? '').length);
      quantity = Number(quantity.toFixed(prec));
      notionalUsdt = quantity * signal.entry;
      marginWallet = (notionalUsdt * usdtInr) / leverage;
    }

    const actualRisk = quantity * stopDistance * usdtInr;
    if (actualRisk > hardRiskCap + 1e-9) {
      return fail(
        `Risk ${actualRisk.toFixed(2)} exceeds hard cap ${hardRiskCap.toFixed(2)} ${this.marginCurrency}`,
      );
    }

    const minMarginFloor = isInr ? 5 : 0.5;
    if (quantity <= 0 || notionalUsdt < Math.min(minNotionalUsdt, 1) || marginWallet < minMarginFloor) {
      return fail(
        `Size too small (qty=${quantity}, margin=${marginWallet.toFixed(2)} ${this.marginCurrency})`,
      );
    }

    void notionalWallet;
    void remainingNotionalW;

    return {
      quantity,
      notional: notionalUsdt,
      margin: marginWallet,
      leverage,
      riskAmount: actualRisk,
      stopDistance,
      stopDistancePct,
      allowed: true,
      usdtInrRate: usdtInr,
    };
  }

  /**
   * Record a closed trade for streak / halt rules.
   * @param pnlMarginCurrency PnL in wallet currency (INR or USDT) — NOT raw USDT contract PnL
   * Wallet balance is NOT adjusted here; next setBalance() from exchange is truth for daily PnL.
   */
  onTradeClosed(pnlMarginCurrency: number, _position: Position): void {
    this.maybeRollDay();
    this.tradesToday += 1;
    this.realizedPnlToday += pnlMarginCurrency;
    this.state.totalTrades += 1;
    // Prefer wallet-based daily PnL; fall back to realized sum until next balance poll
    this.state.dailyPnl = this.realizedPnlToday;
    this.state.dailyPnlPct =
      (this.state.dailyPnl / Math.max(this.dayStartBalance, 1e-9)) * 100;
    this.persistDaySnapshot();

    if (pnlMarginCurrency < 0) {
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

    // Consecutive losses / daily DD — soft halt for 30 minutes (not rest of day)
    if (this.state.consecutiveLosses >= this.limits.maxConsecutiveLosses) {
      this.halt(
        `${this.state.consecutiveLosses} consecutive losses — halt 30m (${this.profile.tier})`,
      );
    }
    if (this.state.dailyPnlPct <= -this.limits.maxDailyDrawdownPct) {
      this.halt(
        `Daily drawdown ${this.state.dailyPnlPct.toFixed(2)}% exceeds ${this.limits.maxDailyDrawdownPct}% limit — halt 30m`,
      );
    }
  }

  /** Resume soft halt after haltUntil; kill switch never auto-clears here. */
  private maybeClearExpiredHalt(): void {
    if (
      !this.state.tradingHalted ||
      this.state.killSwitchActive ||
      this.state.haltUntil == null ||
      Date.now() < this.state.haltUntil
    ) {
      return;
    }
    log.info(
      { haltUntil: this.state.haltUntil, reason: this.state.haltReason },
      'Soft risk halt expired — trading resumed',
    );
    this.state.tradingHalted = false;
    this.state.haltReason = undefined;
    this.state.haltUntil = undefined;
    this.state.consecutiveLosses = 0;
    this.eventBus.emit('risk:resume', { state: this.getState() });
  }

  halt(reason: string): void {
    this.state.tradingHalted = true;
    this.state.haltReason = reason;
    this.state.haltUntil = Date.now() + HALT_DURATION_MS;
    log.warn({ reason, haltUntil: this.state.haltUntil }, 'Trading HALTED (30m)');
    this.eventBus.emit('risk:halt', { state: this.getState(), reason });
  }

  activateKillSwitch(reason = 'Manual kill switch'): void {
    this.state.killSwitchActive = true;
    this.state.killSwitchReason = reason;
    this.state.tradingHalted = true;
    this.state.haltReason = reason;
    this.state.haltUntil = undefined;
    log.error({ reason }, 'KILL SWITCH ACTIVATED');
    this.eventBus.emit('risk:kill_switch', {
      active: true,
      reason,
      state: this.getState(),
    });
    this.eventBus.emit('risk:halt', { state: this.getState(), reason });
  }

  resumeKillSwitch(): void {
    this.state.killSwitchActive = false;
    this.state.killSwitchReason = undefined;
    this.state.tradingHalted = false;
    this.state.haltReason = undefined;
    this.state.haltUntil = undefined;
    this.state.consecutiveLosses = 0;
    log.info('Kill switch cleared — trading resumed');
    this.eventBus.emit('risk:kill_switch', {
      active: false,
      state: this.getState(),
    });
    this.eventBus.emit('risk:resume', { state: this.getState() });
  }

  resume(): { ok: boolean; reason?: string } {
    if (this.state.killSwitchActive) {
      return { ok: false, reason: 'Kill switch is active — use resume kill switch' };
    }
    this.state.tradingHalted = false;
    this.state.haltReason = undefined;
    this.state.haltUntil = undefined;
    this.eventBus.emit('risk:resume', { state: this.getState() });
    return { ok: true };
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
    const micro = this.isMicroMode();
    const trailMult = micro ? 0.8 : 1.5;
    const riskUnit = Math.abs(position.entryPrice - position.stopLoss);
    const earlyBeR = this.profile.earlyBeR;

    if (isLong && lastPrice <= stop) return { stop, tp1Hit, tp2Hit, tp3Hit, close: 'sl' };
    if (!isLong && lastPrice >= stop) return { stop, tp1Hit, tp2Hit, tp3Hit, close: 'sl' };

    // Early BE: once price moves +earlyBeR in favor, lock entry
    if (riskUnit > 0) {
      const favor = isLong
        ? lastPrice - position.entryPrice
        : position.entryPrice - lastPrice;
      if (favor >= riskUnit * earlyBeR) {
        if (isLong) stop = Math.max(stop, position.entryPrice);
        else stop = Math.min(stop, position.entryPrice);
      }
    }

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
      if (micro && tp1Hit) {
        const lock = Math.abs(position.takeProfit1 - position.entryPrice) * 0.5;
        if (isLong) stop = Math.max(stop, position.entryPrice + lock);
        else stop = Math.min(stop, position.entryPrice - lock);
      }
    }

    if (tp2Hit && atr > 0) {
      if (isLong) stop = Math.max(stop, lastPrice - atr * trailMult);
      else stop = Math.min(stop, lastPrice + atr * trailMult);
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
