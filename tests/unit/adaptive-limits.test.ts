import { computeAdaptiveProfile, equityInUsdt } from '../../src/risk/adaptive-limits.js';

describe('adaptive capital tiers', () => {
  it('maps INR micro wallet to micro tier with 1 open trade', () => {
    const p = computeAdaptiveProfile({
      balance: 33,
      marginCurrency: 'INR',
      usdtInr: 99,
      configLeverage: 15,
    });
    expect(p.tier).toBe('micro');
    expect(p.maxOpenTrades).toBe(1);
    expect(p.isMicro).toBe(true);
    expect(p.fullExitAtTp1).toBe(true);
  });

  it('unlocks 2 concurrent trades in growth tier', () => {
    // ~₹1000 INR ≈ $10 USDT → growth
    const p = computeAdaptiveProfile({
      balance: 1000,
      marginCurrency: 'INR',
      usdtInr: 100,
      configLeverage: 20,
    });
    expect(p.tier).toBe('growth');
    expect(p.maxOpenTrades).toBe(2);
    expect(p.isMicro).toBe(false);
  });

  it('standard tier allows 3 opens', () => {
    const p = computeAdaptiveProfile({
      balance: 5000,
      marginCurrency: 'INR',
      usdtInr: 100,
    });
    expect(p.tier).toBe('standard');
    expect(p.maxOpenTrades).toBe(3);
  });

  it('scale tier grows open trades with equity', () => {
    const p = computeAdaptiveProfile({
      balance: 20000,
      marginCurrency: 'USDT',
    });
    expect(p.tier).toBe('scale');
    expect(p.maxOpenTrades).toBeGreaterThanOrEqual(3);
    expect(p.maxOpenTrades).toBeLessThanOrEqual(5);
  });

  it('equityInUsdt converts INR', () => {
    expect(equityInUsdt(990, 'INR', 99)).toBeCloseTo(10, 5);
    expect(equityInUsdt(100, 'USDT')).toBe(100);
  });
});
