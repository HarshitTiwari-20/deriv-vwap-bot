import type { PrismaClient } from '@prisma/client';
import type { ClosedTrade, Order, Position } from '../../types/trading.js';
import type { CoinRankResult, InstitutionalZone } from '../../types/strategy.js';

export class TradeRepository {
  constructor(private readonly db: PrismaClient) {}

  async saveOrder(order: Order): Promise<void> {
    await this.db.orderRecord.upsert({
      where: { id: order.id },
      create: {
        id: order.id,
        clientOrderId: order.clientOrderId,
        exchangeOrderId: order.exchangeOrderId,
        symbol: order.symbol,
        side: order.side,
        type: order.type,
        quantity: order.quantity,
        filledQuantity: order.filledQuantity,
        price: order.price,
        avgFillPrice: order.avgFillPrice,
        status: order.status,
        fee: order.fee,
        mode: order.mode,
      },
      update: {
        filledQuantity: order.filledQuantity,
        avgFillPrice: order.avgFillPrice,
        status: order.status,
        fee: order.fee,
      },
    });
  }

  async savePosition(position: Position): Promise<void> {
    await this.db.positionRecord.upsert({
      where: { id: position.id },
      create: {
        id: position.id,
        symbol: position.symbol,
        side: position.side,
        entryPrice: position.entryPrice,
        quantity: position.quantity,
        remainingQuantity: position.remainingQuantity,
        stopLoss: position.stopLoss,
        takeProfit1: position.takeProfit1,
        takeProfit2: position.takeProfit2,
        takeProfit3: position.takeProfit3,
        currentStop: position.currentStop,
        riskAmount: position.riskAmount,
        status: position.status,
        confidence: position.confidence,
        realizedPnl: position.realizedPnl,
        signalId: position.signalId,
        mode: position.mode,
        openedAt: new Date(position.openedAt),
        closedAt: position.closedAt ? new Date(position.closedAt) : null,
      },
      update: {
        remainingQuantity: position.remainingQuantity,
        currentStop: position.currentStop,
        status: position.status,
        realizedPnl: position.realizedPnl,
        closedAt: position.closedAt ? new Date(position.closedAt) : null,
      },
    });
  }

  async saveTrade(trade: ClosedTrade): Promise<void> {
    await this.db.tradeRecord.create({
      data: {
        id: trade.id,
        positionId: trade.positionId,
        symbol: trade.symbol,
        side: trade.side,
        entryPrice: trade.entryPrice,
        exitPrice: trade.exitPrice,
        quantity: trade.quantity,
        pnl: trade.pnl,
        pnlPct: trade.pnlPct,
        rMultiple: trade.rMultiple,
        fees: trade.fees,
        confidence: trade.confidence,
        exitReason: trade.exitReason,
        reasons: trade.reasons.join(' | '),
        mode: trade.mode,
        openedAt: new Date(trade.openedAt),
        closedAt: new Date(trade.closedAt),
      },
    });
  }

  async saveZone(zone: InstitutionalZone): Promise<void> {
    await this.db.zoneRecord.upsert({
      where: { id: zone.id },
      create: {
        id: zone.id,
        symbol: zone.symbol,
        type: zone.type,
        high: zone.high,
        low: zone.low,
        volume: zone.volume,
        strengthScore: zone.strengthScore,
        retestCount: zone.retestCount,
        freshness: zone.freshness,
        status: zone.status,
        breakStatus: zone.breakStatus,
        timeframe: zone.timeframe,
        timestamp: new Date(zone.timestamp),
      },
      update: {
        retestCount: zone.retestCount,
        freshness: zone.freshness,
        status: zone.status,
        breakStatus: zone.breakStatus,
      },
    });
  }

  async saveScanSnapshot(ranked: CoinRankResult[], durationMs: number): Promise<void> {
    await this.db.scanSnapshot.create({
      data: {
        ranked: ranked as object[],
        durationMs,
      },
    });
  }

  async recentTrades(limit = 50): Promise<ClosedTrade[]> {
    const rows = await this.db.tradeRecord.findMany({
      orderBy: { closedAt: 'desc' },
      take: limit,
    });
    return rows.map(
      (r: {
        id: string;
        positionId: string;
        symbol: string;
        side: string;
        entryPrice: number;
        exitPrice: number;
        quantity: number;
        pnl: number;
        pnlPct: number;
        rMultiple: number;
        fees: number;
        confidence: number;
        reasons: string;
        exitReason: string;
        openedAt: Date;
        closedAt: Date;
        mode: string;
      }) => ({
        id: r.id,
        positionId: r.positionId,
        symbol: r.symbol,
        side: r.side as ClosedTrade['side'],
        entryPrice: r.entryPrice,
        exitPrice: r.exitPrice,
        quantity: r.quantity,
        pnl: r.pnl,
        pnlPct: r.pnlPct,
        rMultiple: r.rMultiple,
        fees: r.fees,
        confidence: r.confidence,
        reasons: r.reasons.split(' | '),
        exitReason: r.exitReason,
        openedAt: r.openedAt.getTime(),
        closedAt: r.closedAt.getTime(),
        mode: 'live' as const,
        leverage: 1,
        holdMs: r.closedAt.getTime() - r.openedAt.getTime(),
      }),
    );
  }

  async dailyStats(): Promise<{ pnl: number; trades: number; winRate: number }> {
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const rows = await this.db.tradeRecord.findMany({
      where: { closedAt: { gte: start } },
    });
    const pnl = rows.reduce((s: number, r: { pnl: number }) => s + r.pnl, 0);
    const wins = rows.filter((r: { pnl: number }) => r.pnl >= 0).length;
    return {
      pnl,
      trades: rows.length,
      winRate: rows.length ? (wins / rows.length) * 100 : 0,
    };
  }
}
