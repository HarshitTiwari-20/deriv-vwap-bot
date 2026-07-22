import type { Candle } from '../types/market.js';
import { ema } from '../utils/math.js';
import { computeAtrSeries } from './atr.js';
import { rsi as simpleRsi } from './momentum.js';

export interface MacdResult {
  macd: number;
  signal: number;
  histogram: number;
  /** +1 bullish cross this bar, -1 bearish, 0 none */
  cross: -1 | 0 | 1;
  bullish: boolean;
}

export interface SupertrendResult {
  value: number;
  direction: 'up' | 'down';
  /** flipped this bar */
  flipped: boolean;
}

export interface IndicatorSnapshot {
  rsi: number;
  macd: MacdResult;
  supertrend: SupertrendResult;
  emaFast: number;
  emaSlow: number;
  emaBullish: boolean;
  /** 0–100 composite for ranking */
  bullScore: number;
  bearScore: number;
}

/** Wilder-style RSI (smoothed) when enough data; falls back to simple */
export function rsiWilder(candles: Candle[], period = 14): number {
  if (candles.length < period + 2) return simpleRsi(candles, period);
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = candles[i]!.close - candles[i - 1]!.close;
    if (d >= 0) avgGain += d;
    else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < candles.length; i++) {
    const d = candles[i]!.close - candles[i - 1]!.close;
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function macd(
  candles: Candle[],
  fast = 12,
  slow = 26,
  signalPeriod = 9,
): MacdResult {
  const closes = candles.map((c) => c.close);
  if (closes.length < slow + signalPeriod) {
    return { macd: 0, signal: 0, histogram: 0, cross: 0, bullish: false };
  }
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    const f = emaFast[i]!;
    const s = emaSlow[i]!;
    macdLine.push(Number.isFinite(f) && Number.isFinite(s) ? f - s : NaN);
  }
  // signal EMA on macd line (skip leading NaNs)
  const validStart = macdLine.findIndex((v) => Number.isFinite(v));
  const slice = macdLine.slice(validStart).map((v) => (Number.isFinite(v) ? v : 0));
  const sigArr = ema(slice, signalPeriod);
  const macdNow = macdLine[macdLine.length - 1]!;
  const macdPrev = macdLine[macdLine.length - 2]!;
  const sigNow = sigArr[sigArr.length - 1]!;
  const sigPrev = sigArr[sigArr.length - 2] ?? sigNow;
  const hist = macdNow - sigNow;
  let cross: -1 | 0 | 1 = 0;
  if (Number.isFinite(macdPrev) && Number.isFinite(sigPrev)) {
    if (macdPrev <= sigPrev && macdNow > sigNow) cross = 1;
    if (macdPrev >= sigPrev && macdNow < sigNow) cross = -1;
  }
  return {
    macd: macdNow,
    signal: sigNow,
    histogram: hist,
    cross,
    bullish: macdNow > sigNow && hist > 0,
  };
}

/**
 * Supertrend (ATR-based). direction 'up' = bullish (price above band).
 */
export function supertrend(
  candles: Candle[],
  period = 10,
  multiplier = 3,
): SupertrendResult {
  if (candles.length < period + 2) {
    const last = candles[candles.length - 1];
    return {
      value: last?.close ?? 0,
      direction: 'up',
      flipped: false,
    };
  }
  const atrs = computeAtrSeries(candles, period);
  let upper = 0;
  let lower = 0;
  let dir: 'up' | 'down' = 'up';
  let st = candles[period]!.close;
  let prevDir: 'up' | 'down' = 'up';

  for (let i = period; i < candles.length; i++) {
    const c = candles[i]!;
    const atr = atrs[i]!;
    if (!Number.isFinite(atr) || atr <= 0) continue;
    const mid = (c.high + c.low) / 2;
    let basicUpper = mid + multiplier * atr;
    let basicLower = mid - multiplier * atr;

    if (i === period) {
      upper = basicUpper;
      lower = basicLower;
      dir = c.close >= mid ? 'up' : 'down';
      st = dir === 'up' ? lower : upper;
      prevDir = dir;
      continue;
    }

    const prevClose = candles[i - 1]!.close;
    // Final bands
    if (basicLower > lower || prevClose < lower) lower = basicLower;
    else lower = lower;
    if (basicUpper < upper || prevClose > upper) upper = basicUpper;
    else upper = upper;

    // Supertrend switch
    if (dir === 'up') {
      if (c.close < lower) {
        dir = 'down';
        st = upper;
      } else {
        st = lower;
      }
    } else {
      if (c.close > upper) {
        dir = 'up';
        st = lower;
      } else {
        st = upper;
      }
    }

    if (i === candles.length - 1) {
      const flipped = dir !== prevDir;
      return { value: st, direction: dir, flipped };
    }
    prevDir = dir;
  }

  return { value: st, direction: dir, flipped: false };
}

export function snapshotIndicators(candles: Candle[]): IndicatorSnapshot {
  const closes = candles.map((c) => c.close);
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const emaFast = e9[e9.length - 1] ?? closes[closes.length - 1] ?? 0;
  const emaSlow = e21[e21.length - 1] ?? emaFast;
  const emaBullish = emaFast > emaSlow;
  const rsi = rsiWilder(candles, 14);
  const m = macd(candles);
  const st = supertrend(candles, 10, 3);

  // Composite directional scores 0–100
  let bull = 50;
  let bear = 50;
  if (st.direction === 'up') bull += 18;
  else bear += 18;
  if (m.bullish) bull += 15;
  else bear += 15;
  if (m.cross === 1) bull += 12;
  if (m.cross === -1) bear += 12;
  if (rsi >= 45 && rsi <= 68) bull += 10;
  if (rsi >= 32 && rsi <= 55) bear += 10;
  if (rsi < 35) bull += 8; // oversold bounce potential
  if (rsi > 65) bear += 8;
  if (emaBullish) bull += 10;
  else bear += 10;

  return {
    rsi,
    macd: m,
    supertrend: st,
    emaFast,
    emaSlow,
    emaBullish,
    bullScore: Math.max(0, Math.min(100, bull)),
    bearScore: Math.max(0, Math.min(100, bear)),
  };
}

/**
 * Short-TF entry vote: need majority of indicators aligned.
 * Returns score 0–1 and reasons.
 */
export function indicatorEntryVote(
  side: 'buy' | 'sell',
  ind: IndicatorSnapshot,
  rvol: number,
): { ok: boolean; score: number; reasons: string[] } {
  const reasons: string[] = [];
  let pts = 0;
  const need = side === 'buy';

  // Supertrend
  if (need && ind.supertrend.direction === 'up') {
    pts += 1;
    reasons.push('Supertrend UP');
  } else if (!need && ind.supertrend.direction === 'down') {
    pts += 1;
    reasons.push('Supertrend DOWN');
  }
  if (need && ind.supertrend.flipped && ind.supertrend.direction === 'up') {
    pts += 0.5;
    reasons.push('ST flip bull');
  }
  if (!need && ind.supertrend.flipped && ind.supertrend.direction === 'down') {
    pts += 0.5;
    reasons.push('ST flip bear');
  }

  // MACD
  if (need && (ind.macd.bullish || ind.macd.cross === 1)) {
    pts += 1;
    reasons.push(ind.macd.cross === 1 ? 'MACD bull cross' : 'MACD bullish');
  }
  if (!need && (!ind.macd.bullish || ind.macd.cross === -1)) {
    pts += 1;
    reasons.push(ind.macd.cross === -1 ? 'MACD bear cross' : 'MACD bearish');
  }

  // RSI
  if (need && ind.rsi >= 40 && ind.rsi <= 72) {
    pts += 1;
    reasons.push(`RSI ${ind.rsi.toFixed(0)}`);
  } else if (need && ind.rsi < 40 && ind.rsi > 25) {
    pts += 0.75;
    reasons.push(`RSI oversold bounce ${ind.rsi.toFixed(0)}`);
  }
  if (!need && ind.rsi <= 60 && ind.rsi >= 28) {
    pts += 1;
    reasons.push(`RSI ${ind.rsi.toFixed(0)}`);
  } else if (!need && ind.rsi > 60 && ind.rsi < 80) {
    pts += 0.75;
    reasons.push(`RSI overbought fade ${ind.rsi.toFixed(0)}`);
  }

  // EMA trend
  if (need && ind.emaBullish) {
    pts += 0.75;
    reasons.push('EMA9>EMA21');
  }
  if (!need && !ind.emaBullish) {
    pts += 0.75;
    reasons.push('EMA9<EMA21');
  }

  // Volume
  if (rvol >= 1.15) {
    pts += 1;
    reasons.push(`Vol x${rvol.toFixed(1)}`);
  } else if (rvol >= 0.9) {
    pts += 0.4;
    reasons.push(`Vol ok x${rvol.toFixed(1)}`);
  }

  // Need at least ~3.0 / 5.25 of weighted points
  const maxPts = 5.25;
  const score = pts / maxPts;
  const ok = pts >= 3.0;
  return { ok, score, reasons };
}
