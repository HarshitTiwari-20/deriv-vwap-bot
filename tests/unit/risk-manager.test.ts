import { EventBus } from '../../src/events/event-bus.js';
import { RiskManager } from '../../src/risk/risk-manager.js';
import type { AppConfig } from '../../src/config/schema.js';
import type { SetupSignal } from '../../src/types/strategy.js';
import type { Position } from '../../src/types/trading.js';

const baseConfig = {
  tradingMode: 'live',
  derivatives: {
    marginCurrency: 'USDT',
    leverage: 10,
    leverageBySymbol: {},
    marginType: 'isolated',
    attachSlTpOnEntry: true,
    respectInstrumentMaxLeverage: true,
  },
  risk: {
    accountBalanceUsdt: 10_000,
    riskPerTradePct: 1,
    maxDailyDrawdownPct: 3,
    maxConsecutiveLosses: 3,
    maxOpenTrades: 3,
    maxExposurePct: 30,
    maxNotionalToEquity: 10,
    minConfidenceScore: 85,
    minRiskReward: 2,
  },
} as AppConfig;

function signal(overrides: Partial<SetupSignal> = {}): SetupSignal {
  return {
    id: 's1',
    symbol: 'BTCUSDT',
    side: 'buy',
    timeframe: '1m',
    entry: 100,
    stopLoss: 98,
    takeProfit1: 102,
    takeProfit2: 104,
    riskReward: 2,
    confidence: {
      total: 90,
      breakdown: {} as never,
      maxPossible: 100,
      reasons: [],
      passed: true,
    },
    atr: 1,
    reasons: [],
    rankScore: 90,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

describe('RiskManager (leveraged derivatives)', () => {
  it('sizes position to ~1% risk with leverage margin', () => {
    const risk = new RiskManager(baseConfig, new EventBus());
    // stop dist 10 → qty = 10; notional 1000; margin at 10x = 100
    const sizing = risk.sizePosition(
      signal({ entry: 100, stopLoss: 90, takeProfit1: 110, takeProfit2: 120 }),
      undefined,
      10,
    );
    expect(sizing.allowed).toBe(true);
    expect(sizing.quantity).toBeCloseTo(10, 5);
    expect(sizing.riskAmount).toBeCloseTo(100, 5);
    expect(sizing.leverage).toBe(10);
    expect(sizing.margin).toBeCloseTo(100, 5);
    expect(sizing.notional).toBeCloseTo(1000, 5);
  });

  it('rejects low confidence', () => {
    const risk = new RiskManager(baseConfig, new EventBus());
    const gate = risk.canOpenTrade(
      signal({
        confidence: {
          total: 70,
          breakdown: {} as never,
          maxPossible: 100,
          reasons: [],
          passed: false,
        },
      }),
    );
    expect(gate.allowed).toBe(false);
  });

  it('halts after 3 consecutive losses', () => {
    const bus = new EventBus();
    const risk = new RiskManager(baseConfig, bus);
    const pos = { id: 'p' } as Position;
    risk.onTradeClosed(-50, pos);
    risk.onTradeClosed(-50, pos);
    expect(risk.getState().tradingHalted).toBe(false);
    risk.onTradeClosed(-50, pos);
    expect(risk.getState().tradingHalted).toBe(true);
  });

  it('moves stop to breakeven after TP1', () => {
    const risk = new RiskManager(baseConfig, new EventBus());
    const pos = {
      side: 'buy',
      entryPrice: 100,
      stopLoss: 98,
      currentStop: 98,
      takeProfit1: 102,
      takeProfit2: 104,
      tp1Hit: false,
      tp2Hit: false,
      tp3Hit: false,
    } as Position;
    const upd = risk.updateStops(pos, 102.5, 1);
    expect(upd.tp1Hit).toBe(true);
    expect(upd.stop).toBe(100);
  });
});
