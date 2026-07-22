import type { EventBus } from '../events/event-bus.js';
import type { ClosedTrade, Position } from '../types/trading.js';
import type { SetupSignal } from '../types/strategy.js';
import type { RiskManager } from '../risk/risk-manager.js';
import type { IExchangeClient } from '../exchange/types.js';
import type { AppConfig } from '../config/schema.js';
import { resolveLeverage } from '../config/index.js';
import { shortId, clientOrderId } from '../utils/id.js';
import { getLogger } from '../utils/logger.js';

const log = getLogger('PortfolioManager');

export class PortfolioManager {
  private positions = new Map<string, Position>();
  private closed: ClosedTrade[] = [];
  private wins = 0;
  private losses = 0;
  /** Prevent double-entry while an open order is in flight */
  private opening = new Set<string>();
  /** Cooldown after a failed open so we don't spam the exchange every scan */
  private openFailUntil = new Map<string, number>();
  /** Avoid re-attaching exchange TP/SL every sync tick */
  private tpslAttached = new Set<string>();
  private managing = false;
  /** Prevent concurrent close/partial on the same position */
  private closing = new Set<string>();

  constructor(
    private readonly exchange: IExchangeClient,
    private readonly risk: RiskManager,
    private readonly eventBus: EventBus,
    private readonly config: AppConfig,
  ) {}

  getOpenPositions(): Position[] {
    return [...this.positions.values()].filter(
      (p) => p.status === 'open' || p.status === 'partially_closed',
    );
  }

  getClosedTrades(limit = 100): ClosedTrade[] {
    return this.closed.slice(-limit);
  }

  getPosition(symbol: string): Position | undefined {
    return this.getOpenPositions().find((p) => p.symbol === symbol);
  }

  getWinRate(): number {
    const t = this.wins + this.losses;
    return t === 0 ? 0 : (this.wins / t) * 100;
  }

  private syncRiskOpen(): void {
    const open = this.getOpenPositions();
    const openRisk = open.reduce((s, p) => s + p.riskAmount, 0);
    const openMargin = open.reduce((s, p) => s + p.marginUsed, 0);
    const openNotional = open.reduce((s, p) => s + p.notional, 0);
    this.risk.setOpenTradeCount(open.length, openRisk, openMargin, openNotional);
  }

  /** Sync equity from futures wallet when possible (INR or USDT margin). */
  async refreshBalance(): Promise<{ available: number; total: number; currency: string } | null> {
    try {
      const bals = await this.exchange.getBalances();
      const quote = this.config.derivatives.marginCurrency;
      const b =
        bals.find((x) => x.currency === quote) ??
        bals.find((x) => x.currency === 'INR') ??
        bals.find((x) => x.currency === 'USDT');
      if (b) {
        const bal = b.total > 0 ? b.total : b.available;
        // Pass USDTINR so capital tier unlocks multi-trade when INR funds grow
        let usdtInr: number | undefined;
        if (this.config.derivatives.marginCurrency === 'INR' && this.exchange.getUsdtInrRate) {
          try {
            usdtInr = await this.exchange.getUsdtInrRate();
          } catch {
            /* optional */
          }
        }
        this.risk.setBalance(bal, usdtInr);
        const profile = this.risk.getProfile();
        log.info(
          {
            currency: b.currency,
            available: b.available,
            total: b.total,
            tier: profile.tier,
            maxOpenTrades: profile.maxOpenTrades,
            equityUsdt: profile.equityUsdt,
          },
          'Futures wallet balance (auto-adapt tier)',
        );
        return { available: b.available, total: bal, currency: b.currency };
      }
      log.warn(
        { currencies: bals.map((x) => x.currency), want: quote },
        'No margin-currency balance found in futures wallet',
      );
      return null;
    } catch (err) {
      log.warn({ err }, 'Failed to refresh futures wallet balance');
      return null;
    }
  }

  /**
   * Pull open futures positions from the exchange into local portfolio.
   * Fixes dashboard showing 0 when CoinDCX already has open trades
   * (restart, manual open, or order filled before bot tracked it).
   */
  async syncExchangePositions(): Promise<{
    adopted: number;
    updated: number;
    closed: number;
  }> {
    if (!this.exchange.getFuturesPositions) {
      return { adopted: 0, updated: 0, closed: 0 };
    }

    let usdtInr = 1;
    if (this.config.derivatives.marginCurrency === 'INR' && this.exchange.getUsdtInrRate) {
      try {
        usdtInr = await this.exchange.getUsdtInrRate();
      } catch {
        usdtInr = this.config.derivatives.usdtInrRate || 99;
      }
    }

    let fps: import('../types/trading.js').FuturesPosition[] = [];
    try {
      fps = await this.exchange.getFuturesPositions();
    } catch (err) {
      log.warn({ err }, 'syncExchangePositions: failed to fetch');
      return { adopted: 0, updated: 0, closed: 0 };
    }

    const liveBySymbol = new Map(
      fps.filter((p) => p.size > 0 && p.side !== 'flat').map((p) => [p.symbol, p]),
    );

    let adopted = 0;
    let updated = 0;
    let closed = 0;

    // Update or drop local positions
    for (const pos of this.getOpenPositions()) {
      const live = liveBySymbol.get(pos.symbol);
      if (!live) {
        // Closed on exchange (TP/SL/manual) — record PnL in margin currency
        const mark = pos.entryPrice + (pos.unrealizedPnl !== 0 && pos.quantity
          ? pos.unrealizedPnl / pos.quantity / (pos.side === 'buy' ? 1 : -1)
          : 0);
        const exitPx = Number.isFinite(mark) && mark > 0 ? mark : pos.entryPrice;
        await this.finalizeExternalClose(pos, exitPx, 'Closed on exchange');
        closed += 1;
        continue;
      }

      const mark = live.markPrice > 0 ? live.markPrice : pos.entryPrice;
      const dir = live.side === 'buy' ? 1 : -1;
      pos.exchangePositionId = live.id || pos.exchangePositionId;
      pos.side = live.side === 'sell' ? 'sell' : 'buy';
      pos.entryPrice = live.entryPrice > 0 ? live.entryPrice : pos.entryPrice;
      pos.quantity = live.size;
      pos.remainingQuantity = live.size;
      pos.leverage = live.leverage || pos.leverage;
      pos.notional = pos.entryPrice * live.size;
      // lockedMargin from API is often USDT-notional margin; convert to wallet ccy for INR
      const marginUsdt =
        live.lockedMargin > 0 ? live.lockedMargin : pos.notional / Math.max(pos.leverage, 1);
      pos.marginUsed =
        this.config.derivatives.marginCurrency === 'INR' ? marginUsdt * usdtInr : marginUsdt;
      pos.unrealizedPnl = (mark - pos.entryPrice) * live.size * dir;
      if (live.stopLoss != null && live.stopLoss > 0) {
        pos.stopLoss = live.stopLoss;
        pos.currentStop = live.stopLoss;
      }
      if (live.takeProfit != null && live.takeProfit > 0) {
        pos.takeProfit1 = live.takeProfit;
      }
      pos.updatedAt = Date.now();
      updated += 1;
      liveBySymbol.delete(pos.symbol);
    }

    // Adopt exchange positions the bot does not know about
    for (const [symbol, live] of liveBySymbol) {
      if (live.side === 'flat' || live.size <= 0) continue;
      // Guard against double-adopt (e.g. concurrent sync ticks)
      if (this.getPosition(symbol)) continue;
      const side = live.side === 'sell' ? 'sell' : 'buy';
      const entry = live.entryPrice > 0 ? live.entryPrice : live.markPrice;
      const mark = live.markPrice > 0 ? live.markPrice : entry;
      const lev = live.leverage || this.config.derivatives.leverage;
      const notional = entry * live.size;
      const marginUsdt = live.lockedMargin > 0 ? live.lockedMargin : notional / Math.max(lev, 1);
      const marginUsed =
        this.config.derivatives.marginCurrency === 'INR' ? marginUsdt * usdtInr : marginUsdt;

      // Default protective stop: exchange SL, else ~halfway to liquidation, else 1%
      let stopLoss = live.stopLoss && live.stopLoss > 0 ? live.stopLoss : 0;
      if (!(stopLoss > 0)) {
        if (live.liquidationPrice > 0) {
          stopLoss =
            side === 'buy'
              ? entry - Math.abs(entry - live.liquidationPrice) * 0.5
              : entry + Math.abs(live.liquidationPrice - entry) * 0.5;
        } else {
          stopLoss = side === 'buy' ? entry * 0.99 : entry * 1.01;
        }
      }
      const tp1 =
        live.takeProfit && live.takeProfit > 0
          ? live.takeProfit
          : side === 'buy'
            ? entry + Math.abs(entry - stopLoss)
            : entry - Math.abs(entry - stopLoss);
      const tp2 =
        side === 'buy'
          ? entry + Math.abs(entry - stopLoss) * 2
          : entry - Math.abs(entry - stopLoss) * 2;

      const dir = side === 'buy' ? 1 : -1;
      const position: Position = {
        id: shortId('pos'),
        symbol,
        side,
        entryPrice: entry,
        quantity: live.size,
        remainingQuantity: live.size,
        stopLoss,
        takeProfit1: tp1,
        takeProfit2: tp2,
        tp1Hit: false,
        tp2Hit: false,
        tp3Hit: false,
        currentStop: stopLoss,
        riskAmount: Math.abs(entry - stopLoss) * live.size * (usdtInr > 1 ? usdtInr : 1),
        riskPct: this.risk.getLimits().riskPerTradePct,
        unrealizedPnl: (mark - entry) * live.size * dir,
        realizedPnl: 0,
        status: 'open',
        confidence: 0,
        reasons: ['Synced from exchange'],
        exchangePositionId: live.id,
        leverage: lev,
        marginUsed,
        notional,
        marginType: live.marginType || this.config.derivatives.marginType,
        openedAt: Date.now(),
        updatedAt: Date.now(),
        mode: 'live',
        fees: 0,
      };

      this.positions.set(position.id, position);
      adopted += 1;
      this.eventBus.emit('position:opened', { position });
      log.info(
        {
          symbol,
          side,
          entry,
          size: live.size,
          leverage: lev,
          margin: marginUsed,
          mark,
          unrealized: position.unrealizedPnl,
          exchangeId: live.id,
        },
        'Adopted open position from exchange',
      );
      // Attach exchange-native TP/SL so exits work even if bot restarts
      void this.ensureExchangeTpsl(position);
    }

    this.syncRiskOpen();
    // Ensure every open pos has exchange TP/SL once
    for (const pos of this.getOpenPositions()) {
      void this.ensureExchangeTpsl(pos);
    }
    if (adopted || updated || closed) {
      log.info({ adopted, updated, closed, open: this.getOpenPositions().length }, 'Position sync');
    }
    return { adopted, updated, closed };
  }

  /**
   * Record a position that disappeared on the exchange (hit TP/SL or manual close).
   */
  private async finalizeExternalClose(
    pos: Position,
    exitPrice: number,
    exitReason: string,
  ): Promise<void> {
    if (pos.status === 'closed') return;
    const dir = pos.side === 'buy' ? 1 : -1;
    const qty = pos.remainingQuantity > 0 ? pos.remainingQuantity : pos.quantity;
    const pnlUsdt = (exitPrice - pos.entryPrice) * qty * dir - pos.fees;
    const pnlMargin = this.risk.toMarginPnl(pnlUsdt);
    pos.realizedPnl = pnlMargin;
    pos.status = 'closed';
    pos.closedAt = Date.now();
    pos.remainingQuantity = 0;

    const riskPerUnit = Math.abs(pos.entryPrice - pos.stopLoss);
    const rMultiple =
      riskPerUnit > 0
        ? ((exitPrice - pos.entryPrice) * dir) / riskPerUnit
        : 0;

    const trade: ClosedTrade = {
      id: shortId('trd'),
      positionId: pos.id,
      symbol: pos.symbol,
      side: pos.side,
      entryPrice: pos.entryPrice,
      exitPrice,
      quantity: pos.quantity,
      pnl: pnlMargin,
      pnlPct: (pnlMargin / Math.max(pos.marginUsed, 1e-9)) * 100,
      rMultiple,
      fees: pos.fees,
      confidence: pos.confidence,
      reasons: pos.reasons,
      exitReason,
      leverage: pos.leverage,
      openedAt: pos.openedAt,
      closedAt: pos.closedAt,
      mode: 'live',
      holdMs: pos.closedAt - pos.openedAt,
    };
    this.closed.push(trade);
    if (trade.pnl >= 0) this.wins += 1;
    else this.losses += 1;
    this.positions.delete(pos.id);
    if (pos.exchangePositionId) this.tpslAttached.delete(pos.exchangePositionId);
    this.risk.onTradeClosed(pnlMargin, pos);
    this.syncRiskOpen();
    this.eventBus.emit('position:closed', { trade, position: pos });
    log.info(
      { symbol: pos.symbol, pnlMargin, pnlUsdt, exitReason, exitPrice },
      'Recorded external close for daily PnL',
    );
    // Refresh wallet so daily PnL uses exchange equity
    await this.refreshBalance();
  }

  /**
   * Best-effort exchange-side TP/SL (CoinDCX create_tpsl).
   * Software management remains the backup.
   */
  async ensureExchangeTpsl(pos: Position): Promise<void> {
    if (!pos.exchangePositionId || !this.exchange.createPositionTpsl) return;
    if (this.tpslAttached.has(pos.exchangePositionId)) return;
    try {
      await this.exchange.createPositionTpsl(pos.exchangePositionId, {
        symbol: pos.symbol,
        stopLoss: pos.currentStop || pos.stopLoss,
        takeProfit: pos.takeProfit1,
      });
      this.tpslAttached.add(pos.exchangePositionId);
    } catch (err) {
      log.warn(
        { err, symbol: pos.symbol, id: pos.exchangePositionId },
        'Failed to attach exchange TP/SL — software exits still active',
      );
    }
  }

  /**
   * Close every open position at market (kill switch / emergency flat).
   */
  async closeAllPositions(reason = 'Kill switch'): Promise<{ closed: number; failed: number }> {
    const open = this.getOpenPositions();
    let closed = 0;
    let failed = 0;
    for (const pos of open) {
      const mark =
        pos.entryPrice +
        (pos.unrealizedPnl !== 0 && pos.remainingQuantity > 0
          ? pos.unrealizedPnl / pos.remainingQuantity / (pos.side === 'buy' ? 1 : -1)
          : 0);
      const price = Number.isFinite(mark) && mark > 0 ? mark : pos.entryPrice;
      const trade = await this.closePosition(pos, price, reason);
      if (trade) closed += 1;
      else failed += 1;
    }
    return { closed, failed };
  }

  /**
   * Bank free futures wallet funds to spot (redeem profits).
   *
   * Transfers min(available free balance, realized session profit above reserve).
   * Open positions' locked margin is never transferred (exchange available excludes it).
   */
  async redeemProfits(opts?: {
    /** Keep at least this much free in futures wallet (default: session start or 0) */
    keepBalance?: number;
    /** If true, transfer all free available above keepBalance */
    allFree?: boolean;
  }): Promise<{
    ok: boolean;
    amount: number;
    currency: string;
    message: string;
    availableBefore: number;
  }> {
    const bal = await this.refreshBalance();
    if (!bal) {
      return {
        ok: false,
        amount: 0,
        currency: this.config.derivatives.marginCurrency,
        message: 'Could not read futures wallet balance',
        availableBefore: 0,
      };
    }

    const currency = bal.currency;
    const availableBefore = bal.available;
    const risk = this.risk.getState();
    const sessionStart = risk.sessionStartBalance > 0 ? risk.sessionStartBalance : bal.total;

    // Locked margin is never in `available`. We only move free cash.
    // Default: bank realized session profit (wallet growth vs session start).
    // allFree: bank everything free above optional keepBalance.
    const keep = opts?.keepBalance !== undefined ? Math.max(0, opts.keepBalance) : 0;
    const freeAfterKeep = Math.max(0, availableBefore - keep);
    const sessionProfit = Math.max(0, bal.total - sessionStart);

    let transferable = opts?.allFree
      ? freeAfterKeep
      : Math.min(freeAfterKeep, sessionProfit > 0 ? sessionProfit : 0);

    // Dust floor
    const minTransfer = currency === 'INR' ? 1 : 0.1;
    if (transferable < minTransfer) {
      return {
        ok: false,
        amount: 0,
        currency,
        message: `Nothing to redeem (available ${availableBefore.toFixed(2)} ${currency}, session PnL ${sessionProfit.toFixed(2)}, keep ${keep.toFixed(2)})`,
        availableBefore,
      };
    }

    if (!this.exchange.transferFuturesWallet) {
      return {
        ok: false,
        amount: 0,
        currency,
        message: 'Wallet transfer not supported on this exchange',
        availableBefore,
      };
    }

    try {
      const result = await this.exchange.transferFuturesWallet(
        'withdraw',
        transferable,
        currency,
      );
      await this.refreshBalance();
      this.eventBus.emit('wallet:redeem', {
        amount: result.amount,
        currency: result.currency,
        availableBefore,
      });
      log.info(
        { amount: result.amount, currency: result.currency, availableBefore },
        'Profits redeemed to spot wallet',
      );
      return {
        ok: true,
        amount: result.amount,
        currency: result.currency,
        message: `Transferred ${result.amount} ${result.currency} futures → spot`,
        availableBefore,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err }, 'Redeem profits failed');
      return {
        ok: false,
        amount: 0,
        currency,
        message: msg,
        availableBefore,
      };
    }
  }

  async tryOpenFromSignal(signal: SetupSignal): Promise<Position | null> {
    if (this.opening.has(signal.symbol) || this.getPosition(signal.symbol)) {
      this.eventBus.emit('signal:rejected', {
        signal,
        reason: 'Already in position / opening',
      });
      return null;
    }
    const failUntil = this.openFailUntil.get(signal.symbol) ?? 0;
    if (failUntil > Date.now()) {
      this.eventBus.emit('signal:rejected', {
        signal,
        reason: `Open cooldown after failure (${Math.ceil((failUntil - Date.now()) / 1000)}s)`,
      });
      return null;
    }
    this.opening.add(signal.symbol);

    try {
      await this.refreshBalance();

      const gate = this.risk.canOpenTrade(signal);
      if (!gate.allowed) {
        this.eventBus.emit('signal:rejected', { signal, reason: gate.reason ?? 'risk' });
        log.info({ symbol: signal.symbol, reason: gate.reason }, 'Signal rejected');
        return null;
      }

      const leverage = resolveLeverage(this.config, signal.symbol);
      let usdtInr = 1;
      if (this.config.derivatives.marginCurrency === 'INR') {
        usdtInr = this.exchange.getUsdtInrRate
          ? await this.exchange.getUsdtInrRate()
          : this.config.derivatives.usdtInrRate || 99;
      }

      let minQuantity: number | undefined;
      let stepSize: number | undefined;
      let minNotionalUsdt: number | undefined;
      let maxLeverage: number | undefined;
      if (this.exchange.getInstrument) {
        try {
          const inst = await this.exchange.getInstrument(signal.symbol);
          if (inst) {
            minQuantity = inst.minTradeSize || inst.minQuantity;
            stepSize = inst.stepSize || inst.quantityIncrement;
            minNotionalUsdt = inst.minNotional > 0 ? inst.minNotional : 6;
            maxLeverage =
              signal.side === 'buy' ? inst.maxLeverageLong : inst.maxLeverageShort || inst.maxLeverageLong;
          }
        } catch {
          /* use defaults */
        }
      }

      const sizing = this.risk.sizePosition(signal, {
        leverageOverride: leverage,
        usdtInrRate: usdtInr,
        minQuantity,
        stepSize,
        minNotionalUsdt,
        maxLeverage,
      });
      if (!sizing.allowed || sizing.quantity <= 0) {
        this.eventBus.emit('signal:rejected', {
          signal,
          reason: sizing.reason ?? 'sizing failed',
        });
        log.info({ symbol: signal.symbol, reason: sizing.reason }, 'Sizing rejected');
        return null;
      }

      // Validate SL/TP sides before send (exchange is picky)
      const slOk =
        signal.side === 'buy'
          ? signal.stopLoss < signal.entry
          : signal.stopLoss > signal.entry;
      const tpOk =
        signal.side === 'buy'
          ? signal.takeProfit1 > signal.entry
          : signal.takeProfit1 < signal.entry;

      log.info(
        {
          symbol: signal.symbol,
          side: signal.side,
          qty: sizing.quantity,
          margin: sizing.margin,
          notionalUsdt: sizing.notional,
          leverage: sizing.leverage,
          risk: sizing.riskAmount,
          entry: signal.entry,
          sl: signal.stopLoss,
          tp: signal.takeProfit1,
          slOk,
          tpOk,
          usdtInr,
          conf: signal.confidence.total,
        },
        'Placing futures order',
      );

      const order = await this.exchange.placeOrder({
        symbol: signal.symbol,
        side: signal.side,
        type: 'market',
        quantity: sizing.quantity,
        leverage: sizing.leverage,
        // Only attach if sides are valid; client also retries without SL/TP on 422
        stopLossPrice: slOk ? signal.stopLoss : undefined,
        takeProfitPrice: tpOk ? signal.takeProfit1 : undefined,
        clientOrderId: clientOrderId(signal.symbol),
        marginType: this.config.derivatives.marginType,
      });

      this.eventBus.emit('order:created', { order });
      this.eventBus.emit('order:filled', { order });

      const fill = order.avgFillPrice && order.avgFillPrice > 0 ? order.avgFillPrice : signal.entry;
      const qty = order.filledQuantity > 0 ? order.filledQuantity : sizing.quantity;
      const notional = fill * qty;
      const usedLev = order.leverage ?? sizing.leverage;

      // Best-effort: attach exchange position id
      let exchangePositionId: string | undefined;
      if (this.exchange.getFuturesPositions) {
        try {
          const fps = await this.exchange.getFuturesPositions();
          const fp = fps.find((p) => p.symbol === signal.symbol && p.size > 0);
          exchangePositionId = fp?.id;
        } catch {
          /* ignore */
        }
      }

      const position: Position = {
        id: shortId('pos'),
        symbol: signal.symbol,
        side: signal.side,
        entryPrice: fill,
        quantity: qty,
        remainingQuantity: qty,
        stopLoss: signal.stopLoss,
        takeProfit1: signal.takeProfit1,
        takeProfit2: signal.takeProfit2,
        takeProfit3: signal.takeProfit3,
        tp1Hit: false,
        tp2Hit: false,
        tp3Hit: false,
        currentStop: signal.stopLoss,
        riskAmount: sizing.riskAmount,
        riskPct: this.risk.getLimits().riskPerTradePct,
        unrealizedPnl: 0,
        realizedPnl: 0,
        status: 'open',
        confidence: signal.confidence.total,
        reasons: signal.reasons,
        signalId: signal.id,
        entryOrderId: order.id,
        exchangePositionId,
        leverage: usedLev,
        marginUsed: notional / usedLev,
        notional,
        marginType: this.config.derivatives.marginType,
        openedAt: Date.now(),
        updatedAt: Date.now(),
        mode: 'live',
        fees: order.fee ?? 0,
      };

      this.positions.set(position.id, position);
      this.syncRiskOpen();
      this.eventBus.emit('position:opened', { position });
      log.info(
        {
          symbol: position.symbol,
          side: position.side,
          entry: position.entryPrice,
          qty: position.quantity,
          leverage: position.leverage,
          margin: position.marginUsed,
          conf: position.confidence,
          sl: position.stopLoss,
          tp1: position.takeProfit1,
          tp2: position.takeProfit2,
        },
        'Futures position opened',
      );
      void this.ensureExchangeTpsl(position);
      this.openFailUntil.delete(signal.symbol);
      return position;
    } catch (err) {
      // 90s cooldown so scan loop doesn't hammer CoinDCX with the same bad order
      this.openFailUntil.set(signal.symbol, Date.now() + 90_000);
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err, symbol: signal.symbol, msg }, 'Failed to open futures position');
      this.eventBus.emit('signal:rejected', {
        signal,
        reason: msg.slice(0, 200),
      });
      this.eventBus.emit('system:error', {
        context: 'portfolio.open',
        error: err instanceof Error ? err : new Error(String(err)),
      });
      return null;
    } finally {
      this.opening.delete(signal.symbol);
    }
  }

  async onPrice(symbol: string, price: number, atr: number): Promise<void> {
    for (const pos of this.getOpenPositions()) {
      if (pos.symbol !== symbol) continue;
      await this.managePositionAtPrice(pos, price, atr);
    }
  }

  /**
   * Active trade management: SL / TP1 / TP2 / trail using live mark price.
   * Called from tickers, candles, and the dedicated position manager loop.
   */
  private async managePositionAtPrice(
    pos: Position,
    price: number,
    atr: number,
  ): Promise<void> {
    if (!(price > 0)) return;
    if (pos.status !== 'open' && pos.status !== 'partially_closed') return;
    if (this.closing.has(pos.id)) return;

    const dir = pos.side === 'buy' ? 1 : -1;
    pos.unrealizedPnl = (price - pos.entryPrice) * pos.remainingQuantity * dir;
    pos.updatedAt = Date.now();

    // Hard SL check first (don't wait for updateStops edge cases)
    // Use small buffer so mark noise doesn't false-trigger
    const slBuf = Math.max(price * 0.0002, 1e-8);
    if (pos.side === 'buy' && price <= pos.currentStop - slBuf) {
      await this.closePosition(pos, price, 'Stop Loss');
      return;
    }
    if (pos.side === 'sell' && price >= pos.currentStop + slBuf) {
      await this.closePosition(pos, price, 'Stop Loss');
      return;
    }

    const upd = this.risk.updateStops(pos, price, atr);
    pos.currentStop = upd.stop;
    pos.tp1Hit = upd.tp1Hit;
    pos.tp2Hit = upd.tp2Hit;
    pos.tp3Hit = upd.tp3Hit;

    // Small capital: full exit at TP1; larger wallets take partials
    const profile = this.risk.getProfile();
    const fullTp1 = profile.fullExitAtTp1 || this.risk.isMicroMode();
    const tp1Frac = fullTp1 ? 1.0 : 0.4;

    if (upd.tp1Hit && pos.status === 'open' && pos.remainingQuantity === pos.quantity) {
      if (fullTp1 || tp1Frac >= 0.99) {
        log.info(
          { symbol: pos.symbol, price, tp1: pos.takeProfit1, tier: profile.tier },
          'TP1 hit — full exit',
        );
        await this.closePosition(pos, price, 'TP1');
        return;
      }
      log.info(
        { symbol: pos.symbol, price, tp1: pos.takeProfit1, frac: tp1Frac },
        'TP1 hit — partial take profit',
      );
      await this.partialClose(pos, tp1Frac, price, 'TP1');
      if (pos.exchangePositionId) this.tpslAttached.delete(pos.exchangePositionId);
      void this.ensureExchangeTpsl(pos);
    }

    if (upd.tp2Hit) {
      log.info(
        { symbol: pos.symbol, price, tp2: pos.takeProfit2 },
        'TP2 hit — full exit',
      );
      await this.closePosition(pos, price, 'TP2');
      return;
    }

    if (upd.close === 'sl' || upd.close === 'tp3') {
      await this.closePosition(pos, price, upd.close === 'sl' ? 'Stop Loss' : 'TP3');
      return;
    }

    this.eventBus.emit('position:updated', { position: pos });
  }

  /**
   * Dedicated manager tick: use exchange mark prices for every open trade
   * so SL/TP work even when the symbol is not in the scanner universe.
   */
  async manageOpenPositions(): Promise<void> {
    if (this.managing) return;
    const open = this.getOpenPositions();
    if (open.length === 0) return;
    this.managing = true;
    try {
      // Prefer live marks from exchange positions API
      const marks = new Map<string, number>();
      if (this.exchange.getFuturesPositions) {
        try {
          const fps = await this.exchange.getFuturesPositions();
          for (const fp of fps) {
            if (fp.markPrice > 0) marks.set(fp.symbol, fp.markPrice);
          }
        } catch {
          /* fall through to ticker */
        }
      }

      for (const pos of open) {
        let price = marks.get(pos.symbol) ?? 0;
        if (!(price > 0)) {
          try {
            const t = await this.exchange.getTicker(pos.symbol);
            price = t.lastPrice;
          } catch {
            /* skip this tick */
          }
        }
        if (!(price > 0)) continue;

        const atr = Math.max(Math.abs(pos.entryPrice - pos.stopLoss), pos.entryPrice * 0.005);
        await this.managePositionAtPrice(pos, price, atr);
      }
    } finally {
      this.managing = false;
    }
  }

  private async partialClose(
    pos: Position,
    fraction: number,
    price: number,
    reason: string,
  ): Promise<void> {
    if (this.closing.has(pos.id)) return;
    const qty = pos.remainingQuantity * fraction;
    if (qty <= 0) return;
    this.closing.add(pos.id);
    try {
      const order = await this.exchange.placeOrder({
        symbol: pos.symbol,
        side: pos.side === 'buy' ? 'sell' : 'buy',
        type: 'market',
        quantity: qty,
        reduceOnly: true,
        leverage: pos.leverage,
        clientOrderId: clientOrderId(pos.symbol),
      });
      const fill = order.avgFillPrice && order.avgFillPrice > 0 ? order.avgFillPrice : price;
      const dir = pos.side === 'buy' ? 1 : -1;
      const pnlUsdt = (fill - pos.entryPrice) * qty * dir - (order.fee ?? 0);
      const pnlMargin = this.risk.toMarginPnl(pnlUsdt);
      pos.remainingQuantity -= qty;
      pos.realizedPnl += pnlMargin;
      pos.fees += order.fee ?? 0;
      pos.notional = pos.entryPrice * pos.remainingQuantity;
      pos.marginUsed = pos.notional / pos.leverage;
      pos.status = 'partially_closed';
      pos.updatedAt = Date.now();
      // Daily PnL comes from wallet equity; don't double-count partial as full trade
      log.info(
        { symbol: pos.symbol, qty, pnlMargin, pnlUsdt, reason, leverage: pos.leverage },
        'Partial close',
      );
      this.eventBus.emit('position:updated', { position: pos });
      this.syncRiskOpen();
      await this.refreshBalance();
    } catch (err) {
      log.error({ err, reason }, 'Partial close failed');
    } finally {
      this.closing.delete(pos.id);
    }
  }

  async closePosition(
    pos: Position,
    price: number,
    exitReason: string,
  ): Promise<ClosedTrade | null> {
    if (this.closing.has(pos.id) || pos.status === 'closed') return null;
    this.closing.add(pos.id);
    try {
      log.info(
        {
          symbol: pos.symbol,
          side: pos.side,
          price,
          entry: pos.entryPrice,
          qty: pos.remainingQuantity,
          exitReason,
          sl: pos.currentStop,
          tp1: pos.takeProfit1,
        },
        'Closing futures position',
      );
      const dir = pos.side === 'buy' ? 1 : -1;
      const qtyLeft = pos.remainingQuantity;
      let pnlUsdt = 0;

      // Prefer exchange exit_position API for full close
      if (
        pos.exchangePositionId &&
        this.exchange.exitFuturesPosition &&
        qtyLeft >= pos.quantity * 0.99
      ) {
        await this.exchange.exitFuturesPosition(pos.exchangePositionId);
        pnlUsdt = (price - pos.entryPrice) * qtyLeft * dir;
      } else if (qtyLeft > 0) {
        const order = await this.exchange.placeOrder({
          symbol: pos.symbol,
          side: pos.side === 'buy' ? 'sell' : 'buy',
          type: 'market',
          quantity: qtyLeft,
          reduceOnly: true,
          leverage: pos.leverage,
          clientOrderId: clientOrderId(pos.symbol),
        });
        const fill = order.avgFillPrice && order.avgFillPrice > 0 ? order.avgFillPrice : price;
        pnlUsdt = (fill - pos.entryPrice) * qtyLeft * dir - (order.fee ?? 0);
        pos.fees += order.fee ?? 0;
        price = fill;
      }

      // Convert USDT contract PnL → INR/USDT wallet currency for journal + risk
      const pnlMargin = this.risk.toMarginPnl(pnlUsdt);
      pos.realizedPnl += pnlMargin;

      const riskPerUnit = Math.abs(pos.entryPrice - pos.stopLoss);
      const rMultiple =
        riskPerUnit > 0
          ? ((price - pos.entryPrice) * (pos.side === 'buy' ? 1 : -1)) / riskPerUnit
          : 0;

      if (pos.exchangePositionId) this.tpslAttached.delete(pos.exchangePositionId);

      pos.status = 'closed';
      pos.closedAt = Date.now();
      pos.remainingQuantity = 0;
      pos.rMultiple = rMultiple;

      const trade: ClosedTrade = {
        id: shortId('trd'),
        positionId: pos.id,
        symbol: pos.symbol,
        side: pos.side,
        entryPrice: pos.entryPrice,
        exitPrice: price,
        quantity: pos.quantity,
        pnl: pos.realizedPnl,
        pnlPct: (pos.realizedPnl / Math.max(pos.marginUsed, 1e-9)) * 100,
        rMultiple,
        fees: pos.fees,
        confidence: pos.confidence,
        reasons: pos.reasons,
        exitReason,
        leverage: pos.leverage,
        openedAt: pos.openedAt,
        closedAt: pos.closedAt,
        mode: 'live',
        holdMs: pos.closedAt - pos.openedAt,
      };

      this.closed.push(trade);
      if (trade.pnl >= 0) this.wins += 1;
      else this.losses += 1;

      this.positions.delete(pos.id);
      this.risk.onTradeClosed(trade.pnl, pos);
      this.syncRiskOpen();
      this.eventBus.emit('position:closed', { trade, position: pos });
      log.info(
        {
          symbol: trade.symbol,
          pnl: trade.pnl,
          pnlUsdt,
          currency: this.config.derivatives.marginCurrency,
          r: trade.rMultiple,
          leverage: trade.leverage,
          exitReason,
        },
        'Futures position closed',
      );
      // Wallet is source of truth for daily PnL display
      await this.refreshBalance();
      return trade;
    } catch (err) {
      log.error({ err, symbol: pos.symbol, exitReason }, 'Close position failed');
      return null;
    } finally {
      this.closing.delete(pos.id);
    }
  }
}
