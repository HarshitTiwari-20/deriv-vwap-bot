/** Pure math helpers — deterministic, no side effects */

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function roundTo(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

export function pctChange(from: number, to: number): number {
  if (from === 0) return 0;
  return ((to - from) / from) * 100;
}

export function bps(from: number, to: number): number {
  if (from === 0) return 0;
  return ((to - from) / from) * 10_000;
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

export function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  let sum = 0;
  for (const v of values) sum += (v - m) ** 2;
  return Math.sqrt(sum / (values.length - 1));
}

export function sma(values: number[], period: number): number[] {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out.push(sum / period);
    else out.push(NaN);
  }
  return out;
}

export function ema(values: number[], period: number): number[] {
  const out: number[] = [];
  if (values.length === 0) return out;
  const k = 2 / (period + 1);
  let prev = values[0]!;
  for (let i = 0; i < values.length; i++) {
    if (i === 0) {
      out.push(prev);
      continue;
    }
    prev = values[i]! * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

export function trueRange(high: number, low: number, prevClose: number): number {
  return Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
}

export function atr(highs: number[], lows: number[], closes: number[], period: number): number[] {
  const out: number[] = [];
  const trs: number[] = [];
  for (let i = 0; i < highs.length; i++) {
    const pc = i === 0 ? closes[0]! : closes[i - 1]!;
    trs.push(trueRange(highs[i]!, lows[i]!, pc));
  }
  let sum = 0;
  for (let i = 0; i < trs.length; i++) {
    sum += trs[i]!;
    if (i >= period) sum -= trs[i - period]!;
    if (i >= period - 1) {
      if (i === period - 1) out.push(sum / period);
      else {
        const prev = out[out.length - 1]!;
        out.push((prev * (period - 1) + trs[i]!) / period);
      }
    } else {
      out.push(NaN);
    }
  }
  return out;
}

export function lastFinite(values: number[]): number {
  for (let i = values.length - 1; i >= 0; i--) {
    if (Number.isFinite(values[i]!)) return values[i]!;
  }
  return NaN;
}

export function max(values: number[]): number {
  let m = -Infinity;
  for (const v of values) if (v > m) m = v;
  return m;
}

export function min(values: number[]): number {
  let m = Infinity;
  for (const v of values) if (v < m) m = v;
  return m;
}

export function sum(values: number[]): number {
  let s = 0;
  for (const v of values) s += v;
  return s;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function nowMs(): number {
  return Date.now();
}

/** Floor timestamp to candle open for a given timeframe ms */
export function candleOpenTime(ts: number, tfMs: number): number {
  return Math.floor(ts / tfMs) * tfMs;
}
