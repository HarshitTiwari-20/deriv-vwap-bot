import type { Candle, Timeframe } from './market.js';
import type { Side } from './trading.js';

/** VWAP variants computed by the strategy layer */
export type VwapType = 'session' | 'daily' | 'weekly' | 'monthly' | 'anchored';

export type VwapAnchor =
  | 'highest_volume'
  | 'swing_high'
  | 'swing_low'
  | 'bos'
  | 'session_start'
  | 'custom';

export interface VwapPoint {
  type: VwapType;
  value: number;
  upperBand?: number;
  lowerBand?: number;
  anchor?: VwapAnchor;
  anchorTime?: number;
  distancePct: number;
  distanceAtr: number;
  bias: 'long' | 'short' | 'neutral';
}

export interface VwapSnapshot {
  symbol: string;
  timeframe: Timeframe;
  price: number;
  session: VwapPoint;
  daily: VwapPoint;
  weekly: VwapPoint;
  monthly: VwapPoint;
  anchored: VwapPoint[];
  primaryBias: 'long' | 'short' | 'neutral';
  timestamp: number;
}

export type ZoneType = 'demand' | 'supply';
export type ZoneStatus = 'fresh' | 'tested' | 'broken' | 'invalidated';

export interface InstitutionalZone {
  id: string;
  symbol: string;
  type: ZoneType;
  high: number;
  low: number;
  mid: number;
  volume: number;
  volumeMultiple: number;
  timestamp: number;
  candleOpenTime: number;
  strengthScore: number;
  retestCount: number;
  freshness: number;
  status: ZoneStatus;
  breakStatus: boolean;
  timeframe: Timeframe;
}

export type StructureEventType =
  | 'HH'
  | 'HL'
  | 'LH'
  | 'LL'
  | 'BOS'
  | 'CHOCH'
  | 'internal_BOS'
  | 'external_BOS';

export type TrendDirection = 'bullish' | 'bearish' | 'ranging';

export interface StructurePoint {
  price: number;
  time: number;
  kind: 'high' | 'low';
  confirmed: boolean;
}

export interface StructureEvent {
  type: StructureEventType;
  price: number;
  time: number;
  direction: TrendDirection;
  brokenLevel?: number;
  strength: number;
}

export interface MarketStructureState {
  symbol: string;
  timeframe: Timeframe;
  trend: TrendDirection;
  trendStrength: number;
  lastSwingHigh?: StructurePoint;
  lastSwingLow?: StructurePoint;
  recentEvents: StructureEvent[];
  internalTrend: TrendDirection;
  externalTrend: TrendDirection;
  lastBos?: StructureEvent;
  lastChoch?: StructureEvent;
  timestamp: number;
}

export type LiquidityType =
  | 'equal_highs'
  | 'equal_lows'
  | 'liquidity_pool'
  | 'stop_hunt'
  | 'swing_failure'
  | 'false_breakout'
  | 'liquidity_grab';

export interface LiquidityLevel {
  id: string;
  symbol: string;
  type: LiquidityType;
  price: number;
  high: number;
  low: number;
  side: 'buy_side' | 'sell_side';
  strength: number;
  swept: boolean;
  sweepTime?: number;
  confirmed: boolean;
  timestamp: number;
}

export interface VolumeMetrics {
  symbol: string;
  timeframe: Timeframe;
  volume: number;
  volumeSma: number;
  rvol: number;
  obv: number;
  volumeDelta?: number;
  cumulativeVolumeDelta?: number;
  spike: boolean;
  buyPressure: number;
  sellPressure: number;
  timestamp: number;
}

export interface ConfidenceBreakdown {
  vwapAlignment: number;
  institutionalZone: number;
  marketStructure: number;
  volumeSpike: number;
  liquiditySweep: number;
  trend: number;
  atrVolatility: number;
  retestQuality: number;
  momentum: number;
}

export interface ConfidenceScore {
  total: number;
  breakdown: ConfidenceBreakdown;
  maxPossible: number;
  reasons: string[];
  passed: boolean;
}

export interface SetupSignal {
  id: string;
  symbol: string;
  side: Side;
  timeframe: Timeframe;
  entry: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  takeProfit3?: number;
  riskReward: number;
  confidence: ConfidenceScore;
  atr: number;
  zone?: InstitutionalZone;
  structure?: MarketStructureState;
  vwap?: VwapSnapshot;
  volume?: VolumeMetrics;
  liquidity?: LiquidityLevel[];
  reasons: string[];
  rankScore: number;
  createdAt: number;
  expiresAt: number;
}

export interface CoinRankResult {
  symbol: string;
  rank: number;
  score: number;
  factors: {
    institutionalVolume: number;
    vwapAlignment: number;
    momentum: number;
    trendStrength: number;
    atr: number;
    relativeVolume: number;
    liquidityQuality: number;
    spread: number;
    confidence: number;
  };
  signal?: SetupSignal;
  timestamp: number;
}

export interface AnalysisContext {
  symbol: string;
  candles: Record<Timeframe, Candle[]>;
  lastPrice: number;
  atr: number;
  spreadBps: number;
  quoteVolume24h: number;
  timestamp: number;
}
