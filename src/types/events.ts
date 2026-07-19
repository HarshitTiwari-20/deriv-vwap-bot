import type { Candle, Ticker, Timeframe } from './market.js';
import type { CoinRankResult, InstitutionalZone, SetupSignal } from './strategy.js';
import type { ClosedTrade, Order, Position, RiskState } from './trading.js';

/** Strongly-typed domain events for the event bus */
export interface DomainEvents {
  'candle:update': { candle: Candle };
  'candle:closed': { candle: Candle };
  'ticker:update': { ticker: Ticker };
  'universe:refreshed': { symbols: string[]; timestamp: number };
  'scan:complete': {
    ranked: CoinRankResult[];
    durationMs: number;
    timestamp: number;
  };
  'signal:generated': { signal: SetupSignal };
  'signal:rejected': { signal: SetupSignal; reason: string };
  'order:created': { order: Order };
  'order:updated': { order: Order };
  'order:filled': { order: Order };
  'position:opened': { position: Position };
  'position:updated': { position: Position };
  'position:closed': { trade: ClosedTrade; position: Position };
  'zone:created': { zone: InstitutionalZone };
  'zone:invalidated': { zone: InstitutionalZone };
  'risk:halt': { state: RiskState; reason: string };
  'risk:resume': { state: RiskState };
  'ws:connected': { stream: string };
  'ws:disconnected': { stream: string; reason?: string };
  'ws:error': { stream: string; error: Error };
  'system:error': { context: string; error: Error };
  'system:ready': { mode: string; timestamp: number };
  'alert:sent': { channel: string; message: string };
  'log:entry': {
    level: string;
    message: string;
    meta?: Record<string, unknown>;
    timestamp: number;
  };
}

export type DomainEventName = keyof DomainEvents;

export interface BotStatusSnapshot {
  mode: string;
  uptime: number;
  universeSize: number;
  openPositions: number;
  dailyPnl: number;
  winRate: number;
  tradingHalted: boolean;
  lastScanAt?: number;
  lastSignalAt?: number;
  risk: RiskState;
  topRanked: CoinRankResult[];
  openPositionsDetail: Position[];
  recentTrades: ClosedTrade[];
  zones: InstitutionalZone[];
  timeframes: Timeframe[];
}
