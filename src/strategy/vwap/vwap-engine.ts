import type { Candle, Timeframe } from '../../types/market.js';
import type {
  VwapAnchor,
  VwapPoint,
  VwapSnapshot,
  VwapType,
} from '../../types/strategy.js';
import { pctChange } from '../../utils/math.js';

export interface VwapEngineOptions {
  stdDevMultiplier?: number;
}

interface RunningVwap {
  cumPV: number;
  cumVol: number;
  cumPV2: number;
}

function typicalPrice(c: Candle): number {
  return (c.high + c.low + c.close) / 3;
}

function emptyRunning(): RunningVwap {
  return { cumPV: 0, cumVol: 0, cumPV2: 0 };
}

function updateRunning(r: RunningVwap, c: Candle): void {
  const tp = typicalPrice(c);
  const v = c.volume;
  r.cumPV += tp * v;
  r.cumVol += v;
  r.cumPV2 += tp * tp * v;
}

function finalize(
  type: VwapType,
  r: RunningVwap,
  price: number,
  atr: number,
  stdMult: number,
  anchor?: VwapAnchor,
  anchorTime?: number,
): VwapPoint {
  const value = r.cumVol > 0 ? r.cumPV / r.cumVol : price;
  const variance = r.cumVol > 0 ? r.cumPV2 / r.cumVol - value * value : 0;
  const sd = Math.sqrt(Math.max(0, variance));
  const distancePct = pctChange(value, price);
  const distanceAtr = atr > 0 ? (price - value) / atr : 0;
  let bias: VwapPoint['bias'] = 'neutral';
  if (price > value * 1.0001) bias = 'long';
  else if (price < value * 0.9999) bias = 'short';

  return {
    type,
    value,
    upperBand: value + stdMult * sd,
    lowerBand: value - stdMult * sd,
    anchor,
    anchorTime,
    distancePct,
    distanceAtr,
    bias,
  };
}

function startOfUtcDay(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function startOfUtcWeek(ts: number): number {
  const d = new Date(ts);
  const day = d.getUTCDay(); // 0 Sun
  const diff = day === 0 ? 6 : day - 1; // Monday start
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diff);
}

function startOfUtcMonth(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/**
 * Multi-session VWAP engine with anchored variants.
 * Only uses closed candles up to the analysis point — no look-ahead.
 */
export class VwapEngine {
  private readonly stdMult: number;

  constructor(options: VwapEngineOptions = {}) {
    this.stdMult = options.stdDevMultiplier ?? 1.0;
  }

  computeSessionVwap(candles: Candle[], price: number, atr: number): VwapPoint {
    // Session = UTC day for crypto
    if (candles.length === 0) {
      return finalize('session', emptyRunning(), price, atr, this.stdMult, 'session_start');
    }
    const lastTs = candles[candles.length - 1]!.openTime;
    const sessionStart = startOfUtcDay(lastTs);
    const r = emptyRunning();
    for (const c of candles) {
      if (c.openTime >= sessionStart) updateRunning(r, c);
    }
    return finalize('session', r, price, atr, this.stdMult, 'session_start', sessionStart);
  }

  computePeriodVwap(
    candles: Candle[],
    price: number,
    atr: number,
    type: 'daily' | 'weekly' | 'monthly',
  ): VwapPoint {
    if (candles.length === 0) {
      return finalize(type, emptyRunning(), price, atr, this.stdMult);
    }
    const lastTs = candles[candles.length - 1]!.openTime;
    const start =
      type === 'daily'
        ? startOfUtcDay(lastTs)
        : type === 'weekly'
          ? startOfUtcWeek(lastTs)
          : startOfUtcMonth(lastTs);
    const r = emptyRunning();
    for (const c of candles) {
      if (c.openTime >= start) updateRunning(r, c);
    }
    return finalize(type, r, price, atr, this.stdMult, undefined, start);
  }

  computeAnchoredVwap(
    candles: Candle[],
    price: number,
    atr: number,
    fromIndex: number,
    anchor: VwapAnchor,
  ): VwapPoint {
    const r = emptyRunning();
    const start = Math.max(0, fromIndex);
    for (let i = start; i < candles.length; i++) {
      updateRunning(r, candles[i]!);
    }
    const anchorTime = candles[start]?.openTime;
    return finalize('anchored', r, price, atr, this.stdMult, anchor, anchorTime);
  }

  findHighestVolumeIndex(candles: Candle[], lookback = 100): number {
    const start = Math.max(0, candles.length - lookback);
    let maxV = -1;
    let idx = start;
    for (let i = start; i < candles.length; i++) {
      if (candles[i]!.volume > maxV) {
        maxV = candles[i]!.volume;
        idx = i;
      }
    }
    return idx;
  }

  findSwingHighIndex(candles: Candle[], left = 5, right = 5): number {
    for (let i = candles.length - 1 - right; i >= left; i--) {
      const h = candles[i]!.high;
      let isSwing = true;
      for (let j = i - left; j <= i + right; j++) {
        if (j === i) continue;
        if (candles[j]!.high >= h) {
          isSwing = false;
          break;
        }
      }
      if (isSwing) return i;
    }
    return Math.max(0, candles.length - 20);
  }

  findSwingLowIndex(candles: Candle[], left = 5, right = 5): number {
    for (let i = candles.length - 1 - right; i >= left; i--) {
      const l = candles[i]!.low;
      let isSwing = true;
      for (let j = i - left; j <= i + right; j++) {
        if (j === i) continue;
        if (candles[j]!.low <= l) {
          isSwing = false;
          break;
        }
      }
      if (isSwing) return i;
    }
    return Math.max(0, candles.length - 20);
  }

  /**
   * Build full VWAP snapshot for a symbol. Prefer higher-TF candles for weekly/monthly
   * when available; falls back to provided series.
   */
  snapshot(
    symbol: string,
    timeframe: Timeframe,
    candles: Candle[],
    price: number,
    atr: number,
    bosIndex?: number,
  ): VwapSnapshot {
    // Only closed candles for deterministic analysis
    const closed = candles.filter((c) => c.closed);
    const series = closed.length > 0 ? closed : candles;

    const session = this.computeSessionVwap(series, price, atr);
    const daily = this.computePeriodVwap(series, price, atr, 'daily');
    const weekly = this.computePeriodVwap(series, price, atr, 'weekly');
    const monthly = this.computePeriodVwap(series, price, atr, 'monthly');

    const anchored: VwapPoint[] = [];
    if (series.length > 10) {
      const hv = this.findHighestVolumeIndex(series);
      anchored.push(
        this.computeAnchoredVwap(series, price, atr, hv, 'highest_volume'),
      );
      const sh = this.findSwingHighIndex(series);
      anchored.push(this.computeAnchoredVwap(series, price, atr, sh, 'swing_high'));
      const sl = this.findSwingLowIndex(series);
      anchored.push(this.computeAnchoredVwap(series, price, atr, sl, 'swing_low'));
      if (bosIndex !== undefined && bosIndex >= 0) {
        anchored.push(this.computeAnchoredVwap(series, price, atr, bosIndex, 'bos'));
      }
      const dayStart = startOfUtcDay(series[series.length - 1]!.openTime);
      const dayIdx = series.findIndex((c) => c.openTime >= dayStart);
      if (dayIdx >= 0) {
        anchored.push(
          this.computeAnchoredVwap(series, price, atr, dayIdx, 'session_start'),
        );
      }
    }

    // Primary bias: majority of session + daily + weekly
    const votes = [session.bias, daily.bias, weekly.bias];
    const longVotes = votes.filter((b) => b === 'long').length;
    const shortVotes = votes.filter((b) => b === 'short').length;
    let primaryBias: VwapSnapshot['primaryBias'] = 'neutral';
    if (longVotes >= 2) primaryBias = 'long';
    else if (shortVotes >= 2) primaryBias = 'short';

    return {
      symbol,
      timeframe,
      price,
      session,
      daily,
      weekly,
      monthly,
      anchored,
      primaryBias,
      timestamp: series[series.length - 1]?.closeTime ?? Date.now(),
    };
  }

  /** Alignment score 0–1 for long/short side */
  alignmentScore(snapshot: VwapSnapshot, side: 'buy' | 'sell'): number {
    const want: VwapPoint['bias'] = side === 'buy' ? 'long' : 'short';
    const points = [snapshot.session, snapshot.daily, snapshot.weekly];
    let score = 0;
    for (const p of points) {
      if (p.bias === want) score += 1;
      else if (p.bias === 'neutral') score += 0.3;
    }
    // Anchored confirmation
    const anchoredAgree = snapshot.anchored.filter((a) => a.bias === want).length;
    if (snapshot.anchored.length > 0) {
      score += (anchoredAgree / snapshot.anchored.length) * 0.5;
    }
    // Prefer not too extended from session VWAP
    const ext = Math.abs(snapshot.session.distanceAtr);
    if (ext < 1.5) score += 0.3;
    else if (ext > 3) score -= 0.4;
    return Math.max(0, Math.min(1, score / 3.8));
  }
}
