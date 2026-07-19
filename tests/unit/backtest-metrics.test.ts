import { computeMetrics } from '../../src/backtest/metrics.js';
import type { ClosedTrade } from '../../src/types/trading.js';

function trade(pnl: number, t: number): ClosedTrade {
  return {
    id: String(t),
    positionId: 'p',
    symbol: 'BTCUSDT',
    side: 'buy',
    entryPrice: 100,
    exitPrice: 100 + pnl,
    quantity: 1,
    pnl,
    pnlPct: pnl,
    rMultiple: pnl / 2,
    fees: 0,
    confidence: 90,
    reasons: [],
    exitReason: 'TP',
    openedAt: t - 1000,
    closedAt: t,
    mode: 'live',
    leverage: 10,
    holdMs: 1000,
  };
}

describe('computeMetrics', () => {
  it('computes win rate and profit factor', () => {
    const trades = [
      trade(100, 1),
      trade(-40, 2),
      trade(80, 3),
      trade(-30, 4),
    ];
    const m = computeMetrics(trades, 10_000);
    expect(m.totalTrades).toBe(4);
    expect(m.winRate).toBe(50);
    expect(m.profitFactor).toBeCloseTo(180 / 70, 5);
    expect(m.totalPnl).toBe(110);
    expect(m.equityCurve.length).toBeGreaterThan(1);
  });

  it('handles empty trades', () => {
    const m = computeMetrics([], 10_000);
    expect(m.totalTrades).toBe(0);
    expect(m.equityCurve[0]!.equity).toBe(10_000);
  });
});
