export interface RiskState {
  accountBalance: number;
  equity: number;
  dailyPnl: number;
  dailyPnlPct: number;
  consecutiveLosses: number;
  tradingHalted: boolean;
  haltReason?: string;
  openTradeCount: number;
  winRate: number;
  totalTrades: number;
  maxDrawdownPct: number;
}

export interface RankedCoin {
  symbol: string;
  rank: number;
  score: number;
  factors: Record<string, number>;
  signal?: {
    side: string;
    entry: number;
    stopLoss: number;
    takeProfit1: number;
    takeProfit2: number;
    confidence: { total: number; reasons: string[] };
    riskReward: number;
  };
}

export interface Position {
  id: string;
  symbol: string;
  side: string;
  entryPrice: number;
  quantity: number;
  remainingQuantity: number;
  currentStop: number;
  takeProfit1: number;
  takeProfit2: number;
  unrealizedPnl: number;
  confidence: number;
  status: string;
}

export interface ClosedTrade {
  id: string;
  symbol: string;
  side: string;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  pnlPct: number;
  rMultiple: number;
  exitReason: string;
  closedAt: number;
}

export interface Zone {
  id: string;
  symbol: string;
  type: string;
  high: number;
  low: number;
  strengthScore: number;
  freshness: number;
  retestCount: number;
  status: string;
}

export interface BotStatus {
  mode: string;
  uptime: number;
  universeSize: number;
  openPositions: number;
  dailyPnl: number;
  winRate: number;
  tradingHalted: boolean;
  lastScanAt?: number;
  risk: RiskState;
  topRanked: RankedCoin[];
  openPositionsDetail: Position[];
  recentTrades: ClosedTrade[];
  zones: Zone[];
}
