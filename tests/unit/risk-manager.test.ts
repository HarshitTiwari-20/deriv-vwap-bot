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
    microAccountMode: false,
    usdtInrRate: 0,
    preferredSymbols: [],
  },
  risk: {
    accountBalanceUsdt: 10_000,
    /** Unit tests pin static limits unless they exercise adapt */
    autoAdaptToBalance: false,
    riskPerTradePct: 1,
    maxDailyDrawdownPct: 3,
    maxConsecutiveLosses: 3,
    maxOpenTrades: 3,
    maxExposurePct: 30,
    maxNotionalToEquity: 10,
    minConfidenceScore: 85,
    minRiskReward: 2,
    maxRiskPerTradePct: 0,
    maxTradesPerDay: 0,
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

  it('halts after 3 consecutive losses for 30 minutes', () => {
    const bus = new EventBus();
    const risk = new RiskManager(baseConfig, bus);
    const pos = { id: 'p' } as Position;
    const before = Date.now();
    risk.onTradeClosed(-50, pos);
    risk.onTradeClosed(-50, pos);
    expect(risk.getState().tradingHalted).toBe(false);
    risk.onTradeClosed(-50, pos);
    const state = risk.getState();
    expect(state.tradingHalted).toBe(true);
    expect(state.haltUntil).toBeDefined();
    // Soft halt is ~30m, not until end of UTC day
    expect(state.haltUntil!).toBeGreaterThanOrEqual(before + 30 * 60 * 1000 - 1000);
    expect(state.haltUntil!).toBeLessThanOrEqual(before + 30 * 60 * 1000 + 5000);
  });

  it('auto-resumes after soft halt expires', () => {
    const risk = new RiskManager(baseConfig, new EventBus());
    const pos = { id: 'p' } as Position;
    risk.onTradeClosed(-50, pos);
    risk.onTradeClosed(-50, pos);
    risk.onTradeClosed(-50, pos);
    expect(risk.getState().tradingHalted).toBe(true);

    // Force soft-halt expiry (private field, unit-test only)
    (risk as unknown as { state: { haltUntil: number } }).state.haltUntil =
      Date.now() - 1;

    expect(risk.getState().tradingHalted).toBe(false);
    expect(risk.canOpenTrade(signal()).allowed).toBe(true);
  });

  it('kill switch blocks entries and does not clear via soft resume', () => {
    const risk = new RiskManager(baseConfig, new EventBus());
    risk.activateKillSwitch('test');
    expect(risk.getState().killSwitchActive).toBe(true);
    expect(risk.canOpenTrade(signal()).allowed).toBe(false);
    expect(risk.resume().ok).toBe(false);
    risk.resumeKillSwitch();
    expect(risk.getState().killSwitchActive).toBe(false);
    expect(risk.canOpenTrade(signal()).allowed).toBe(true);
  });

  it('sizes INR micro account with USDTINR conversion + min lot', () => {
    const risk = new RiskManager(
      {
        ...baseConfig,
        derivatives: {
          ...baseConfig.derivatives,
          marginCurrency: 'INR',
          leverage: 25,
          microAccountMode: true,
        },
        risk: {
          ...baseConfig.risk,
          autoAdaptToBalance: false,
          accountBalanceUsdt: 50,
          riskPerTradePct: 1.5,
          maxRiskPerTradePct: 8,
          maxExposurePct: 85,
          maxNotionalToEquity: 25,
          maxOpenTrades: 1,
          maxConsecutiveLosses: 1,
        },
      } as AppConfig,
      new EventBus(),
    );
    // price 100, stop 0.5% → stopDist 0.5; min notional $6 → risk ≈ 0.06*0.5*99 = 2.97 INR
    const sizing = risk.sizePosition(
      signal({
        symbol: 'BNBUSDT',
        entry: 100,
        stopLoss: 99.5,
        takeProfit1: 101,
        takeProfit2: 102,
      }),
      {
        balance: 50,
        leverageOverride: 25,
        usdtInrRate: 99,
        minNotionalUsdt: 6,
        minQuantity: 0.01,
        stepSize: 0.01,
        maxLeverage: 25,
      },
    );
    expect(sizing.allowed).toBe(true);
    expect(sizing.notional).toBeGreaterThanOrEqual(6 - 1e-6);
    expect(sizing.margin).toBeLessThanOrEqual(50 * 0.95 + 1e-6);
    expect(sizing.riskAmount).toBeLessThanOrEqual(50 * 0.08 + 1e-6);
    expect(sizing.usdtInrRate).toBe(99);
  });

  it('rejects micro min-lot when stop risk too large', () => {
    const risk = new RiskManager(
      {
        ...baseConfig,
        derivatives: {
          ...baseConfig.derivatives,
          marginCurrency: 'INR',
          leverage: 20,
          microAccountMode: true,
        },
        risk: {
          ...baseConfig.risk,
          autoAdaptToBalance: false,
          accountBalanceUsdt: 50,
          riskPerTradePct: 1,
          maxRiskPerTradePct: 2,
          maxExposurePct: 40,
          maxNotionalToEquity: 6,
        },
      } as AppConfig,
      new EventBus(),
    );
    // 3% stop on $6 min lot → risk ≈ 6 * 0.03 * 99 = 17.8 INR > 2% of 50 = 1 INR
    const sizing = risk.sizePosition(
      signal({ entry: 100, stopLoss: 97, takeProfit1: 106, takeProfit2: 110 }),
      {
        balance: 50,
        leverageOverride: 20,
        usdtInrRate: 99,
        minNotionalUsdt: 6,
        minQuantity: 1,
        stepSize: 1,
        maxLeverage: 20,
      },
    );
    expect(sizing.allowed).toBe(false);
    expect(sizing.reason).toMatch(/risk|Risk|lot|Skip|cap/i);
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
