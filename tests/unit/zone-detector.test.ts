import { InstitutionalZoneDetector } from '../../src/strategy/institutional/zone-detector.js';
import type { Candle } from '../../src/types/market.js';

function candlesWithSpike(): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < 40; i++) {
    const isSpike = i === 35;
    const open = 100;
    const close = isSpike ? 103 : 100.1;
    out.push({
      symbol: 'SOLUSDT',
      timeframe: '1m',
      openTime: 1_700_000_000_000 + i * 60_000,
      closeTime: 1_700_000_000_000 + i * 60_000 + 59_999,
      open,
      high: isSpike ? 103.2 : 100.3,
      low: isSpike ? 99.9 : 99.9,
      close,
      volume: isSpike ? 5000 : 100,
      quoteVolume: close * (isSpike ? 5000 : 100),
      closed: true,
    });
  }
  return out;
}

describe('InstitutionalZoneDetector', () => {
  it('creates demand zone on bullish institutional candle', () => {
    const det = new InstitutionalZoneDetector({
      volumeMultiple: 2.5,
      minBodyRatio: 0.5,
      maxWickRatio: 0.35,
    });
    const created = det.detect('SOLUSDT', '1m', candlesWithSpike());
    expect(created.length).toBeGreaterThanOrEqual(1);
    expect(created[0]!.type).toBe('demand');
    expect(created[0]!.strengthScore).toBeGreaterThan(0);
  });

  it('invalidates demand zone on close below', () => {
    const det = new InstitutionalZoneDetector({ volumeMultiple: 2.5 });
    const base = candlesWithSpike();
    det.detect('SOLUSDT', '1m', base);
    const zones = det.getActiveZones('SOLUSDT');
    expect(zones.length).toBeGreaterThan(0);
    const z = zones[0]!;
    const breakBar: Candle = {
      symbol: 'SOLUSDT',
      timeframe: '1m',
      openTime: base[base.length - 1]!.openTime + 60_000,
      closeTime: base[base.length - 1]!.closeTime + 60_000,
      open: z.low,
      high: z.low,
      low: z.low - 1,
      close: z.low - 0.5,
      volume: 200,
      quoteVolume: 20000,
      closed: true,
    };
    det.updateZones('SOLUSDT', det.getZones('SOLUSDT'), [...base, breakBar]);
    const after = det.getZones('SOLUSDT').find((x) => x.id === z.id);
    expect(after?.breakStatus || after?.status === 'broken').toBeTruthy();
  });
});
