import type { AppConfig } from '../../config/schema.js';
import type { Candle } from '../../types/market.js';
import type {
  ConfidenceBreakdown,
  ConfidenceScore,
  InstitutionalZone,
  LiquidityLevel,
  MarketStructureState,
  VolumeMetrics,
  VwapSnapshot,
} from '../../types/strategy.js';
import { atrPct } from '../../indicators/atr.js';
import { momentumScore } from '../../indicators/momentum.js';
import type { Side } from '../../types/trading.js';
import type { VwapEngine } from '../vwap/vwap-engine.js';

export interface ScoreInput {
  side: Side;
  vwap: VwapSnapshot;
  zone?: InstitutionalZone;
  structure: MarketStructureState;
  htStructure: MarketStructureState;
  volume: VolumeMetrics;
  liquidity: LiquidityLevel[];
  candles: Candle[];
  atr: number;
  price: number;
  retestQuality: number; // 0–1
}

const DEFAULT_WEIGHTS = {
  vwapAlignment: 20,
  institutionalZone: 20,
  marketStructure: 15,
  volumeSpike: 15,
  liquiditySweep: 10,
  trend: 10,
  atrVolatility: 5,
  retestQuality: 5,
  momentum: 5,
};

/**
 * Weighted confidence scoring. Trade only when total >= threshold (default 85).
 */
export class ScoringEngine {
  private readonly weights: typeof DEFAULT_WEIGHTS;
  private readonly minScore: number;

  constructor(
    private readonly vwapEngine: VwapEngine,
    config?: Pick<AppConfig, 'scoring' | 'risk'>,
  ) {
    this.weights = { ...DEFAULT_WEIGHTS, ...(config?.scoring?.weights ?? {}) };
    this.minScore = config?.risk?.minConfidenceScore ?? 85;
  }

  score(input: ScoreInput): ConfidenceScore {
    const reasons: string[] = [];
    const w = this.weights;
    const wantTrend = input.side === 'buy' ? 'bullish' : 'bearish';
    const wantBias = input.side === 'buy' ? 'long' : 'short';

    // VWAP Alignment (0–weight)
    const vwapAlign = this.vwapEngine.alignmentScore(input.vwap, input.side);
    const vwapAlignment = vwapAlign * w.vwapAlignment;
    if (vwapAlign >= 0.6) {
      reasons.push(input.side === 'buy' ? 'Above VWAP' : 'Below VWAP');
    }

    // Institutional Zone
    let zoneScore = 0;
    if (input.zone) {
      const strength = Math.min(1, input.zone.strengthScore / 100);
      const fresh = input.zone.freshness / 100;
      const retestBonus = input.zone.retestCount > 0 && input.zone.retestCount <= 3 ? 0.2 : 0;
      zoneScore = Math.min(1, strength * 0.6 + fresh * 0.2 + retestBonus) * w.institutionalZone;
      reasons.push(
        input.zone.type === 'demand' ? 'Institutional Demand Zone' : 'Institutional Supply Zone',
      );
    }

    // Market Structure
    let structPts = 0;
    if (input.structure.trend === wantTrend) structPts += 0.4;
    if (input.structure.internalTrend === wantTrend) structPts += 0.2;
    const bosOk =
      (input.structure.lastBos?.direction === wantTrend) ||
      (input.structure.lastChoch?.direction === wantTrend) ||
      input.structure.recentEvents.some(
        (e) =>
          (e.type === 'BOS' || e.type === 'CHOCH') &&
          e.direction === wantTrend &&
          input.structure.timestamp - e.time < 60 * 60_000,
      );
    if (bosOk) {
      structPts += 0.4;
      reasons.push(input.structure.lastChoch?.direction === wantTrend ? 'CHoCH Confirmed' : 'BOS Confirmed');
    }
    const marketStructure = Math.min(1, structPts) * w.marketStructure;

    // Volume Spike
    let volPts = 0;
    if (input.volume.spike) {
      volPts += 0.5;
      reasons.push('High Relative Volume');
    }
    if (input.volume.rvol >= 1.5) volPts += 0.25;
    if (input.side === 'buy' && input.volume.buyPressure >= 0.55) volPts += 0.25;
    if (input.side === 'sell' && input.volume.sellPressure >= 0.55) volPts += 0.25;
    const volumeSpike = Math.min(1, volPts) * w.volumeSpike;

    // Liquidity Sweep
    const sweep = input.liquidity.find(
      (l) =>
        l.confirmed &&
        l.swept &&
        ((input.side === 'buy' && l.side === 'buy_side') ||
          (input.side === 'sell' && l.side === 'sell_side')),
    );
    let liqPts = 0;
    if (sweep) {
      liqPts = Math.min(1, sweep.strength / 100);
      reasons.push('Liquidity Sweep Confirmed');
    }
    const liquiditySweep = liqPts * w.liquiditySweep;

    // Higher timeframe trend
    let trendPts = 0;
    if (input.htStructure.trend === wantTrend) {
      trendPts = 0.6 + Math.min(0.4, input.htStructure.trendStrength / 100);
      reasons.push('HTF Trend Aligned');
    } else if (input.htStructure.trend === 'ranging') {
      trendPts = 0.25;
    }
    const trend = trendPts * w.trend;

    // ATR volatility — prefer moderate
    const ap = atrPct(input.atr, input.price);
    let atrPts = 0;
    if (ap >= 0.3 && ap <= 5) atrPts = 1;
    else if (ap > 0.1 && ap < 8) atrPts = 0.5;
    const atrVolatility = atrPts * w.atrVolatility;

    // Retest quality
    const retestQuality = Math.min(1, Math.max(0, input.retestQuality)) * w.retestQuality;
    if (input.retestQuality >= 0.7) reasons.push('Strong Retest');

    // Momentum
    const mom = momentumScore(input.candles) / 100;
    let momPts = input.side === 'buy' ? mom : 1 - mom;
    // Center around agreement
    momPts = Math.max(0, (momPts - 0.35) / 0.65);
    const momentum = momPts * w.momentum;
    if (momPts > 0.6) reasons.push('Momentum Supports');

    const breakdown: ConfidenceBreakdown = {
      vwapAlignment,
      institutionalZone: zoneScore,
      marketStructure,
      volumeSpike,
      liquiditySweep,
      trend,
      atrVolatility,
      retestQuality,
      momentum,
    };

    const total = Object.values(breakdown).reduce((a, b) => a + b, 0);
    const maxPossible = Object.values(w).reduce((a, b) => a + b, 0);
    const rounded = Math.round(total * 10) / 10;

    // Soft requirement: primaryBias should not strongly oppose
    if (input.vwap.primaryBias !== wantBias && input.vwap.primaryBias !== 'neutral') {
      reasons.push('VWAP bias conflict (penalized)');
    }

    return {
      total: rounded,
      breakdown,
      maxPossible,
      reasons,
      passed: rounded >= this.minScore,
    };
  }
}
