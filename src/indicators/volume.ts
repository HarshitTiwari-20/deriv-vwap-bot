import type { Candle } from '../types/market.js';
import { mean, sma } from '../utils/math.js';

export function volumeSma(candles: Candle[], period: number): number {
  if (candles.length < period) return mean(candles.map((c) => c.volume));
  const vols = candles.slice(-period).map((c) => c.volume);
  return mean(vols);
}

export function relativeVolume(candles: Candle[], period: number): number {
  if (candles.length === 0) return 0;
  const last = candles[candles.length - 1]!.volume;
  const avg = volumeSma(candles.slice(0, -1), period);
  if (avg === 0) return 0;
  return last / avg;
}

export function computeObv(candles: Candle[]): number[] {
  const out: number[] = [];
  let obv = 0;
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      out.push(0);
      continue;
    }
    const prev = candles[i - 1]!;
    const cur = candles[i]!;
    if (cur.close > prev.close) obv += cur.volume;
    else if (cur.close < prev.close) obv -= cur.volume;
    out.push(obv);
  }
  return out;
}

/**
 * Approximate volume delta from candle geometry when trade-level data is unavailable.
 * Positive = buying pressure, negative = selling pressure.
 */
export function approximateVolumeDelta(candle: Candle): number {
  const range = candle.high - candle.low;
  if (range === 0) return 0;
  const body = candle.close - candle.open;
  const closePos = (candle.close - candle.low) / range;
  // Weighted by how much of volume closes near the high vs low
  const buyShare = closePos;
  const sellShare = 1 - closePos;
  const signed = candle.volume * (buyShare - sellShare);
  // Reinforce with body direction
  if (body !== 0) {
    return signed * 0.7 + Math.sign(body) * candle.volume * 0.3 * Math.min(1, Math.abs(body) / range);
  }
  return signed;
}

export function cumulativeVolumeDelta(candles: Candle[]): number[] {
  const out: number[] = [];
  let cvd = 0;
  for (const c of candles) {
    cvd += approximateVolumeDelta(c);
    out.push(cvd);
  }
  return out;
}

export function volumeSmaSeries(candles: Candle[], period: number): number[] {
  return sma(
    candles.map((c) => c.volume),
    period,
  );
}

export function buySellPressure(candle: Candle): { buy: number; sell: number } {
  const range = candle.high - candle.low;
  if (range === 0) return { buy: 0.5, sell: 0.5 };
  const closePos = (candle.close - candle.low) / range;
  return { buy: closePos, sell: 1 - closePos };
}
