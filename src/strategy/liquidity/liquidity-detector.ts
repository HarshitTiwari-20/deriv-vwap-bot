import type { Candle } from '../../types/market.js';
import type { LiquidityLevel, LiquidityType } from '../../types/strategy.js';
import { shortId } from '../../utils/id.js';

export interface LiquidityDetectorOptions {
  equalTolerancePct?: number;
  swingLeft?: number;
  swingRight?: number;
  lookback?: number;
}

/**
 * Detects equal highs/lows, liquidity pools, stop hunts, and liquidity grabs.
 * Confirmation required after a sweep before treating as trade-ready.
 */
export class LiquidityDetector {
  private readonly tolPct: number;
  private readonly left: number;
  private readonly right: number;
  private readonly lookback: number;
  private readonly levels = new Map<string, LiquidityLevel[]>();

  constructor(options: LiquidityDetectorOptions = {}) {
    this.tolPct = options.equalTolerancePct ?? 0.1;
    this.left = options.swingLeft ?? 3;
    this.right = options.swingRight ?? 3;
    this.lookback = options.lookback ?? 80;
  }

  getLevels(symbol: string): LiquidityLevel[] {
    return this.levels.get(symbol) ?? [];
  }

  detect(symbol: string, candles: Candle[]): LiquidityLevel[] {
    const closed = candles.filter((c) => c.closed);
    if (closed.length < this.left + this.right + 10) return [];

    const slice = closed.slice(-this.lookback);
    const swings = this.findSwings(slice);
    const levels: LiquidityLevel[] = [];

    // Equal highs
    const highs = swings.filter((s) => s.kind === 'high');
    for (let i = 0; i < highs.length; i++) {
      for (let j = i + 1; j < highs.length; j++) {
        const a = highs[i]!;
        const b = highs[j]!;
        const mid = (a.price + b.price) / 2;
        if ((Math.abs(a.price - b.price) / mid) * 100 <= this.tolPct) {
          levels.push({
            id: shortId('liq'),
            symbol,
            type: 'equal_highs',
            price: mid,
            high: Math.max(a.price, b.price),
            low: Math.min(a.price, b.price),
            side: 'sell_side',
            strength: 60 + Math.min(30, (j - i) * 5),
            swept: false,
            confirmed: false,
            timestamp: b.time,
          });
        }
      }
    }

    // Equal lows
    const lows = swings.filter((s) => s.kind === 'low');
    for (let i = 0; i < lows.length; i++) {
      for (let j = i + 1; j < lows.length; j++) {
        const a = lows[i]!;
        const b = lows[j]!;
        const mid = (a.price + b.price) / 2;
        if ((Math.abs(a.price - b.price) / mid) * 100 <= this.tolPct) {
          levels.push({
            id: shortId('liq'),
            symbol,
            type: 'equal_lows',
            price: mid,
            high: Math.max(a.price, b.price),
            low: Math.min(a.price, b.price),
            side: 'buy_side',
            strength: 60 + Math.min(30, (j - i) * 5),
            swept: false,
            confirmed: false,
            timestamp: b.time,
          });
        }
      }
    }

    // Liquidity pools: cluster of swings within tolerance
    this.addPools(symbol, highs, 'sell_side', levels);
    this.addPools(symbol, lows, 'buy_side', levels);

    // Detect sweeps on the most recent closed candles
    this.markSweeps(symbol, slice, levels);

    // Dedupe similar prices
    const deduped = this.dedupe(levels);
    this.levels.set(symbol, deduped);
    return deduped;
  }

  private findSwings(
    candles: Candle[],
  ): Array<{ price: number; time: number; kind: 'high' | 'low'; idx: number }> {
    const out: Array<{ price: number; time: number; kind: 'high' | 'low'; idx: number }> = [];
    const end = candles.length - this.right;
    for (let i = this.left; i < end; i++) {
      const c = candles[i]!;
      let isH = true;
      let isL = true;
      for (let j = i - this.left; j <= i + this.right; j++) {
        if (j === i) continue;
        if (candles[j]!.high >= c.high) isH = false;
        if (candles[j]!.low <= c.low) isL = false;
      }
      if (isH) out.push({ price: c.high, time: c.openTime, kind: 'high', idx: i });
      if (isL) out.push({ price: c.low, time: c.openTime, kind: 'low', idx: i });
    }
    return out;
  }

  private addPools(
    symbol: string,
    swings: Array<{ price: number; time: number }>,
    side: 'buy_side' | 'sell_side',
    levels: LiquidityLevel[],
  ): void {
    if (swings.length < 3) return;
    const used = new Set<number>();
    for (let i = 0; i < swings.length; i++) {
      if (used.has(i)) continue;
      const cluster = [swings[i]!];
      for (let j = i + 1; j < swings.length; j++) {
        if (used.has(j)) continue;
        const mid = (swings[i]!.price + swings[j]!.price) / 2;
        if ((Math.abs(swings[i]!.price - swings[j]!.price) / mid) * 100 <= this.tolPct * 1.5) {
          cluster.push(swings[j]!);
          used.add(j);
        }
      }
      if (cluster.length >= 3) {
        used.add(i);
        const prices = cluster.map((c) => c.price);
        const high = Math.max(...prices);
        const low = Math.min(...prices);
        levels.push({
          id: shortId('liq'),
          symbol,
          type: 'liquidity_pool',
          price: (high + low) / 2,
          high,
          low,
          side,
          strength: 70 + cluster.length * 5,
          swept: false,
          confirmed: false,
          timestamp: cluster[cluster.length - 1]!.time,
        });
      }
    }
  }

  private markSweeps(symbol: string, candles: Candle[], levels: LiquidityLevel[]): void {
    if (candles.length < 3) return;
    // Check last 5 closed candles for sweep + reclaim
    const recent = candles.slice(-5);
    for (const level of levels) {
      for (let i = 0; i < recent.length; i++) {
        const c = recent[i]!;
        let swept = false;
        if (level.side === 'sell_side' && c.high > level.high) {
          // Took sell-side liquidity (above equal highs)
          swept = true;
        }
        if (level.side === 'buy_side' && c.low < level.low) {
          swept = true;
        }
        if (!swept) continue;

        level.swept = true;
        level.sweepTime = c.closeTime;

        // Confirmation: next closed candle reclaims back inside / opposite direction
        const next = recent[i + 1];
        if (next && next.closed) {
          if (level.side === 'sell_side' && next.close < level.price) {
            // Sweep highs then close back below = stop hunt / liquidity grab for shorts cleared, bullish
            level.confirmed = true;
            level.type = this.classifySweep(level.type, 'bullish');
          }
          if (level.side === 'buy_side' && next.close > level.price) {
            level.confirmed = true;
            level.type = this.classifySweep(level.type, 'bearish');
          }
        }

        // Same candle reclaim (wick sweep)
        if (level.side === 'sell_side' && c.high > level.high && c.close < level.price) {
          level.confirmed = true;
          level.type = 'liquidity_grab';
        }
        if (level.side === 'buy_side' && c.low < level.low && c.close > level.price) {
          level.confirmed = true;
          level.type = 'liquidity_grab';
        }
      }
    }

    // Swing failures / false breakouts on last swing
    this.detectSwingFailures(symbol, candles, levels);
  }

  private classifySweep(prev: LiquidityType, _dir: 'bullish' | 'bearish'): LiquidityType {
    if (prev === 'equal_highs' || prev === 'equal_lows' || prev === 'liquidity_pool') {
      return 'stop_hunt';
    }
    return 'liquidity_grab';
  }

  private detectSwingFailures(
    symbol: string,
    candles: Candle[],
    levels: LiquidityLevel[],
  ): void {
    if (candles.length < 15) return;
    const swings = this.findSwings(candles);
    if (swings.length < 2) return;
    const last = candles[candles.length - 1]!;
    const lastHigh = [...swings].reverse().find((s) => s.kind === 'high');
    const lastLow = [...swings].reverse().find((s) => s.kind === 'low');

    if (lastHigh && last.high > lastHigh.price && last.close < lastHigh.price && last.closed) {
      levels.push({
        id: shortId('liq'),
        symbol,
        type: 'false_breakout',
        price: lastHigh.price,
        high: last.high,
        low: last.close,
        side: 'sell_side',
        strength: 75,
        swept: true,
        sweepTime: last.closeTime,
        confirmed: true,
        timestamp: last.closeTime,
      });
    }
    if (lastLow && last.low < lastLow.price && last.close > lastLow.price && last.closed) {
      levels.push({
        id: shortId('liq'),
        symbol,
        type: 'swing_failure',
        price: lastLow.price,
        high: last.close,
        low: last.low,
        side: 'buy_side',
        strength: 75,
        swept: true,
        sweepTime: last.closeTime,
        confirmed: true,
        timestamp: last.closeTime,
      });
    }
  }

  private dedupe(levels: LiquidityLevel[]): LiquidityLevel[] {
    const sorted = [...levels].sort((a, b) => b.strength - a.strength);
    const kept: LiquidityLevel[] = [];
    for (const l of sorted) {
      const near = kept.find(
        (k) =>
          k.side === l.side &&
          (Math.abs(k.price - l.price) / l.price) * 100 < this.tolPct * 2,
      );
      if (!near) kept.push(l);
      else if (l.confirmed && !near.confirmed) {
        // prefer confirmed
        const idx = kept.indexOf(near);
        kept[idx] = l;
      }
    }
    return kept.slice(0, 40);
  }

  /**
   * Recent confirmed sweep that supports a given trade direction.
   * Bullish: buy-side liquidity swept (stops below) then reclaimed.
   * Bearish: sell-side liquidity swept then reclaimed.
   */
  recentConfirmedSweep(
    symbol: string,
    side: 'buy' | 'sell',
    maxAgeMs = 45 * 60_000,
    now = Date.now(),
  ): LiquidityLevel | undefined {
    const wantSide = side === 'buy' ? 'buy_side' : 'sell_side';
    return this.getLevels(symbol)
      .filter(
        (l) =>
          l.confirmed &&
          l.swept &&
          l.side === wantSide &&
          (l.sweepTime ?? l.timestamp) >= now - maxAgeMs,
      )
      .sort((a, b) => (b.sweepTime ?? b.timestamp) - (a.sweepTime ?? a.timestamp))[0];
  }
}
