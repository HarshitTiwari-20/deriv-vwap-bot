/**
 * Auto-scale risk / concurrency from live wallet balance.
 * When the user adds funds, max open trades, exposure, and stops loosen safely.
 */

export type CapitalTier = 'micro' | 'small' | 'growth' | 'standard' | 'scale';

export interface AdaptiveProfile {
  tier: CapitalTier;
  /** Human label for logs / dashboard */
  label: string;
  balance: number;
  marginCurrency: string;
  /** Approx equity in USDT for cross-currency comparison */
  equityUsdt: number;
  maxOpenTrades: number;
  maxTradesPerDay: number;
  riskPerTradePct: number;
  maxRiskPerTradePct: number;
  maxExposurePct: number;
  maxNotionalToEquity: number;
  maxDailyDrawdownPct: number;
  maxConsecutiveLosses: number;
  minConfidenceScore: number;
  minRiskReward: number;
  /** Max stop distance as % of price (e.g. 0.5 = 0.5%) */
  maxStopPct: number;
  /** Prefer full exit at TP1 (small accounts) */
  fullExitAtTp1: boolean;
  /** Early breakeven at this R multiple */
  earlyBeR: number;
  /** TP1 / TP2 R multiples */
  tp1R: number;
  tp2R: number;
  /** Soft leverage cap for this tier */
  leverageCap: number;
  /** True when capital-preservation micro behavior is active */
  isMicro: boolean;
}

export interface AdaptiveInput {
  balance: number;
  marginCurrency: 'USDT' | 'INR' | string;
  /** Live USDTINR when margin is INR */
  usdtInr?: number;
  /** Config leverage default (used as upper bound) */
  configLeverage?: number;
}

/**
 * Normalize wallet to USDT-equivalent so INR and USDT wallets share tiers.
 */
export function equityInUsdt(
  balance: number,
  marginCurrency: string,
  usdtInr = 99,
): number {
  if (!(balance > 0)) return 0;
  if (marginCurrency === 'INR') return balance / Math.max(usdtInr, 1);
  return balance;
}

/**
 * Compute adaptive risk profile from live balance.
 *
 * | Equity (USDT≈) | Tier     | Open trades | Notes              |
 * |----------------|----------|-------------|--------------------|
 * | < ~$1 (₹100)   | micro    | 1           | max capital protect|
 * | ~$1–$5         | small    | 1           | still cautious     |
 * | ~$5–$25        | growth   | 2           | multi-trade starts |
 * | ~$25–$100      | standard | 3           | normal bot         |
 * | > ~$100        | scale    | 4–5         | more concurrency   |
 */
export function computeAdaptiveProfile(input: AdaptiveInput): AdaptiveProfile {
  const usdtInr = input.usdtInr && input.usdtInr > 0 ? input.usdtInr : 99;
  const bal = Math.max(0, input.balance);
  const eq = equityInUsdt(bal, input.marginCurrency, usdtInr);
  const levCap = Math.max(5, input.configLeverage ?? 15);

  // Thresholds in USDT-equivalent
  let tier: CapitalTier;
  if (eq < 1.2) tier = 'micro';
  else if (eq < 5) tier = 'small';
  else if (eq < 25) tier = 'growth';
  else if (eq < 100) tier = 'standard';
  else tier = 'scale';

  const base = {
    balance: bal,
    marginCurrency: input.marginCurrency,
    equityUsdt: Math.round(eq * 100) / 100,
  };

  switch (tier) {
    case 'micro':
      return {
        ...base,
        tier,
        label: 'Micro (low funds — 1 trade, tight stops)',
        maxOpenTrades: 1,
        // Short-TF indicator path needs more attempts through the day
        maxTradesPerDay: 6,
        riskPerTradePct: 1.5,
        // Min-lot $6 × 0.5% stop × ₹99 ≈ ₹3.0 risk; 12% of ₹45 ≈ ₹5.4 cap
        maxRiskPerTradePct: 12,
        // Allow min-lot margin on ~₹45 wallets (≈₹30 margin at 20x / $6 notional)
        maxExposurePct: 92,
        maxNotionalToEquity: 15,
        maxDailyDrawdownPct: 8,
        // Allow a second attempt after one loss; halt only on 2 losses or DD
        maxConsecutiveLosses: 2,
        minConfidenceScore: 78,
        minRiskReward: 1.4,
        // Tighter max stop → smaller min-lot loss on micro wallet
        maxStopPct: 0.5,
        fullExitAtTp1: true,
        earlyBeR: 0.35,
        tp1R: 0.7,
        tp2R: 1.4,
        leverageCap: Math.min(20, levCap),
        isMicro: true,
      };
    case 'small':
      return {
        ...base,
        tier,
        label: 'Small — 1 trade, slightly looser',
        maxOpenTrades: 1,
        maxTradesPerDay: 3,
        riskPerTradePct: 1,
        maxRiskPerTradePct: 4,
        maxExposurePct: 45,
        maxNotionalToEquity: 8,
        maxDailyDrawdownPct: 6,
        maxConsecutiveLosses: 2,
        minConfidenceScore: 83,
        minRiskReward: 1.5,
        maxStopPct: 0.6,
        fullExitAtTp1: true,
        earlyBeR: 0.4,
        tp1R: 0.8,
        tp2R: 1.8,
        leverageCap: Math.min(15, levCap),
        isMicro: true,
      };
    case 'growth':
      return {
        ...base,
        tier,
        label: 'Growth — up to 2 concurrent trades',
        maxOpenTrades: 2,
        maxTradesPerDay: 4,
        riskPerTradePct: 1,
        maxRiskPerTradePct: 3,
        maxExposurePct: 50,
        maxNotionalToEquity: 8,
        maxDailyDrawdownPct: 4,
        maxConsecutiveLosses: 2,
        minConfidenceScore: 82,
        minRiskReward: 1.8,
        maxStopPct: 0.9,
        fullExitAtTp1: false,
        earlyBeR: 0.5,
        tp1R: 1,
        tp2R: 2,
        leverageCap: Math.min(20, levCap),
        isMicro: false,
      };
    case 'standard':
      return {
        ...base,
        tier,
        label: 'Standard — up to 3 concurrent trades',
        maxOpenTrades: 3,
        maxTradesPerDay: 6,
        riskPerTradePct: 1,
        maxRiskPerTradePct: 2.5,
        maxExposurePct: 40,
        maxNotionalToEquity: 10,
        maxDailyDrawdownPct: 3,
        maxConsecutiveLosses: 3,
        minConfidenceScore: 80,
        minRiskReward: 2,
        maxStopPct: 1.2,
        fullExitAtTp1: false,
        earlyBeR: 0.6,
        tp1R: 1,
        tp2R: 2,
        leverageCap: Math.min(20, levCap),
        isMicro: false,
      };
    case 'scale':
    default: {
      // Scale open trades gently with equity (cap 5)
      const open = Math.min(5, 3 + Math.floor(eq / 150));
      return {
        ...base,
        tier: 'scale',
        label: `Scale — up to ${open} concurrent trades`,
        maxOpenTrades: open,
        maxTradesPerDay: Math.min(12, open * 3),
        riskPerTradePct: 0.75,
        maxRiskPerTradePct: 2,
        maxExposurePct: 35,
        maxNotionalToEquity: 10,
        maxDailyDrawdownPct: 3,
        maxConsecutiveLosses: 3,
        minConfidenceScore: 78,
        minRiskReward: 2,
        maxStopPct: 1.5,
        fullExitAtTp1: false,
        earlyBeR: 0.75,
        tp1R: 1,
        tp2R: 2.2,
        leverageCap: levCap,
        isMicro: false,
      };
    }
  }
}
