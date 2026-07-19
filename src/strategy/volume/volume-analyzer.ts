import type { Candle, Timeframe } from '../../types/market.js';
import type { VolumeMetrics } from '../../types/strategy.js';
import {
  approximateVolumeDelta,
  buySellPressure,
  computeObv,
  cumulativeVolumeDelta,
  relativeVolume,
  volumeSma,
} from '../../indicators/volume.js';

export interface VolumeAnalyzerOptions {
  smaPeriod?: number;
  spikeMultiple?: number;
}

export class VolumeAnalyzer {
  private readonly smaPeriod: number;
  private readonly spikeMultiple: number;

  constructor(options: VolumeAnalyzerOptions = {}) {
    this.smaPeriod = options.smaPeriod ?? 20;
    this.spikeMultiple = options.spikeMultiple ?? 2.0;
  }

  analyze(symbol: string, timeframe: Timeframe, candles: Candle[]): VolumeMetrics {
    const closed = candles.filter((c) => c.closed);
    const series = closed.length ? closed : candles;
    const empty: VolumeMetrics = {
      symbol,
      timeframe,
      volume: 0,
      volumeSma: 0,
      rvol: 0,
      obv: 0,
      spike: false,
      buyPressure: 0.5,
      sellPressure: 0.5,
      timestamp: Date.now(),
    };
    if (series.length === 0) return empty;

    const last = series[series.length - 1]!;
    const volSma = volumeSma(series.slice(0, -1), this.smaPeriod);
    const rvol = relativeVolume(series, this.smaPeriod);
    const obvSeries = computeObv(series);
    const cvd = cumulativeVolumeDelta(series);
    const pressure = buySellPressure(last);
    const delta = approximateVolumeDelta(last);

    return {
      symbol,
      timeframe,
      volume: last.volume,
      volumeSma: volSma,
      rvol,
      obv: obvSeries[obvSeries.length - 1] ?? 0,
      volumeDelta: delta,
      cumulativeVolumeDelta: cvd[cvd.length - 1],
      spike: rvol >= this.spikeMultiple,
      buyPressure: pressure.buy,
      sellPressure: pressure.sell,
      timestamp: last.closeTime,
    };
  }
}
