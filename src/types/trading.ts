export type Side = 'buy' | 'sell';
export type OrderType = 'market' | 'limit' | 'stop_market' | 'stop_limit';
export type OrderStatus =
  | 'pending'
  | 'open'
  | 'partially_filled'
  | 'filled'
  | 'cancelled'
  | 'rejected'
  | 'expired';

export type PositionStatus = 'open' | 'partially_closed' | 'closed';
/** Live derivatives only */
export type TradeMode = 'live';
export type MarginType = 'isolated' | 'crossed';

export interface Balance {
  currency: string;
  available: number;
  locked: number;
  total: number;
}

export interface OrderRequest {
  symbol: string;
  side: Side;
  type: OrderType;
  quantity: number;
  price?: number;
  stopPrice?: number;
  clientOrderId?: string;
  timeInForce?: 'GTC' | 'IOC' | 'FOK';
  reduceOnly?: boolean;
  /** Futures leverage for this order */
  leverage?: number;
  /** Optional SL/TP attached on entry (derivatives) */
  stopLossPrice?: number;
  takeProfitPrice?: number;
  marginType?: MarginType;
}

export interface Order {
  id: string;
  clientOrderId?: string;
  exchangeOrderId?: string;
  symbol: string;
  side: Side;
  type: OrderType;
  quantity: number;
  filledQuantity: number;
  price?: number;
  avgFillPrice?: number;
  stopPrice?: number;
  status: OrderStatus;
  fee?: number;
  feeCurrency?: string;
  leverage?: number;
  createdAt: number;
  updatedAt: number;
  mode: TradeMode;
}

export interface FuturesPosition {
  id: string;
  symbol: string;
  pair: string;
  side: Side | 'flat';
  size: number;
  entryPrice: number;
  markPrice: number;
  liquidationPrice: number;
  leverage: number;
  marginType: MarginType;
  lockedMargin: number;
  unrealizedPnl?: number;
  takeProfit?: number | null;
  stopLoss?: number | null;
}

export interface Position {
  id: string;
  symbol: string;
  side: Side;
  entryPrice: number;
  quantity: number;
  remainingQuantity: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  takeProfit3?: number;
  tp1Hit: boolean;
  tp2Hit: boolean;
  tp3Hit: boolean;
  currentStop: number;
  riskAmount: number;
  riskPct: number;
  unrealizedPnl: number;
  realizedPnl: number;
  status: PositionStatus;
  confidence: number;
  reasons: string[];
  signalId?: string;
  entryOrderId?: string;
  /** Exchange futures position id (for exit/leverage APIs) */
  exchangePositionId?: string;
  leverage: number;
  marginUsed: number;
  notional: number;
  marginType: MarginType;
  openedAt: number;
  updatedAt: number;
  closedAt?: number;
  mode: TradeMode;
  fees: number;
  rMultiple?: number;
}

export interface ClosedTrade {
  id: string;
  positionId: string;
  symbol: string;
  side: Side;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  pnl: number;
  pnlPct: number;
  rMultiple: number;
  fees: number;
  confidence: number;
  reasons: string[];
  exitReason: string;
  leverage: number;
  openedAt: number;
  closedAt: number;
  mode: TradeMode;
  holdMs: number;
}

export interface RiskLimits {
  riskPerTradePct: number;
  maxDailyDrawdownPct: number;
  maxConsecutiveLosses: number;
  maxOpenTrades: number;
  maxExposurePct: number;
  maxNotionalToEquity: number;
  minConfidenceScore: number;
  minRiskReward: number;
}

export interface RiskState {
  accountBalance: number;
  equity: number;
  openRisk: number;
  openExposure: number;
  openNotional: number;
  dailyPnl: number;
  dailyPnlPct: number;
  consecutiveLosses: number;
  consecutiveWins: number;
  tradingHalted: boolean;
  haltReason?: string;
  haltUntil?: number;
  openTradeCount: number;
  winRate: number;
  totalTrades: number;
  maxDrawdownPct: number;
  defaultLeverage: number;
}

export interface PositionSizeResult {
  quantity: number;
  notional: number;
  /** Margin locked ≈ notional / leverage */
  margin: number;
  leverage: number;
  riskAmount: number;
  stopDistance: number;
  stopDistancePct: number;
  allowed: boolean;
  reason?: string;
}
