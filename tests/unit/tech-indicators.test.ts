import type { Candle } from '../../src/types/market.js';
import {
  indicatorEntryVote,
  macd,
  rsiWilder,
  snapshotIndicators,
  supertrend,
} from '../../src/indicators/tech.js';

function makeCandles(n: number, start = 100, drift = 0.2): Candle[] {
  const out: Candle[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    const o = p;
    p = p + drift + Math.sin(i / 5) * 0.3;
    const h = Math.max(o, p) + 0.5;
    const l = Math.min(o, p) - 0.5;
    out.push({
      symbol: 'TESTUSDT',
      timeframe: '1m',
      openTime: i * 60_000,
      closeTime: i * 60_000 + 59_999,
      open: o,
      high: h,
      low: l,
      close: p,
      volume: 1000 + i * 10,
      quoteVolume: p * (1000 + i * 10),
      closed: true,
    });
  }
  return out;
}

describe('tech indicators', () => {
  it('computes RSI in range', () => {
    const c = makeCandles(50, 100, 0.3);
    const r = rsiWilder(c, 14);
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThanOrEqual(100);
  });

  it('MACD has finite values on uptrend', () => {
    const c = makeCandles(60, 50, 0.5);
    const m = macd(c);
    expect(Number.isFinite(m.macd)).toBe(true);
    expect(Number.isFinite(m.signal)).toBe(true);
  });

  it('supertrend returns direction', () => {
    const c = makeCandles(40, 100, 0.4);
    const st = supertrend(c, 10, 3);
    expect(st.direction === 'up' || st.direction === 'down').toBe(true);
    expect(st.value).toBeGreaterThan(0);
  });

  it('indicator vote can pass on strong bull stack', () => {
    const c = makeCandles(80, 80, 0.6);
    const ind = snapshotIndicators(c);
    const vote = indicatorEntryVote('buy', ind, 1.5);
    expect(vote.score).toBeGreaterThan(0.3);
    expect(vote.reasons.length).toBeGreaterThan(0);
  });
});
