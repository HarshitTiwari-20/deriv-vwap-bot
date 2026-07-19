import { VwapEngine } from '../../src/strategy/vwap/vwap-engine.js';
import type { Candle } from '../../src/types/market.js';

function makeCandles(n: number, startPrice = 100): Candle[] {
  const out: Candle[] = [];
  let price = startPrice;
  const day = Date.UTC(2024, 0, 15);
  for (let i = 0; i < n; i++) {
    const open = price;
    price = price * (1 + (i % 5 === 0 ? 0.002 : -0.0005));
    const high = Math.max(open, price) * 1.001;
    const low = Math.min(open, price) * 0.999;
    out.push({
      symbol: 'BTCUSDT',
      timeframe: '1m',
      openTime: day + i * 60_000,
      closeTime: day + i * 60_000 + 59_999,
      open,
      high,
      low,
      close: price,
      volume: 100 + (i % 10) * 20,
      quoteVolume: price * (100 + (i % 10) * 20),
      closed: true,
    });
  }
  return out;
}

describe('VwapEngine', () => {
  const engine = new VwapEngine();

  it('computes session VWAP with long bias when price above VWAP', () => {
    const candles = makeCandles(60, 100);
    // Push last close well above
    const last = candles[candles.length - 1]!;
    last.close = last.close * 1.05;
    last.high = last.close;
    const snap = engine.snapshot('BTCUSDT', '1m', candles, last.close, 1);
    expect(snap.session.value).toBeGreaterThan(0);
    expect(snap.session.bias).toBe('long');
    expect(snap.daily.value).toBeGreaterThan(0);
  });

  it('computes anchored VWAP from highest volume', () => {
    const candles = makeCandles(80, 50);
    candles[40]!.volume = 10_000;
    const snap = engine.snapshot('BTCUSDT', '1m', candles, candles[79]!.close, 0.5);
    expect(snap.anchored.length).toBeGreaterThan(0);
    const hv = snap.anchored.find((a) => a.anchor === 'highest_volume');
    expect(hv).toBeDefined();
    expect(hv!.value).toBeGreaterThan(0);
  });

  it('alignmentScore is higher when bias matches side', () => {
    const candles = makeCandles(50, 100);
    const price = candles[49]!.close * 1.02;
    const snap = engine.snapshot('BTCUSDT', '1m', candles, price, 1);
    const longScore = engine.alignmentScore(snap, 'buy');
    const shortScore = engine.alignmentScore(snap, 'sell');
    expect(longScore).toBeGreaterThan(shortScore);
  });

  it('ignores unclosed candles for session computation path via snapshot filter', () => {
    const candles = makeCandles(30, 10);
    candles.push({
      ...candles[29]!,
      openTime: candles[29]!.openTime + 60_000,
      closed: false,
      volume: 999999,
    });
    const snap = engine.snapshot('BTCUSDT', '1m', candles, 10, 0.1);
    expect(snap.session.value).toBeGreaterThan(0);
  });
});
