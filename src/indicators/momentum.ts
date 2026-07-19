import type { Candle } from '../types/market.js';
import { ema, mean } from '../utils/math.js';

export function roc(candles: Candle[], period: number): number {
  if (candles.length <= period) return 0;
  const cur = candles[candles.length - 1]!.close;
  const prev = candles[candles.length - 1 - period]!.close;
  if (prev === 0) return 0;
  return ((cur - prev) / prev) * 100;
}

export function rsi(candles: Candle[], period = 14): number {
  if (candles.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const diff = candles[i]!.close - candles[i - 1]!.close;
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

export function momentumScore(candles: Candle[]): number {
  if (candles.length < 20) return 0;
  const r = roc(candles, 10);
  const rSlow = roc(candles, 20);
  const closes = candles.map((c) => c.close);
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const lastE9 = e9[e9.length - 1]!;
  const lastE21 = e21[e21.length - 1]!;
  const trend = lastE9 > lastE21 ? 1 : lastE9 < lastE21 ? -1 : 0;
  // Normalize roughly into 0–100 bullish score
  const raw = trend * 40 + Math.tanh(r / 2) * 30 + Math.tanh(rSlow / 3) * 30;
  return Math.max(0, Math.min(100, 50 + raw));
}

export function bodyRatio(candle: Candle): number {
  const range = candle.high - candle.low;
  if (range === 0) return 0;
  return Math.abs(candle.close - candle.open) / range;
}

export function wickRatios(candle: Candle): { upper: number; lower: number } {
  const range = candle.high - candle.low;
  if (range === 0) return { upper: 0, lower: 0 };
  const bodyTop = Math.max(candle.open, candle.close);
  const bodyBot = Math.min(candle.open, candle.close);
  return {
    upper: (candle.high - bodyTop) / range,
    lower: (bodyBot - candle.low) / range,
  };
}

export function isStrongBullishClose(candle: Candle, minBody = 0.6, maxWick = 0.25): boolean {
  if (candle.close <= candle.open) return false;
  const br = bodyRatio(candle);
  const w = wickRatios(candle);
  return br >= minBody && w.upper <= maxWick;
}

export function isStrongBearishClose(candle: Candle, minBody = 0.6, maxWick = 0.25): boolean {
  if (candle.close >= candle.open) return false;
  const br = bodyRatio(candle);
  const w = wickRatios(candle);
  return br >= minBody && w.lower <= maxWick;
}

export function averageTrueRangePct(candles: Candle[], atrValue: number): number {
  if (!candles.length || !atrValue) return 0;
  return (atrValue / candles[candles.length - 1]!.close) * 100;
}

export function recentReturn(candles: Candle[], bars: number): number {
  if (candles.length <= bars) return 0;
  const a = candles[candles.length - 1 - bars]!.close;
  const b = candles[candles.length - 1]!.close;
  return a === 0 ? 0 : ((b - a) / a) * 100;
}

export function volumeWeightedMomentum(candles: Candle[], period: number): number {
  const slice = candles.slice(-period);
  if (slice.length < 2) return 0;
  let num = 0;
  let den = 0;
  for (let i = 1; i < slice.length; i++) {
    const ret = slice[i]!.close - slice[i - 1]!.close;
    num += ret * slice[i]!.volume;
    den += slice[i]!.volume;
  }
  return den === 0 ? 0 : num / den;
}

export function meanVolume(candles: Candle[]): number {
  return mean(candles.map((c) => c.volume));
}
