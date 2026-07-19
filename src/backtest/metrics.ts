import type { ClosedTrade } from '../types/trading.js';

export interface PerformanceMetrics {
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  sharpeRatio: number;
  sortinoRatio: number;
  maxDrawdownPct: number;
  cagr: number;
  averageR: number;
  totalPnl: number;
  averagePnl: number;
  monthlyReturns: Record<string, number>;
  equityCurve: Array<{ t: number; equity: number }>;
}

/**
 * Performance metrics from closed trades. No look-ahead — uses trade exit times only.
 */
export function computeMetrics(
  trades: ClosedTrade[],
  initialCapital: number,
  riskFreeRate = 0,
): PerformanceMetrics {
  if (trades.length === 0) {
    return {
      totalTrades: 0,
      winRate: 0,
      profitFactor: 0,
      sharpeRatio: 0,
      sortinoRatio: 0,
      maxDrawdownPct: 0,
      cagr: 0,
      averageR: 0,
      totalPnl: 0,
      averagePnl: 0,
      monthlyReturns: {},
      equityCurve: [{ t: Date.now(), equity: initialCapital }],
    };
  }

  const sorted = [...trades].sort((a, b) => a.closedAt - b.closedAt);
  let equity = initialCapital;
  let peak = equity;
  let maxDd = 0;
  const equityCurve: Array<{ t: number; equity: number }> = [
    { t: sorted[0]!.openedAt, equity },
  ];
  const returns: number[] = [];
  const monthly: Record<string, number> = {};

  let grossWin = 0;
  let grossLoss = 0;
  let wins = 0;

  for (const t of sorted) {
    equity += t.pnl;
    const ret = t.pnl / (equity - t.pnl || initialCapital);
    returns.push(ret);
    if (t.pnl >= 0) {
      wins += 1;
      grossWin += t.pnl;
    } else {
      grossLoss += Math.abs(t.pnl);
    }
    peak = Math.max(peak, equity);
    const dd = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
    maxDd = Math.max(maxDd, dd);
    equityCurve.push({ t: t.closedAt, equity });

    const mk = new Date(t.closedAt).toISOString().slice(0, 7);
    monthly[mk] = (monthly[mk] ?? 0) + t.pnl;
  }

  const totalPnl = equity - initialCapital;
  const avgRet = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const variance =
    returns.length > 1
      ? returns.reduce((s, r) => s + (r - avgRet) ** 2, 0) / (returns.length - 1)
      : 0;
  const std = Math.sqrt(variance);
  const downside = returns.filter((r) => r < 0);
  const downVar =
    downside.length > 1
      ? downside.reduce((s, r) => s + r ** 2, 0) / (downside.length - 1)
      : 0;
  const downStd = Math.sqrt(downVar);

  // Annualize assuming ~365 trading days crypto, scale by trades/year estimate
  const msSpan = sorted[sorted.length - 1]!.closedAt - sorted[0]!.openedAt;
  const years = Math.max(msSpan / (365.25 * 86_400_000), 1 / 365);
  const cagr = years > 0 ? (Math.pow(equity / initialCapital, 1 / years) - 1) * 100 : 0;

  const sharpe = std > 0 ? ((avgRet - riskFreeRate / 365) / std) * Math.sqrt(365) : 0;
  const sortino = downStd > 0 ? ((avgRet - riskFreeRate / 365) / downStd) * Math.sqrt(365) : 0;

  return {
    totalTrades: sorted.length,
    winRate: (wins / sorted.length) * 100,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    sharpeRatio: sharpe,
    sortinoRatio: sortino,
    maxDrawdownPct: maxDd,
    cagr,
    averageR: sorted.reduce((s, t) => s + t.rMultiple, 0) / sorted.length,
    totalPnl,
    averagePnl: totalPnl / sorted.length,
    monthlyReturns: monthly,
    equityCurve,
  };
}
