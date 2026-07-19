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

  /** Sync equity from futures wallet when possible */
  async refreshBalance(): Promise<void> {
    try {
      const bals = await this.exchange.getBalances();
      const quote = this.config.derivatives.marginCurrency;
      const b = bals.find((x) => x.currency === quote) ?? bals.find((x) => x.currency === 'USDT');
      if (b) {
        const bal = b.total > 0 ? b.total : b.available;
        this.risk.setBalance(bal);
        log.info({ currency: b.currency, available: b.available, total: b.total }, 'Wallet balance');
      } else {
        log.warn({ currencies: bals.map((x) => x.currency) }, 'No USDT balance found in futures wallet');
      }
    } catch (err) {
      log.warn({ err }, 'Failed to refresh futures wallet balance');
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
      const sizing = this.risk.sizePosition(signal, undefined, leverage);
      if (!sizing.allowed || sizing.quantity <= 0) {
        this.eventBus.emit('signal:rejected', {
          signal,
          reason: sizing.reason ?? 'sizing failed',
        });
        return null;
      }

      const order = await this.exchange.placeOrder({
        symbol: signal.symbol,
        side: signal.side,
        type: 'market',
        quantity: sizing.quantity,
        leverage: sizing.leverage,
        stopLossPrice: signal.stopLoss,
        takeProfitPrice: signal.takeProfit2,
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
        },
        'Futures position opened',
      );
      return position;
    } catch (err) {
      log.error({ err, symbol: signal.symbol }, 'Failed to open futures position');
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

      const dir = pos.side === 'buy' ? 1 : -1;
      pos.unrealizedPnl = (price - pos.entryPrice) * pos.remainingQuantity * dir;
      pos.updatedAt = Date.now();

      const upd = this.risk.updateStops(pos, price, atr);
      pos.currentStop = upd.stop;
      pos.tp1Hit = upd.tp1Hit;
      pos.tp2Hit = upd.tp2Hit;
      pos.tp3Hit = upd.tp3Hit;

      if (upd.tp1Hit && pos.status === 'open' && pos.remainingQuantity === pos.quantity) {
        await this.partialClose(pos, 0.4, price, 'TP1');
      }
      if (upd.tp2Hit && pos.remainingQuantity > pos.quantity * 0.25) {
        const part = Math.min(pos.remainingQuantity, pos.quantity * 0.4);
        if (part > 0 && pos.remainingQuantity - part > 0) {
          await this.partialClose(pos, part / pos.remainingQuantity, price, 'TP2');
        }
      }

      if (upd.close === 'sl' || upd.close === 'tp3') {
        await this.closePosition(pos, price, upd.close === 'sl' ? 'Stop Loss' : 'TP3');
      } else {
        this.eventBus.emit('position:updated', { position: pos });
      }
    }
  }

  private async partialClose(
    pos: Position,
    fraction: number,
    price: number,
    reason: string,
  ): Promise<void> {
    const qty = pos.remainingQuantity * fraction;
    if (qty <= 0) return;
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
      const pnl = (fill - pos.entryPrice) * qty * dir - (order.fee ?? 0);
      pos.remainingQuantity -= qty;
      pos.realizedPnl += pnl;
      pos.fees += order.fee ?? 0;
      pos.notional = pos.entryPrice * pos.remainingQuantity;
      pos.marginUsed = pos.notional / pos.leverage;
      pos.status = 'partially_closed';
      pos.updatedAt = Date.now();
      log.info({ symbol: pos.symbol, qty, pnl, reason, leverage: pos.leverage }, 'Partial close');
      this.eventBus.emit('position:updated', { position: pos });
      this.syncRiskOpen();
    } catch (err) {
      log.error({ err, reason }, 'Partial close failed');
    }
  }

  async closePosition(
    pos: Position,
    price: number,
    exitReason: string,
  ): Promise<ClosedTrade | null> {
    try {
      // Prefer exchange exit_position API for full close
      if (
        pos.exchangePositionId &&
        this.exchange.exitFuturesPosition &&
        pos.remainingQuantity >= pos.quantity * 0.99
      ) {
        await this.exchange.exitFuturesPosition(pos.exchangePositionId);
      } else if (pos.remainingQuantity > 0) {
        const order = await this.exchange.placeOrder({
          symbol: pos.symbol,
          side: pos.side === 'buy' ? 'sell' : 'buy',
          type: 'market',
          quantity: pos.remainingQuantity,
          reduceOnly: true,
          leverage: pos.leverage,
          clientOrderId: clientOrderId(pos.symbol),
        });
        const fill = order.avgFillPrice && order.avgFillPrice > 0 ? order.avgFillPrice : price;
        const dir = pos.side === 'buy' ? 1 : -1;
        const pnl =
          (fill - pos.entryPrice) * pos.remainingQuantity * dir - (order.fee ?? 0);
        pos.realizedPnl += pnl;
        pos.fees += order.fee ?? 0;
        price = fill;
      }

      const riskPerUnit = Math.abs(pos.entryPrice - pos.stopLoss);
      const rMultiple =
        riskPerUnit > 0
          ? ((price - pos.entryPrice) * (pos.side === 'buy' ? 1 : -1)) / riskPerUnit
          : 0;

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
          r: trade.rMultiple,
          leverage: trade.leverage,
          exitReason,
        },
        'Futures position closed',
      );
      return trade;
    } catch (err) {
      log.error({ err, symbol: pos.symbol }, 'Close position failed');
      return null;
    }
  }
}
