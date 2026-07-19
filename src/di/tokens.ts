/** DI injection tokens (string tokens for tsyringe) */
export const TOKENS = {
  Config: 'Config',
  EventBus: 'EventBus',
  Logger: 'Logger',
  Redis: 'Redis',
  ExchangeClient: 'ExchangeClient',
  MarketDataWs: 'MarketDataWs',
  CandleStore: 'CandleStore',
  UniverseManager: 'UniverseManager',
  Scanner: 'Scanner',
  RankingEngine: 'RankingEngine',
  VwapEngine: 'VwapEngine',
  InstitutionalZoneDetector: 'InstitutionalZoneDetector',
  MarketStructureEngine: 'MarketStructureEngine',
  LiquidityDetector: 'LiquidityDetector',
  VolumeAnalyzer: 'VolumeAnalyzer',
  ScoringEngine: 'ScoringEngine',
  SignalGenerator: 'SignalGenerator',
  RiskManager: 'RiskManager',
  PortfolioManager: 'PortfolioManager',
  TradeExecutor: 'TradeExecutor',
  AlertService: 'AlertService',
  BotOrchestrator: 'BotOrchestrator',
} as const;

export type Token = (typeof TOKENS)[keyof typeof TOKENS];
