/**
 * Core market data types used across the bot.
 * All timestamps are Unix milliseconds (UTC).
 */

export type Timeframe = '1m' | '3m' | '5m' | '15m' | '1h' | '4h' | '1d';

export const TIMEFRAME_MS: Record<Timeframe, number> = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

export interface Candle {
  symbol: string;
  timeframe: Timeframe;
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
  trades?: number;
  /** true when candle is fully closed (no look-ahead) */
  closed: boolean;
}

export interface Ticker {
  symbol: string;
  lastPrice: number;
  bid: number;
  ask: number;
  bidQty?: number;
  askQty?: number;
  volume24h: number;
  quoteVolume24h: number;
  high24h: number;
  low24h: number;
  change24hPct: number;
  timestamp: number;
}

export interface OrderBookLevel {
  price: number;
  quantity: number;
}

export interface OrderBook {
  symbol: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  timestamp: number;
}

export interface TradeTick {
  symbol: string;
  price: number;
  quantity: number;
  side: 'buy' | 'sell';
  timestamp: number;
  tradeId?: string;
}

export interface MarketMeta {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  status: 'active' | 'inactive' | 'delisted';
  minQuantity: number;
  maxQuantity: number;
  stepSize: number;
  tickSize: number;
  minNotional: number;
  listedAt?: number;
}

export interface SpreadMetrics {
  symbol: string;
  bid: number;
  ask: number;
  mid: number;
  spreadAbs: number;
  spreadBps: number;
  timestamp: number;
}
