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
  'risk:kill_switch': { active: boolean; reason?: string; state: RiskState };
  'wallet:redeem': {
    amount: number;
    currency: string;
    availableBefore: number;
    availableAfter?: number;
  };
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
  killSwitchActive: boolean;
  marginCurrency: string;
  leverage: number;
  lastScanAt?: number;
  lastSignalAt?: number;
  /** Last scan duration ms */
  lastScanDurationMs?: number;
  /** Count of pairs with a passing trade signal this cycle */
  signalCount?: number;
  risk: RiskState;
  /** Best-of-best trade candidates (top 10) */
  topRanked: CoinRankResult[];
  /** Full scan ranking of every pair in the universe (100–200) */
  scannedPairs: CoinRankResult[];
  openPositionsDetail: Position[];
  recentTrades: ClosedTrade[];
  zones: InstitutionalZone[];
  timeframes: Timeframe[];
}
