import type { CoinRankResult, SetupSignal } from '../../types/strategy.js';
import { clamp } from '../../utils/math.js';

export interface RankInput {
  symbol: string;
  institutionalVolume: number; // 0–100
  vwapAlignment: number; // 0–100
  momentum: number; // 0–100
  trendStrength: number; // 0–100
  atrScore: number; // 0–100 moderate preferred
  relativeVolume: number; // raw rvol
  liquidityQuality: number; // 0–100
  spreadBps: number;
  confidence: number; // 0–100
  signal?: SetupSignal;
}

const W = {
  institutionalVolume: 0.18,
  vwapAlignment: 0.15,
  momentum: 0.12,
  trendStrength: 0.12,
  atr: 0.08,
  relativeVolume: 0.12,
  liquidityQuality: 0.08,
  spread: 0.05,
  confidence: 0.1,
};

/**
 * Ranks 100–200 coins every scan cycle.
 * Pass topN=0 or Infinity to return the full ranked universe.
 */
export class RankingEngine {
  rank(inputs: RankInput[], topN = 10): CoinRankResult[] {
    const scored = inputs.map((input) => {
      const rvolScore = clamp((input.relativeVolume / 3) * 100, 0, 100);
      const spreadScore = clamp(100 - input.spreadBps * 2, 0, 100);

      const factors = {
        institutionalVolume: input.institutionalVolume,
        vwapAlignment: input.vwapAlignment,
        momentum: input.momentum,
        trendStrength: input.trendStrength,
        atr: input.atrScore,
        relativeVolume: rvolScore,
        liquidityQuality: input.liquidityQuality,
        spread: spreadScore,
        confidence: input.confidence,
      };

      const score =
        factors.institutionalVolume * W.institutionalVolume +
        factors.vwapAlignment * W.vwapAlignment +
        factors.momentum * W.momentum +
        factors.trendStrength * W.trendStrength +
        factors.atr * W.atr +
        factors.relativeVolume * W.relativeVolume +
        factors.liquidityQuality * W.liquidityQuality +
        factors.spread * W.spread +
        factors.confidence * W.confidence;

      return {
        symbol: input.symbol,
        rank: 0,
        score: Math.round(score * 100) / 100,
        factors,
        signal: input.signal,
        timestamp: Date.now(),
      } satisfies CoinRankResult;
    });

    scored.sort((a, b) => b.score - a.score);
    const all = scored.map((r, i) => ({ ...r, rank: i + 1 }));
    if (!topN || topN <= 0 || topN >= all.length) return all;
    return all.slice(0, topN);
  }
}
