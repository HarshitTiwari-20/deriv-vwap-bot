import { atr, bps, clamp, ema, pctChange, sma } from '../../src/utils/math.js';

describe('math utils', () => {
  it('pctChange and bps', () => {
    expect(pctChange(100, 101)).toBeCloseTo(1);
    expect(bps(100, 100.5)).toBeCloseTo(50);
  });

  it('sma and ema', () => {
    const v = [1, 2, 3, 4, 5];
    const s = sma(v, 3);
    expect(s[2]).toBeCloseTo(2);
    expect(s[4]).toBeCloseTo(4);
    const e = ema(v, 3);
    expect(e.length).toBe(5);
    expect(e[4]).toBeGreaterThan(0);
  });

  it('atr produces finite series', () => {
    const h = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24];
    const l = h.map((x) => x - 1);
    const c = h.map((x) => x - 0.2);
    const a = atr(h, l, c, 5);
    expect(a.filter((x) => Number.isFinite(x)).length).toBeGreaterThan(0);
  });

  it('clamp', () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
  });
});
