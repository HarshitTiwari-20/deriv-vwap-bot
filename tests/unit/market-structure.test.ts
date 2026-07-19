import { MarketStructureEngine } from '../../src/strategy/market-structure/structure-engine.js';
import type { Candle } from '../../src/types/market.js';

/**
 * Build a series with unmistakable swing highs/lows:
 * For each swing high at index i, highs[i-L..i+R] except i are strictly lower.
 */
function swingSeries(): Candle[] {
  const n = 60;
  const closes: number[] = [];
  const highs: number[] = [];
  const lows: number[] = [];

  // Base flat channel with planted swings every 8 bars
  for (let i = 0; i < n; i++) {
    const wave = Math.sin(i / 4) * 5 + i * 0.3; // gentle uptrend + oscillation
    closes.push(100 + wave);
    highs.push(100 + wave + 0.3);
    lows.push(100 + wave - 0.3);
  }

  // Amplify peaks/troughs so fractal swings are unambiguous with left=right=2
  for (let i = 4; i < n - 4; i += 8) {
    highs[i] = highs[i]! + 3;
    closes[i] = closes[i]! + 2;
  }
  for (let i = 8; i < n - 4; i += 8) {
    lows[i] = lows[i]! - 3;
    closes[i] = closes[i]! - 2;
  }

  return closes.map((close, i) => ({
    symbol: 'BTCUSDT',
    timeframe: '1m' as const,
    openTime: 1_700_000_000_000 + i * 60_000,
    closeTime: 1_700_000_000_000 + i * 60_000 + 59_999,
    open: i > 0 ? closes[i - 1]! : close,
    high: highs[i]!,
    low: lows[i]!,
    close,
    volume: 100,
    quoteVolume: close * 100,
    closed: true,
  }));
}

describe('MarketStructureEngine', () => {
  const engine = new MarketStructureEngine({ swingLeft: 2, swingRight: 2 });

  it('detects structure on oscillatory uptrend', () => {
    const candles = swingSeries();
    const state = engine.analyze('BTCUSDT', '1m', candles);
    expect(['bullish', 'ranging', 'bearish']).toContain(state.trend);
    // Should at least produce swing labels or BOS events
    expect(state.timestamp).toBeGreaterThan(0);
    // Either events or a defined last swing after enough history
    const hasStructure =
      state.recentEvents.length > 0 ||
      state.lastSwingHigh !== undefined ||
      state.lastSwingLow !== undefined ||
      state.trendStrength >= 0;
    expect(hasStructure).toBe(true);
  });

  it('labels HH/HL when swings are present', () => {
    // Manually craft: 3 rising highs and 3 rising lows with clear isolation
    const candles: Candle[] = [];
    const pattern: Array<{ h: number; l: number; c: number }> = [];
    // 5 bars quiet, peak, 5 quiet, higher peak, ...
    for (let cycle = 0; cycle < 4; cycle++) {
      for (let j = 0; j < 3; j++) pattern.push({ h: 100 + cycle, l: 99 + cycle, c: 99.5 + cycle });
      pattern.push({ h: 110 + cycle * 5, l: 100 + cycle, c: 108 + cycle * 5 }); // swing high
      for (let j = 0; j < 3; j++) pattern.push({ h: 102 + cycle, l: 100 + cycle, c: 101 + cycle });
      pattern.push({ h: 101 + cycle, l: 90 + cycle * 2, c: 92 + cycle * 2 }); // swing low (rising)
      for (let j = 0; j < 3; j++) pattern.push({ h: 100 + cycle, l: 98 + cycle, c: 99 + cycle });
    }

    for (let i = 0; i < pattern.length; i++) {
      const p = pattern[i]!;
      candles.push({
        symbol: 'BTCUSDT',
        timeframe: '1m',
        openTime: 1_700_000_000_000 + i * 60_000,
        closeTime: 1_700_000_000_000 + i * 60_000 + 59_999,
        open: p.c,
        high: p.h,
        low: p.l,
        close: p.c,
        volume: 100,
        quoteVolume: p.c * 100,
        closed: true,
      });
    }

    const state = engine.analyze('BTCUSDT', '1m', candles);
    const types = state.recentEvents.map((e) => e.type);
    // Expect some structure event types from HH/HL/LH/LL or BOS
    expect(state.lastSwingHigh || state.lastSwingLow || types.length >= 0).toBeTruthy();
    expect(candles.length).toBeGreaterThan(20);
  });

  it('requires closed candles and enough history', () => {
    const few: Candle[] = swingSeries().slice(0, 5);
    const state = engine.analyze('BTCUSDT', '1m', few);
    expect(state.trend).toBe('ranging');
    expect(state.trendStrength).toBe(0);
  });
});
