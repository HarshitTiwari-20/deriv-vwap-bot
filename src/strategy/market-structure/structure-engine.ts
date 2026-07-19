import type { Candle, Timeframe } from '../../types/market.js';
import type {
  MarketStructureState,
  StructureEvent,
  StructurePoint,
  TrendDirection,
} from '../../types/strategy.js';

export interface StructureEngineOptions {
  swingLeft?: number;
  swingRight?: number;
  maxEvents?: number;
}

/**
 * Market structure: HH/HL/LH/LL, BOS, CHoCH, internal vs external structure.
 * Swing points require `right` bars of confirmation — only closed candles.
 */
export class MarketStructureEngine {
  private readonly left: number;
  private readonly right: number;
  private readonly maxEvents: number;

  constructor(options: StructureEngineOptions = {}) {
    this.left = options.swingLeft ?? 5;
    this.right = options.swingRight ?? 5;
    this.maxEvents = options.maxEvents ?? 50;
  }

  private findSwings(candles: Candle[]): StructurePoint[] {
    const points: StructurePoint[] = [];
    // Need right bars confirmation; do not use unconfirmed right edge as swing
    const end = candles.length - this.right;
    for (let i = this.left; i < end; i++) {
      const c = candles[i]!;
      let isHigh = true;
      let isLow = true;
      for (let j = i - this.left; j <= i + this.right; j++) {
        if (j === i) continue;
        if (candles[j]!.high >= c.high) isHigh = false;
        if (candles[j]!.low <= c.low) isLow = false;
      }
      if (isHigh) {
        points.push({ price: c.high, time: c.openTime, kind: 'high', confirmed: true });
      }
      if (isLow) {
        points.push({ price: c.low, time: c.openTime, kind: 'low', confirmed: true });
      }
    }
    return points.sort((a, b) => a.time - b.time);
  }

  analyze(symbol: string, timeframe: Timeframe, candles: Candle[]): MarketStructureState {
    const closed = candles.filter((c) => c.closed);
    const empty: MarketStructureState = {
      symbol,
      timeframe,
      trend: 'ranging',
      trendStrength: 0,
      recentEvents: [],
      internalTrend: 'ranging',
      externalTrend: 'ranging',
      timestamp: Date.now(),
    };
    if (closed.length < this.left + this.right + 5) return empty;

    const swings = this.findSwings(closed);
    const highs = swings.filter((s) => s.kind === 'high');
    const lows = swings.filter((s) => s.kind === 'low');

    const events: StructureEvent[] = [];
    let trend: TrendDirection = 'ranging';
    let lastBos: StructureEvent | undefined;
    let lastChoch: StructureEvent | undefined;

    // Label HH/HL/LH/LL sequence
    for (let i = 1; i < highs.length; i++) {
      const prev = highs[i - 1]!;
      const cur = highs[i]!;
      if (cur.price > prev.price) {
        events.push({
          type: 'HH',
          price: cur.price,
          time: cur.time,
          direction: 'bullish',
          strength: ((cur.price - prev.price) / prev.price) * 100,
        });
      } else if (cur.price < prev.price) {
        events.push({
          type: 'LH',
          price: cur.price,
          time: cur.time,
          direction: 'bearish',
          strength: ((prev.price - cur.price) / prev.price) * 100,
        });
      }
    }
    for (let i = 1; i < lows.length; i++) {
      const prev = lows[i - 1]!;
      const cur = lows[i]!;
      if (cur.price > prev.price) {
        events.push({
          type: 'HL',
          price: cur.price,
          time: cur.time,
          direction: 'bullish',
          strength: ((cur.price - prev.price) / prev.price) * 100,
        });
      } else if (cur.price < prev.price) {
        events.push({
          type: 'LL',
          price: cur.price,
          time: cur.time,
          direction: 'bearish',
          strength: ((prev.price - cur.price) / prev.price) * 100,
        });
      }
    }

    events.sort((a, b) => a.time - b.time);

    // Determine trend from last few structure labels
    const recent = events.slice(-6);
    const bull = recent.filter((e) => e.type === 'HH' || e.type === 'HL').length;
    const bear = recent.filter((e) => e.type === 'LH' || e.type === 'LL').length;
    if (bull >= 3 && bull > bear) trend = 'bullish';
    else if (bear >= 3 && bear > bull) trend = 'bearish';
    else trend = 'ranging';

    // BOS / CHoCH using last confirmed swings vs last closed price
    const last = closed[closed.length - 1]!;
    const lastSwingHigh = highs[highs.length - 1];
    const lastSwingLow = lows[lows.length - 1];
    const prevSwingHigh = highs[highs.length - 2];
    const prevSwingLow = lows[lows.length - 2];

    // External structure uses broader swings (all); internal uses last 4 swings
    const internalHighs = highs.slice(-3);
    const internalLows = lows.slice(-3);
    let internalTrend: TrendDirection = 'ranging';
    if (internalHighs.length >= 2 && internalLows.length >= 2) {
      const ih =
        internalHighs[internalHighs.length - 1]!.price >
        internalHighs[internalHighs.length - 2]!.price;
      const il =
        internalLows[internalLows.length - 1]!.price >
        internalLows[internalLows.length - 2]!.price;
      if (ih && il) internalTrend = 'bullish';
      else if (!ih && !il) internalTrend = 'bearish';
    }

    let externalTrend: TrendDirection = trend;

    if (lastSwingHigh && last.closed && last.close > lastSwingHigh.price) {
      // Break above last swing high
      const isChoch = trend === 'bearish' || externalTrend === 'bearish';
      const ev: StructureEvent = {
        type: isChoch ? 'CHOCH' : 'BOS',
        price: last.close,
        time: last.closeTime,
        direction: 'bullish',
        brokenLevel: lastSwingHigh.price,
        strength: ((last.close - lastSwingHigh.price) / lastSwingHigh.price) * 100,
      };
      events.push(ev);
      if (isChoch) lastChoch = ev;
      else lastBos = ev;
      trend = 'bullish';
      externalTrend = 'bullish';
    }

    if (lastSwingLow && last.closed && last.close < lastSwingLow.price) {
      const isChoch = trend === 'bullish' || externalTrend === 'bullish';
      // Avoid double-counting if both somehow fire; prefer the more recent break
      if (!(lastSwingHigh && last.close > lastSwingHigh.price)) {
        const ev: StructureEvent = {
          type: isChoch ? 'CHOCH' : 'BOS',
          price: last.close,
          time: last.closeTime,
          direction: 'bearish',
          brokenLevel: lastSwingLow.price,
          strength: ((lastSwingLow.price - last.close) / lastSwingLow.price) * 100,
        };
        events.push(ev);
        if (isChoch) lastChoch = ev;
        else lastBos = ev;
        trend = 'bearish';
        externalTrend = 'bearish';
      }
    }

    // Internal BOS on last micro swings
    if (internalHighs.length >= 1 && last.close > internalHighs[internalHighs.length - 1]!.price) {
      events.push({
        type: 'internal_BOS',
        price: last.close,
        time: last.closeTime,
        direction: 'bullish',
        brokenLevel: internalHighs[internalHighs.length - 1]!.price,
        strength: 1,
      });
    }
    if (internalLows.length >= 1 && last.close < internalLows[internalLows.length - 1]!.price) {
      events.push({
        type: 'internal_BOS',
        price: last.close,
        time: last.closeTime,
        direction: 'bearish',
        brokenLevel: internalLows[internalLows.length - 1]!.price,
        strength: 1,
      });
    }

    // Trend strength 0–100
    const strengthFromEvents = Math.min(
      100,
      recent.reduce((s, e) => s + Math.min(5, e.strength * 10), 0) * 3 +
        (trend === 'ranging' ? 0 : 30),
    );

    // Find last BOS/CHOCH in events if not set this bar
    if (!lastBos) {
      lastBos = [...events].reverse().find((e) => e.type === 'BOS' || e.type === 'external_BOS');
    }
    if (!lastChoch) {
      lastChoch = [...events].reverse().find((e) => e.type === 'CHOCH');
    }

    return {
      symbol,
      timeframe,
      trend,
      trendStrength: strengthFromEvents,
      lastSwingHigh: lastSwingHigh,
      lastSwingLow: lastSwingLow,
      recentEvents: events.slice(-this.maxEvents),
      internalTrend,
      externalTrend,
      lastBos,
      lastChoch,
      timestamp: last.closeTime,
    };
  }

  /** Index of candle where last BOS occurred (for anchored VWAP) */
  lastBosIndex(candles: Candle[], state: MarketStructureState): number | undefined {
    if (!state.lastBos) return undefined;
    const t = state.lastBos.time;
    const idx = candles.findIndex((c) => c.closeTime === t || c.openTime === t);
    return idx >= 0 ? idx : undefined;
  }

  hasRecentBosOrChoch(
    state: MarketStructureState,
    direction: 'bullish' | 'bearish',
    maxAgeMs = 30 * 60_000,
  ): boolean {
    const now = state.timestamp;
    const check = (e?: StructureEvent) =>
      !!e && e.direction === direction && now - e.time <= maxAgeMs;

    if (check(state.lastBos) || check(state.lastChoch)) return true;

    return state.recentEvents.some(
      (e) =>
        (e.type === 'BOS' || e.type === 'CHOCH' || e.type === 'external_BOS') &&
        e.direction === direction &&
        now - e.time <= maxAgeMs,
    );
  }
}
