import type { Candle, Timeframe } from '../../types/market.js';
import type { InstitutionalZone, ZoneType } from '../../types/strategy.js';
import { bodyRatio, wickRatios } from '../../indicators/momentum.js';
import { volumeSma } from '../../indicators/volume.js';
import { shortId } from '../../utils/id.js';

export interface ZoneDetectorOptions {
  volumeMultiple?: number;
  minBodyRatio?: number;
  maxWickRatio?: number;
  volumeSmaPeriod?: number;
  maxZonesPerSymbol?: number;
  retestTolerancePct?: number;
}

/**
 * Detects institutional accumulation/distribution candles and manages
 * persistent supply/demand zones.
 */
export class InstitutionalZoneDetector {
  private readonly zones = new Map<string, InstitutionalZone[]>();
  private readonly volumeMultiple: number;
  private readonly minBodyRatio: number;
  private readonly maxWickRatio: number;
  private readonly volumeSmaPeriod: number;
  private readonly maxZones: number;
  private readonly retestTol: number;

  constructor(options: ZoneDetectorOptions = {}) {
    this.volumeMultiple = options.volumeMultiple ?? 2.5;
    this.minBodyRatio = options.minBodyRatio ?? 0.6;
    this.maxWickRatio = options.maxWickRatio ?? 0.25;
    this.volumeSmaPeriod = options.volumeSmaPeriod ?? 20;
    this.maxZones = options.maxZonesPerSymbol ?? 30;
    this.retestTol = options.retestTolerancePct ?? 0.15;
  }

  getZones(symbol: string): InstitutionalZone[] {
    return this.zones.get(symbol) ?? [];
  }

  getActiveZones(symbol: string): InstitutionalZone[] {
    return this.getZones(symbol).filter((z) => !z.breakStatus && z.status !== 'invalidated');
  }

  setZones(symbol: string, zones: InstitutionalZone[]): void {
    this.zones.set(symbol, zones);
  }

  /**
   * Scan closed candles for new institutional zones. Only analyzes closed bars.
   */
  detect(symbol: string, timeframe: Timeframe, candles: Candle[]): InstitutionalZone[] {
    const closed = candles.filter((c) => c.closed);
    if (closed.length < this.volumeSmaPeriod + 2) return this.getActiveZones(symbol);

    const existing = this.getZones(symbol);
    const knownKeys = new Set(existing.map((z) => `${z.candleOpenTime}:${z.type}`));
    const created: InstitutionalZone[] = [];

    // Check last few closed candles for new zones
    const start = Math.max(this.volumeSmaPeriod, closed.length - 5);
    for (let i = start; i < closed.length; i++) {
      const c = closed[i]!;
      const prior = closed.slice(0, i);
      const avgVol = volumeSma(prior, this.volumeSmaPeriod);
      if (avgVol <= 0) continue;

      const volMult = c.volume / avgVol;
      if (volMult < this.volumeMultiple) continue;

      const br = bodyRatio(c);
      if (br < this.minBodyRatio) continue;

      const wicks = wickRatios(c);
      const isBull = c.close > c.open;
      const isBear = c.close < c.open;
      if (!isBull && !isBear) continue;

      // Small wicks in direction of move
      if (isBull && wicks.upper > this.maxWickRatio) continue;
      if (isBear && wicks.lower > this.maxWickRatio) continue;

      // Significant displacement: body > 0.5 * range of prior ATR-like measure
      const range = c.high - c.low;
      const priorRanges = prior.slice(-20).map((x) => x.high - x.low);
      const avgRange =
        priorRanges.reduce((a, b) => a + b, 0) / Math.max(1, priorRanges.length);
      if (range < avgRange * 0.8) continue;

      const type: ZoneType = isBull ? 'demand' : 'supply';
      const key = `${c.openTime}:${type}`;
      if (knownKeys.has(key)) continue;

      // Zone bounds: for demand use candle low + body lower half; for supply upper half
      const bodyLow = Math.min(c.open, c.close);
      const bodyHigh = Math.max(c.open, c.close);
      const high = type === 'demand' ? bodyHigh : c.high;
      const low = type === 'demand' ? c.low : bodyLow;

      const imbalance = br * Math.min(volMult / this.volumeMultiple, 3);
      const strengthScore = Math.min(
        100,
        volMult * 15 + br * 40 + imbalance * 10 + (range / Math.max(avgRange, 1e-9)) * 10,
      );

      const zone: InstitutionalZone = {
        id: shortId('zone'),
        symbol,
        type,
        high,
        low,
        mid: (high + low) / 2,
        volume: c.volume,
        volumeMultiple: volMult,
        timestamp: c.closeTime,
        candleOpenTime: c.openTime,
        strengthScore,
        retestCount: 0,
        freshness: 100,
        status: 'fresh',
        breakStatus: false,
        timeframe,
      };

      existing.push(zone);
      created.push(zone);
      knownKeys.add(key);
    }

    this.updateZones(symbol, existing, closed);
    return created;
  }

  /**
   * Update freshness, retests, and invalidate broken zones after confirmed close beyond.
   */
  updateZones(symbol: string, zones: InstitutionalZone[], candles: Candle[]): void {
    if (candles.length === 0) {
      this.zones.set(symbol, zones);
      return;
    }

    const last = candles[candles.length - 1]!;
    const price = last.close;
    const now = last.closeTime;

    for (const z of zones) {
      if (z.breakStatus || z.status === 'invalidated') continue;

      // Freshness decays over time (half-life ~ 24h of candles approximated)
      const ageMs = now - z.timestamp;
      const ageHours = ageMs / 3_600_000;
      z.freshness = Math.max(0, 100 * Math.exp(-ageHours / 24));

      // Retest detection
      const tol = ((z.high + z.low) / 2) * (this.retestTol / 100);
      const touches =
        last.low <= z.high + tol && last.high >= z.low - tol;

      if (touches && last.closeTime > z.timestamp) {
        // Count retest only once per distinct approach (simple: increment if not just created)
        if (z.status === 'fresh' || z.status === 'tested') {
          // Use candle body not fully through zone
          if (z.type === 'demand' && last.close >= z.low - tol) {
            if (last.low <= z.high) {
              z.retestCount += 1;
              z.status = 'tested';
            }
          }
          if (z.type === 'supply' && last.close <= z.high + tol) {
            if (last.high >= z.low) {
              z.retestCount += 1;
              z.status = 'tested';
            }
          }
        }
      }

      // Invalidate only on confirmed close beyond zone
      if (z.type === 'demand' && last.close < z.low && last.closed) {
        z.breakStatus = true;
        z.status = 'broken';
      }
      if (z.type === 'supply' && last.close > z.high && last.closed) {
        z.breakStatus = true;
        z.status = 'broken';
      }

      if (z.freshness < 5 && z.retestCount === 0) {
        z.status = 'invalidated';
        z.breakStatus = true;
      }
    }

    // Keep strongest / freshest
    const active = zones
      .filter((z) => z.status !== 'invalidated')
      .sort((a, b) => b.strengthScore * (b.freshness / 100) - a.strengthScore * (a.freshness / 100))
      .slice(0, this.maxZones);

    this.zones.set(symbol, active);
  }

  /**
   * Find best zone for a potential entry (retest of demand for long / supply for short).
   */
  findRetestZone(
    symbol: string,
    side: 'buy' | 'sell',
    price: number,
  ): InstitutionalZone | undefined {
    const want: ZoneType = side === 'buy' ? 'demand' : 'supply';
    const active = this.getActiveZones(symbol).filter((z) => z.type === want);
    if (active.length === 0) return undefined;

    const tol = (p: number) => p * (this.retestTol / 100);

    const candidates = active.filter((z) => {
      const pad = tol(z.mid);
      return price >= z.low - pad && price <= z.high + pad * 2;
    });

    if (candidates.length === 0) {
      // Also allow zones slightly below/above that price is approaching
      return active
        .filter((z) => {
          if (side === 'buy') return price >= z.low * 0.99 && price <= z.high * 1.02;
          return price <= z.high * 1.01 && price >= z.low * 0.98;
        })
        .sort((a, b) => b.strengthScore - a.strengthScore)[0];
    }

    return candidates.sort(
      (a, b) =>
        b.strengthScore * (b.freshness / 100) - a.strengthScore * (a.freshness / 100),
    )[0];
  }

  clear(symbol?: string): void {
    if (symbol) this.zones.delete(symbol);
    else this.zones.clear();
  }
}
