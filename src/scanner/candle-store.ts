import type { Candle, Timeframe } from '../types/market.js';

/**
 * In-memory ring buffer of candles per symbol/timeframe.
 * Thread-safe enough for single-threaded Node; workers get serialized snapshots.
 */
export class CandleStore {
  private readonly data = new Map<string, Candle[]>();
  private readonly maxBars: number;

  constructor(maxBars = 500) {
    this.maxBars = maxBars;
  }

  private key(symbol: string, tf: Timeframe): string {
    return `${symbol}:${tf}`;
  }

  get(symbol: string, tf: Timeframe): Candle[] {
    return this.data.get(this.key(symbol, tf)) ?? [];
  }

  set(symbol: string, tf: Timeframe, candles: Candle[]): void {
    const sorted = [...candles].sort((a, b) => a.openTime - b.openTime);
    this.data.set(this.key(symbol, tf), sorted.slice(-this.maxBars));
  }

  upsert(candle: Candle): { closed: boolean; candle: Candle } {
    const k = this.key(candle.symbol, candle.timeframe);
    const arr = this.data.get(k) ?? [];
    const idx = arr.findIndex((c) => c.openTime === candle.openTime);
    let closedTransition = false;
    let merged = candle;
    if (idx >= 0) {
      const prev = arr[idx]!;
      // Ticker/WS updates often have volume=0 — never wipe REST volume/history
      if ((!merged.volume || merged.volume <= 0) && prev.volume > 0) {
        merged = {
          ...merged,
          volume: prev.volume,
          quoteVolume: prev.quoteVolume || prev.volume * merged.close,
          open: prev.open || merged.open,
          high: Math.max(prev.high, merged.high),
          low: Math.min(prev.low || merged.low, merged.low),
        };
      } else {
        merged = {
          ...merged,
          high: Math.max(prev.high, merged.high),
          low: Math.min(prev.low, merged.low),
          open: prev.open,
        };
      }
      // Prefer keeping closed=true once REST marked it closed
      if (prev.closed && !merged.closed) {
        merged = { ...merged, closed: true, close: prev.close };
      }
      if (!prev.closed && merged.closed) closedTransition = true;
      arr[idx] = merged;
    } else {
      arr.push(merged);
      arr.sort((a, b) => a.openTime - b.openTime);
      if (merged.closed) closedTransition = true;
    }
    while (arr.length > this.maxBars) arr.shift();
    this.data.set(k, arr);
    return { closed: closedTransition, candle: merged };
  }

  symbols(): string[] {
    const set = new Set<string>();
    for (const k of this.data.keys()) set.add(k.split(':')[0]!);
    return [...set];
  }

  snapshot(
    symbol: string,
    timeframes: Timeframe[],
  ): Record<Timeframe, Candle[]> {
    const out = {} as Record<Timeframe, Candle[]>;
    for (const tf of timeframes) {
      out[tf] = this.get(symbol, tf).map((c) => ({ ...c }));
    }
    return out;
  }

  clear(symbol?: string): void {
    if (!symbol) {
      this.data.clear();
      return;
    }
    for (const k of [...this.data.keys()]) {
      if (k.startsWith(`${symbol}:`)) this.data.delete(k);
    }
  }
}
