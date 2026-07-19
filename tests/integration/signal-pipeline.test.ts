import { loadConfig } from '../../src/config/index.js';
import { VwapEngine } from '../../src/strategy/vwap/vwap-engine.js';
import { InstitutionalZoneDetector } from '../../src/strategy/institutional/zone-detector.js';
import { MarketStructureEngine } from '../../src/strategy/market-structure/structure-engine.js';
import { LiquidityDetector } from '../../src/strategy/liquidity/liquidity-detector.js';
import { VolumeAnalyzer } from '../../src/strategy/volume/volume-analyzer.js';
import { ScoringEngine } from '../../src/strategy/scoring/scoring-engine.js';
import { SignalGenerator } from '../../src/strategy/execution/signal-generator.js';
import { RankingEngine } from '../../src/strategy/scoring/ranking-engine.js';
import type { Candle, Timeframe } from '../../src/types/market.js';

function buildTrendCandles(symbol: string, n = 200): Candle[] {
  const out: Candle[] = [];
  let price = 100;
  const start = Date.UTC(2024, 5, 1);
  for (let i = 0; i < n; i++) {
    const bull = i > 100;
    const open = price;
    // Institutional spike mid-way
    const spike = i === 150;
    price = price * (bull ? 1.0015 : 0.9995) + (spike ? 1.5 : 0);
    const close = price;
    const high = Math.max(open, close) * (spike ? 1.01 : 1.001);
    const low = Math.min(open, close) * 0.999;
    out.push({
      symbol,
      timeframe: '1m',
      openTime: start + i * 60_000,
      closeTime: start + i * 60_000 + 59_999,
      open,
      high,
      low,
      close,
      volume: spike ? 8000 : 200 + (i % 7) * 15,
      quoteVolume: close * (spike ? 8000 : 200),
      closed: true,
    });
  }
  return out;
}

describe('signal pipeline integration', () => {
  it('analyzes multiple symbols and ranks them without throwing', () => {
    process.env.SKIP_API_KEY_CHECK = '1';
    process.env.NODE_ENV = 'test';
    const config = loadConfig();
    const vwap = new VwapEngine();
    const zones = new InstitutionalZoneDetector({
      volumeMultiple: config.strategy.institutionalVolumeMultiple,
    });
    const structure = new MarketStructureEngine();
    const liquidity = new LiquidityDetector();
    const volume = new VolumeAnalyzer();
    const scoring = new ScoringEngine(vwap, config);
    const gen = new SignalGenerator(
      vwap,
      zones,
      structure,
      liquidity,
      volume,
      scoring,
      config,
    );
    const ranking = new RankingEngine();

    const symbols = ['AAAUSDT', 'BBBUSDT', 'CCCUSDT'];
    const inputs = symbols.map((symbol) => {
      const c1 = buildTrendCandles(symbol);
      const candles = {
        '1m': c1,
        '3m': c1,
        '5m': c1,
        '15m': c1,
        '1h': c1,
      } as Record<Timeframe, Candle[]>;
      const result = gen.analyze({
        symbol,
        candles,
        lastPrice: c1[c1.length - 1]!.close,
        atr: 1,
        spreadBps: 5,
        quoteVolume24h: 2_000_000,
        timestamp: Date.now(),
      });
      return {
        symbol,
        ...result.rankFactors,
        spreadBps: 5,
        signal: result.signal,
      };
    });

    const ranked = ranking.rank(inputs, 10);
    expect(ranked.length).toBe(3);
    expect(ranked[0]!.rank).toBe(1);
    expect(ranked[0]!.score).toBeGreaterThanOrEqual(ranked[1]!.score);
  });
});
