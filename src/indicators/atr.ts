import type { Candle } from '../types/market.js';
import { atr as atrSeries, lastFinite } from '../utils/math.js';

export function computeAtr(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return NaN;
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const closes = candles.map((c) => c.close);
  return lastFinite(atrSeries(highs, lows, closes, period));
}

export function computeAtrSeries(candles: Candle[], period = 14): number[] {
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const closes = candles.map((c) => c.close);
  return atrSeries(highs, lows, closes, period);
}

export function atrPct(atrValue: number, price: number): number {
  if (!price || !Number.isFinite(atrValue)) return 0;
  return (atrValue / price) * 100;
}
