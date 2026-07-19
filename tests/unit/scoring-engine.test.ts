import { VwapEngine } from '../../src/strategy/vwap/vwap-engine.js';
import { ScoringEngine } from '../../src/strategy/scoring/scoring-engine.js';
import type { ScoreInput } from '../../src/strategy/scoring/scoring-engine.js';
import type { Candle } from '../../src/types/market.js';

function baseInput(overrides: Partial<ScoreInput> = {}): ScoreInput {
  const candles: Candle[] = Array.from({ length: 30 }, (_, i) => ({
    symbol: 'ETHUSDT',
    timeframe: '1m' as const,
    openTime: 1_000_000 + i * 60_000,
    closeTime: 1_000_000 + i * 60_000 + 59_999,
    open: 2000 + i,
    high: 2001 + i,
    low: 1999 + i,
    close: 2000.5 + i,
    volume: 500 + i * 10,
    quoteVolume: 1e6,
    closed: true,
  }));

  const vwap = new VwapEngine().snapshot('ETHUSDT', '1m', candles, 2030, 5);

  return {
    side: 'buy',
    vwap: { ...vwap, primaryBias: 'long', session: { ...vwap.session, bias: 'long' } },
    zone: {
      id: 'z1',
      symbol: 'ETHUSDT',
      type: 'demand',
      high: 2025,
      low: 2010,
      mid: 2017.5,
      volume: 5000,
      volumeMultiple: 3,
      timestamp: Date.now() - 60_000,
      candleOpenTime: Date.now() - 120_000,
      strengthScore: 80,
      retestCount: 1,
      freshness: 90,
      status: 'tested',
      breakStatus: false,
      timeframe: '1m',
    },
    structure: {
      symbol: 'ETHUSDT',
      timeframe: '1m',
      trend: 'bullish',
      trendStrength: 70,
      recentEvents: [
        {
          type: 'BOS',
          price: 2020,
          time: Date.now() - 30_000,
          direction: 'bullish',
          strength: 2,
        },
      ],
      internalTrend: 'bullish',
      externalTrend: 'bullish',
      lastBos: {
        type: 'BOS',
        price: 2020,
        time: Date.now() - 30_000,
        direction: 'bullish',
        strength: 2,
      },
      timestamp: Date.now(),
    },
    htStructure: {
      symbol: 'ETHUSDT',
      timeframe: '1h',
      trend: 'bullish',
      trendStrength: 80,
      recentEvents: [],
      internalTrend: 'bullish',
      externalTrend: 'bullish',
      timestamp: Date.now(),
    },
    volume: {
      symbol: 'ETHUSDT',
      timeframe: '1m',
      volume: 2000,
      volumeSma: 500,
      rvol: 4,
      obv: 1000,
      spike: true,
      buyPressure: 0.7,
      sellPressure: 0.3,
      timestamp: Date.now(),
    },
    liquidity: [
      {
        id: 'l1',
        symbol: 'ETHUSDT',
        type: 'liquidity_grab',
        price: 2010,
        high: 2012,
        low: 2008,
        side: 'buy_side',
        strength: 80,
        swept: true,
        confirmed: true,
        timestamp: Date.now() - 10_000,
        sweepTime: Date.now() - 10_000,
      },
    ],
    candles,
    atr: 5,
    price: 2030,
    retestQuality: 0.85,
    ...overrides,
  };
}

describe('ScoringEngine', () => {
  const vwapEngine = new VwapEngine();
  const scoring = new ScoringEngine(vwapEngine, {
    scoring: { weights: {} as never },
    risk: {
      accountBalanceUsdt: 10000,
      riskPerTradePct: 1,
      maxDailyDrawdownPct: 3,
      maxConsecutiveLosses: 3,
      maxOpenTrades: 3,
      maxExposurePct: 10,
      minConfidenceScore: 85,
      minRiskReward: 2,
    },
  } as never);

  it('scores high-quality setup above 85', () => {
    const result = scoring.score(baseInput());
    expect(result.total).toBeGreaterThanOrEqual(85);
    expect(result.passed).toBe(true);
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.breakdown.vwapAlignment).toBeGreaterThan(0);
    expect(result.breakdown.institutionalZone).toBeGreaterThan(0);
  });

  it('fails when volume and zone are missing', () => {
    const result = scoring.score(
      baseInput({
        zone: undefined,
        volume: {
          symbol: 'ETHUSDT',
          timeframe: '1m',
          volume: 100,
          volumeSma: 100,
          rvol: 1,
          obv: 0,
          spike: false,
          buyPressure: 0.5,
          sellPressure: 0.5,
          timestamp: Date.now(),
        },
        liquidity: [],
        retestQuality: 0.1,
        structure: {
          symbol: 'ETHUSDT',
          timeframe: '1m',
          trend: 'ranging',
          trendStrength: 10,
          recentEvents: [],
          internalTrend: 'ranging',
          externalTrend: 'ranging',
          timestamp: Date.now(),
        },
        htStructure: {
          symbol: 'ETHUSDT',
          timeframe: '1h',
          trend: 'ranging',
          trendStrength: 10,
          recentEvents: [],
          internalTrend: 'ranging',
          externalTrend: 'ranging',
          timestamp: Date.now(),
        },
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.total).toBeLessThan(85);
  });
});
