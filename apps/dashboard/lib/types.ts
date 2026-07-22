export interface RiskState {
  accountBalance: number;
  equity: number;
  dailyPnl: number;
  dailyPnlPct: number;
  consecutiveLosses: number;
  tradingHalted: boolean;
  haltReason?: string;
  killSwitchActive?: boolean;
  killSwitchReason?: string;
  openTradeCount: number;
  winRate: number;
  totalTrades: number;
  maxDrawdownPct: number;
  marginCurrency?: string;
  sessionStartBalance?: number;
  defaultLeverage?: number;
  capitalTier?: string;
  capitalTierLabel?: string;
  adaptiveMaxOpenTrades?: number;
  adaptiveEquityUsdt?: number;
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
    confidence: { total: number; reasons: string[]; passed?: boolean };
    riskReward: number;
  };
  timestamp?: number;
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
  leverage?: number;
  marginUsed?: number;
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
  killSwitchActive?: boolean;
  marginCurrency?: string;
  leverage?: number;
  lastScanAt?: number;
  lastScanDurationMs?: number;
  signalCount?: number;
  risk: RiskState;
  /** Top trade candidates */
  topRanked: RankedCoin[];
  /** Full universe scan (100–200 pairs) */
  scannedPairs?: RankedCoin[];
  openPositionsDetail: Position[];
  recentTrades: ClosedTrade[];
  zones: Zone[];
}
