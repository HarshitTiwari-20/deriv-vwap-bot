import type { AppConfig } from '../../config/schema.js';
import {
  isStrongBearishClose,
  isStrongBullishClose,
  momentumScore,
} from '../../indicators/momentum.js';
import { computeAtr, atrPct } from '../../indicators/atr.js';
import {
  indicatorEntryVote,
  snapshotIndicators,
  type IndicatorSnapshot,
} from '../../indicators/tech.js';
import type { AnalysisContext, ConfidenceScore, SetupSignal } from '../../types/strategy.js';
import type { Side } from '../../types/trading.js';
import { shortId } from '../../utils/id.js';
import type { InstitutionalZoneDetector } from '../institutional/zone-detector.js';
import type { LiquidityDetector } from '../liquidity/liquidity-detector.js';
import type { MarketStructureEngine } from '../market-structure/structure-engine.js';
import type { ScoringEngine } from '../scoring/scoring-engine.js';
import type { VolumeAnalyzer } from '../volume/volume-analyzer.js';
import type { VwapEngine } from '../vwap/vwap-engine.js';

export class SignalGenerator {
  constructor(
    private readonly vwap: VwapEngine,
    private readonly zones: InstitutionalZoneDetector,
    private readonly structure: MarketStructureEngine,
    private readonly liquidity: LiquidityDetector,
    private readonly volume: VolumeAnalyzer,
    private readonly scoring: ScoringEngine,
    private readonly config: AppConfig,
    /** Live capital profile (auto-scales TP/stops with wallet size) */
    private readonly getProfile?: () => import('../../risk/adaptive-limits.js').AdaptiveProfile,
  ) {}

  /**
   * Analyze a single symbol across required timeframes and optionally emit a setup.
   * Deterministic: only closed candles on primary TF used for entry decisions.
   */
  analyze(ctx: AnalysisContext): {
    signal?: SetupSignal;
    rankFactors: {
      institutionalVolume: number;
      vwapAlignment: number;
      momentum: number;
      trendStrength: number;
      atrScore: number;
      relativeVolume: number;
      liquidityQuality: number;
      confidence: number;
    };
  } {
    const primaryTf = this.config.strategy.primaryTimeframes[0] ?? '1m';
    const confirmTf = this.config.strategy.confirmationTimeframes[0] ?? '5m';
    const trendTf = this.config.strategy.trendTimeframe;

    const primary = ctx.candles[primaryTf] ?? [];
    const confirm = ctx.candles[confirmTf] ?? primary;
    const trendCandles = ctx.candles[trendTf] ?? confirm;

    const closedPrimary = primary.filter((c) => c.closed);
    if (closedPrimary.length < 30) {
      return {
        rankFactors: {
          institutionalVolume: 0,
          vwapAlignment: 0,
          momentum: 0,
          trendStrength: 0,
          atrScore: 0,
          relativeVolume: 0,
          liquidityQuality: 0,
          confidence: 0,
        },
      };
    }

    const atr = computeAtr(closedPrimary, this.config.strategy.atrPeriod) || ctx.atr;
    const price = closedPrimary[closedPrimary.length - 1]!.close;
    const lastCandle = closedPrimary[closedPrimary.length - 1]!;

    // Zones
    this.zones.detect(ctx.symbol, primaryTf, closedPrimary);
    // Structure
    const struct = this.structure.analyze(ctx.symbol, primaryTf, closedPrimary);
    const htStruct = this.structure.analyze(ctx.symbol, trendTf, trendCandles.filter((c) => c.closed));
    const bosIdx = this.structure.lastBosIndex(closedPrimary, struct);

    // VWAP
    const vwapSnap = this.vwap.snapshot(ctx.symbol, primaryTf, closedPrimary, price, atr, bosIdx);

    // Liquidity & volume
    const liq = this.liquidity.detect(ctx.symbol, closedPrimary);
    const vol = this.volume.analyze(ctx.symbol, primaryTf, closedPrimary);

    // Also run confirm TF structure lightly
    this.structure.analyze(ctx.symbol, confirmTf, confirm.filter((c) => c.closed));

    const mom = momentumScore(closedPrimary);
    const activeZones = this.zones.getActiveZones(ctx.symbol);
    const bestInstVol = activeZones.reduce((m, z) => Math.max(m, z.strengthScore), 0);
    const liqQuality = liq.reduce((m, l) => Math.max(m, l.confirmed ? l.strength : l.strength * 0.5), 0);

    const atrP = atrPct(atr, price);
    const atrScore =
      atrP >= 0.3 && atrP <= 5 ? 90 : atrP > 0.1 && atrP < 8 ? 60 : 20;

    // Short-TF indicators (RSI, MACD, Supertrend, EMA)
    const ind = snapshotIndicators(closedPrimary);

    // Determine candidate sides from HTF + VWAP + Supertrend
    const sides: Side[] = [];
    if (
      htStruct.trend === 'bullish' ||
      vwapSnap.primaryBias === 'long' ||
      ind.supertrend.direction === 'up'
    ) {
      sides.push('buy');
    }
    if (
      this.config.strategy.allowShort &&
      (htStruct.trend === 'bearish' ||
        vwapSnap.primaryBias === 'short' ||
        ind.supertrend.direction === 'down')
    ) {
      sides.push('sell');
    }
    if (sides.length === 0) {
      if (ind.bullScore >= ind.bearScore) sides.push('buy');
      else if (this.config.strategy.allowShort) sides.push('sell');
    }

    let bestSignal: SetupSignal | undefined;
    let bestConf = 0;

    for (const side of [...new Set(sides)]) {
      // 1) Institutional multi-factor path
      let signal = this.tryBuildSignal({
        symbol: ctx.symbol,
        side,
        primaryTf,
        closedPrimary,
        lastCandle,
        price,
        atr,
        struct,
        htStruct,
        vwapSnap,
        vol,
        liq,
      });
      // 2) Short-TF indicator path (RSI/MACD/ST/Vol) when enabled
      if (!signal && this.config.strategy.indicatorEntry !== false) {
        signal = this.tryBuildIndicatorSignal({
          symbol: ctx.symbol,
          side,
          primaryTf,
          closedPrimary,
          lastCandle,
          price,
          atr,
          struct,
          htStruct,
          vwapSnap,
          vol,
          liq,
          ind,
        });
      }
      if (signal && signal.confidence.total > bestConf) {
        bestConf = signal.confidence.total;
        bestSignal = signal;
      }
    }

    const vwapAlign =
      this.vwap.alignmentScore(vwapSnap, bestSignal?.side ?? 'buy') * 100;
    const indMom =
      bestSignal?.side === 'sell' ? ind.bearScore : ind.bullScore;

    return {
      signal: bestSignal,
      rankFactors: {
        institutionalVolume: bestInstVol,
        vwapAlignment: vwapAlign,
        momentum: Math.max(mom, indMom),
        trendStrength: Math.max(htStruct.trendStrength, ind.supertrend.direction === 'up' ? 70 : 40),
        atrScore,
        relativeVolume: vol.rvol,
        liquidityQuality: liqQuality,
        confidence: bestSignal?.confidence.total ?? Math.max(ind.bullScore, ind.bearScore) * 0.5,
      },
    };
  }

  private tryBuildSignal(args: {
    symbol: string;
    side: Side;
    primaryTf: '1m' | '3m' | '5m' | '15m' | '1h' | '4h' | '1d';
    closedPrimary: import('../../types/market.js').Candle[];
    lastCandle: import('../../types/market.js').Candle;
    price: number;
    atr: number;
    struct: import('../../types/strategy.js').MarketStructureState;
    htStruct: import('../../types/strategy.js').MarketStructureState;
    vwapSnap: import('../../types/strategy.js').VwapSnapshot;
    vol: import('../../types/strategy.js').VolumeMetrics;
    liq: import('../../types/strategy.js').LiquidityLevel[];
  }): SetupSignal | undefined {
    const {
      symbol,
      side,
      primaryTf,
      closedPrimary,
      lastCandle,
      price,
      atr,
      struct,
      htStruct,
      vwapSnap,
      vol,
      liq,
    } = args;

    const wantTrend = side === 'buy' ? 'bullish' : 'bearish';
    const relaxed = this.config.strategy.relaxedEntry === true;
    const minBody = relaxed
      ? Math.min(this.config.strategy.minBodyRatio, 0.45)
      : this.config.strategy.minBodyRatio;
    const maxWick = relaxed
      ? Math.max(this.config.strategy.maxWickRatio, 0.4)
      : this.config.strategy.maxWickRatio;
    const minRvol = relaxed ? 1.15 : 2.0;
    const bosWindowMs = relaxed ? 4 * 60 * 60_000 : 90 * 60_000;

    // --- Hard gates (ALL must pass) ---
    // 1. HTF trend
    if (htStruct.trend !== wantTrend && htStruct.trend !== 'ranging') return undefined;
    if (htStruct.trend === 'ranging' && struct.trend !== wantTrend && !relaxed) return undefined;
    // relaxed: allow ranging HTF if primary structure agrees or is also ranging with VWAP bias
    if (
      htStruct.trend === 'ranging' &&
      struct.trend !== wantTrend &&
      struct.internalTrend !== wantTrend &&
      relaxed
    ) {
      // still require VWAP bias match below
    }

    // 2. VWAP alignment
    if (side === 'buy' && vwapSnap.primaryBias === 'short') return undefined;
    if (side === 'sell' && vwapSnap.primaryBias === 'long') return undefined;
    const vwapTol = relaxed ? 0.995 : 0.998;
    if (side === 'buy' && price < vwapSnap.session.value * vwapTol) return undefined;
    if (side === 'sell' && price > vwapSnap.session.value * (2 - vwapTol)) return undefined;

    // 3. Institutional zone + retest
    const zone = this.zones.findRetestZone(symbol, side, price);
    if (!zone) return undefined;

    // 4. Structure + BOS/CHoCH
    if (struct.trend !== wantTrend && struct.internalTrend !== wantTrend && !relaxed) {
      return undefined;
    }
    if (!this.structure.hasRecentBosOrChoch(struct, wantTrend, bosWindowMs)) {
      // relaxed: accept HH/HL sequence without fresh BOS if trend already aligned
      if (!(relaxed && struct.trend === wantTrend)) return undefined;
    }

    // 5. Volume spike / elevated RVOL (also accept buy/sell pressure imbalance when relaxed)
    const volOk =
      vol.spike ||
      vol.rvol >= minRvol ||
      (relaxed &&
        ((side === 'buy' && vol.buyPressure >= 0.62) ||
          (side === 'sell' && vol.sellPressure >= 0.62)));
    if (!volOk) return undefined;

    // 6. Strong candle close
    const strong =
      side === 'buy'
        ? isStrongBullishClose(lastCandle, minBody, maxWick)
        : isStrongBearishClose(lastCandle, minBody, maxWick);
    if (!strong) {
      // relaxed: allow directional close with decent body
      const body = Math.abs(lastCandle.close - lastCandle.open);
      const range = lastCandle.high - lastCandle.low || 1e-9;
      const directional =
        side === 'buy' ? lastCandle.close > lastCandle.open : lastCandle.close < lastCandle.open;
      if (!(relaxed && directional && body / range >= 0.35)) return undefined;
    }

    // Stops & targets — scale with capital tier (auto when funds grow)
    const profile = this.getProfile?.();
    const micro =
      profile?.isMicro ?? this.config.derivatives.microAccountMode === true;
    const atrBuf = atr * (micro ? 0.08 : 0.25);
    let stopLoss: number;
    if (side === 'buy') {
      stopLoss = Math.min(zone.low, price) - atrBuf;
    } else {
      stopLoss = Math.max(zone.high, price) + atrBuf;
    }

    // Hard-cap stop by tier (e.g. 0.5% micro → 1.5% scale)
    const maxStopPct = (profile?.maxStopPct ?? (micro ? 0.5 : 5)) / 100;
    const rawStopDist = Math.abs(price - stopLoss);
    if (rawStopDist / price > maxStopPct) {
      stopLoss =
        side === 'buy' ? price * (1 - maxStopPct) : price * (1 + maxStopPct);
    }
    if (micro && rawStopDist / price < 0.002) {
      stopLoss =
        side === 'buy' ? price * (1 - 0.003) : price * (1 + 0.003);
    }

    const risk = Math.abs(price - stopLoss);
    if (risk <= 0 || risk / price < 0.0005) return undefined;
    if (micro && risk / price > maxStopPct * 1.2) return undefined;

    const minRr = profile?.minRiskReward ?? this.config.risk.minRiskReward;
    const r1 = profile?.tp1R ?? (micro ? 0.7 : 1);
    const r2 = profile?.tp2R ?? (micro ? 1.5 : 2);
    const tp1 = side === 'buy' ? price + risk * r1 : price - risk * r1;
    const tp2 = side === 'buy' ? price + risk * r2 : price - risk * r2;

    // TP3 = next opposite institutional zone if any
    const opposites = this.zones
      .getActiveZones(symbol)
      .filter((z) => z.type === (side === 'buy' ? 'supply' : 'demand'));
    let tp3: number | undefined;
    if (side === 'buy') {
      const above = opposites
        .filter((z) => z.low > price)
        .sort((a, b) => a.low - b.low)[0];
      tp3 = above?.low;
    } else {
      const below = opposites
        .filter((z) => z.high < price)
        .sort((a, b) => b.high - a.high)[0];
      tp3 = below?.high;
    }

    const reward = Math.abs(tp2 - price);
    const rr = reward / risk;
    if (rr < minRr) return undefined;

    // Retest quality: how well price tagged zone mid
    const distToMid = Math.abs(price - zone.mid) / Math.max(zone.high - zone.low, price * 0.001);
    const retestQuality = Math.max(0, 1 - distToMid / 3) * (zone.retestCount > 0 ? 1 : 0.75);

    const confidence = this.scoring.score({
      side,
      vwap: vwapSnap,
      zone,
      structure: struct,
      htStructure: htStruct,
      volume: vol,
      liquidity: liq,
      candles: closedPrimary,
      atr,
      price,
      retestQuality,
    });

    if (!confidence.passed) return undefined;

    const reasons = [
      ...confidence.reasons,
      `RR ${rr.toFixed(2)}`,
      `RVOL ${vol.rvol.toFixed(2)}`,
      'path:institutional',
    ];

    return {
      id: shortId('sig'),
      symbol,
      side,
      timeframe: primaryTf as SetupSignal['timeframe'],
      entry: price,
      stopLoss,
      takeProfit1: tp1,
      takeProfit2: tp2,
      takeProfit3: tp3,
      riskReward: rr,
      confidence,
      atr,
      zone,
      structure: struct,
      vwap: vwapSnap,
      volume: vol,
      liquidity: liq.filter((l) => l.confirmed),
      reasons,
      rankScore: confidence.total,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.config.strategy.signalTtlMs,
    };
  }

  /**
   * Short-timeframe path: RSI + MACD + Supertrend + EMA + Volume.
   * Fires when majority of indicators agree — more trades than institutional-only.
   */
  private tryBuildIndicatorSignal(args: {
    symbol: string;
    side: Side;
    primaryTf: '1m' | '3m' | '5m' | '15m' | '1h' | '4h' | '1d';
    closedPrimary: import('../../types/market.js').Candle[];
    lastCandle: import('../../types/market.js').Candle;
    price: number;
    atr: number;
    struct: import('../../types/strategy.js').MarketStructureState;
    htStruct: import('../../types/strategy.js').MarketStructureState;
    vwapSnap: import('../../types/strategy.js').VwapSnapshot;
    vol: import('../../types/strategy.js').VolumeMetrics;
    liq: import('../../types/strategy.js').LiquidityLevel[];
    ind: IndicatorSnapshot;
  }): SetupSignal | undefined {
    const {
      symbol,
      side,
      primaryTf,
      closedPrimary,
      lastCandle,
      price,
      atr,
      struct,
      htStruct,
      vwapSnap,
      vol,
      liq,
      ind,
    } = args;

    if (closedPrimary.length < 40) return undefined;

    const vote = indicatorEntryVote(side, ind, vol.rvol);
    const minScore = this.config.strategy.indicatorMinScore ?? 0.55;
    if (!vote.ok || vote.score < minScore) return undefined;

    // Soft HTF filter: don't fight a strong opposite 1h structure
    const wantTrend = side === 'buy' ? 'bullish' : 'bearish';
    if (htStruct.trend !== 'ranging' && htStruct.trend !== wantTrend) {
      if (htStruct.trendStrength > 70) return undefined;
    }

    // Directional candle (loose)
    const directional =
      side === 'buy' ? lastCandle.close >= lastCandle.open : lastCandle.close <= lastCandle.open;
    if (!directional && !ind.supertrend.flipped && ind.macd.cross === 0) return undefined;

    const profile = this.getProfile?.();
    const micro =
      profile?.isMicro ?? this.config.derivatives.microAccountMode === true;

    // SL: Supertrend band or ATR — micro uses tight stops so min-lot risk fits wallet
    const atrStop = atr > 0 ? atr * (micro ? 0.65 : 1.2) : price * (micro ? 0.003 : 0.004);
    let stopLoss =
      side === 'buy'
        ? Math.min(ind.supertrend.value, price - atrStop)
        : Math.max(ind.supertrend.value, price + atrStop);
    // Ensure stop is on correct side
    if (side === 'buy' && stopLoss >= price) stopLoss = price - atrStop;
    if (side === 'sell' && stopLoss <= price) stopLoss = price + atrStop;

    const maxStopPct = (profile?.maxStopPct ?? (micro ? 0.5 : 1.5)) / 100;
    if (Math.abs(price - stopLoss) / price > maxStopPct) {
      stopLoss = side === 'buy' ? price * (1 - maxStopPct) : price * (1 + maxStopPct);
    }
    // Min stop so RR is meaningful (slightly tighter on micro)
    const minStop = price * (micro ? 0.002 : 0.0025);
    if (Math.abs(price - stopLoss) < minStop) {
      stopLoss = side === 'buy' ? price - minStop : price + minStop;
    }

    const risk = Math.abs(price - stopLoss);
    if (risk <= 0) return undefined;

    const r1 = profile?.tp1R ?? (micro ? 0.7 : 1);
    const r2 = profile?.tp2R ?? (micro ? 1.4 : 2);
    const tp1 = side === 'buy' ? price + risk * r1 : price - risk * r1;
    const tp2 = side === 'buy' ? price + risk * r2 : price - risk * r2;
    const rr = Math.abs(tp2 - price) / risk;
    const minRr = Math.min(profile?.minRiskReward ?? 1.4, micro ? 1.35 : 1.5);
    if (rr < minRr) return undefined;

    // Confidence from indicator agreement + volume
    const base = 55 + vote.score * 40;
    const volBoost = Math.min(8, Math.max(0, (vol.rvol - 1) * 5));
    const total = Math.min(98, base + volBoost);
    const minConf = profile?.minConfidenceScore ?? this.config.risk.minConfidenceScore;
    // Indicator path: short-TF entries pass slightly under institutional conf bar
    const passThresh = Math.min(minConf, micro ? 76 : 80);
    if (total < passThresh) return undefined;

    const breakdown = {
      vwapAlignment: ind.emaBullish === (side === 'buy') ? 12 : 4,
      institutionalZone: 0,
      marketStructure: ind.supertrend.direction === (side === 'buy' ? 'up' : 'down') ? 14 : 4,
      volumeSpike: Math.min(15, vol.rvol * 5),
      liquiditySweep: 0,
      trend: ind.macd.bullish === (side === 'buy') ? 12 : 4,
      atrVolatility: 5,
      retestQuality: 0,
      momentum: side === 'buy' ? ind.bullScore * 0.15 : ind.bearScore * 0.15,
    } as ConfidenceScore['breakdown'];

    const confidence: ConfidenceScore = {
      total: Math.round(total * 10) / 10,
      breakdown,
      maxPossible: 100,
      reasons: [
        ...vote.reasons,
        `RSI ${ind.rsi.toFixed(0)}`,
        `MACD hist ${ind.macd.histogram.toFixed(4)}`,
        `ST ${ind.supertrend.direction}`,
      ],
      passed: true,
    };

    return {
      id: shortId('sig'),
      symbol,
      side,
      timeframe: primaryTf as SetupSignal['timeframe'],
      entry: price,
      stopLoss,
      takeProfit1: tp1,
      takeProfit2: tp2,
      riskReward: rr,
      confidence,
      atr,
      structure: struct,
      vwap: vwapSnap,
      volume: vol,
      liquidity: liq.filter((l) => l.confirmed),
      reasons: [
        ...confidence.reasons,
        `RR ${rr.toFixed(2)}`,
        `RVOL ${vol.rvol.toFixed(2)}`,
        'path:indicators',
      ],
      rankScore: confidence.total,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.config.strategy.signalTtlMs,
    };
  }
}
