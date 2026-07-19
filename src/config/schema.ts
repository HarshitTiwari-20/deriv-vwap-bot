import { z } from 'zod';

export const AppConfigSchema = z.object({
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
  /**
   * Which exchange to trade on:
   * - binance_testnet: free demo USDT (recommended for testing)
   * - binance: live Binance USD-M futures
   * - coindcx: live CoinDCX derivatives
   */
  exchange: z.enum(['binance_testnet', 'binance', 'coindcx']).default('binance_testnet'),
  /** Always live orders on the selected exchange (testnet still uses real API, fake money) */
  tradingMode: z.enum(['live']).default('live'),
  logLevel: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  coindcx: z.object({
    apiKey: z.string().default(''),
    apiSecret: z.string().default(''),
    baseUrl: z.string().url().default('https://api.coindcx.com'),
    publicBaseUrl: z.string().url().default('https://public.coindcx.com'),
    wsUrl: z.string().default('wss://stream.coindcx.com'),
    publicWsUrl: z.string().default('wss://public.coindcx.com'),
  }),

  binance: z
    .object({
      apiKey: z.string().default(''),
      apiSecret: z.string().default(''),
      /** false = mainnet production futures */
      testnet: z.boolean().default(true),
      baseUrl: z.string().url().default('https://testnet.binancefuture.com'),
      wsUrl: z.string().default('wss://fstream.binancefuture.com'),
    })
    .default({}),

  /** USDT-M perpetual / futures derivatives settings */
  derivatives: z
    .object({
      /** Margin currency for futures wallet */
      marginCurrency: z.enum(['USDT', 'INR']).default('USDT'),
      /** Default leverage applied on every order (custom) */
      leverage: z.number().int().min(1).max(125).default(10),
      /**
       * Optional per-symbol leverage overrides, e.g. { "BTCUSDT": 20, "ETHUSDT": 15 }
       * Keys are normalized symbols (BTCUSDT), not pair strings.
       */
      leverageBySymbol: z.record(z.number().int().min(1).max(125)).default({}),
      /** isolated | crossed — sent via margin type API when possible */
      marginType: z.enum(['isolated', 'crossed']).default('isolated'),
      /** Attach SL/TP on entry order when exchange supports it */
      attachSlTpOnEntry: z.boolean().default(true),
      /** Max leverage clamp if instrument max is lower */
      respectInstrumentMaxLeverage: z.boolean().default(true),
    })
    .default({}),

  redis: z.object({
    url: z.string().default('redis://localhost:6379'),
    password: z.string().optional(),
  }),

  risk: z.object({
    accountBalanceUsdt: z.number().positive().default(10_000),
    riskPerTradePct: z.number().positive().max(5).default(1),
    maxDailyDrawdownPct: z.number().positive().default(3),
    maxConsecutiveLosses: z.number().int().positive().default(3),
    maxOpenTrades: z.number().int().positive().default(3),
    /**
     * Max total margin locked as % of balance (not notional).
     * With leverage, notional can exceed balance; exposure is margin-based.
     */
    maxExposurePct: z.number().positive().default(30),
    /** Cap notional as multiple of equity (e.g. 5 = max 5x account in open notionals) */
    maxNotionalToEquity: z.number().positive().default(10),
    minConfidenceScore: z.number().min(0).max(100).default(85),
    minRiskReward: z.number().positive().default(2),
  }),

  scanner: z
    .object({
      universeSize: z.number().int().min(10).max(500).default(150),
      minDailyVolumeUsdt: z.number().positive().default(500_000),
      maxSpreadBps: z.number().positive().default(50),
      minAtrPct: z.number().positive().default(0.1),
      maxAtrPct: z.number().positive().default(15),
      minListingAgeDays: z.number().nonnegative().default(14),
      universeRefreshMs: z.number().int().positive().default(900_000),
      scanCycleMs: z.number().int().positive().default(2_000),
    })
    .default({}),

  strategy: z
    .object({
      primaryTimeframes: z.array(z.enum(['1m', '3m'])).default(['1m', '3m']),
      confirmationTimeframes: z.array(z.enum(['5m', '15m'])).default(['5m', '15m']),
      trendTimeframe: z.enum(['1h', '4h']).default('1h'),
      institutionalVolumeMultiple: z.number().positive().default(2.5),
      minBodyRatio: z.number().min(0).max(1).default(0.6),
      maxWickRatio: z.number().min(0).max(1).default(0.25),
      volumeSmaPeriod: z.number().int().positive().default(20),
      atrPeriod: z.number().int().positive().default(14),
      swingLookback: z.number().int().positive().default(5),
      equalLevelTolerancePct: z.number().positive().default(0.1),
      /** Futures: shorts enabled by default */
      allowShort: z.boolean().default(true),
      signalTtlMs: z.number().int().positive().default(180_000),
      /**
       * Softer entry gates for testnet / learning (still multi-factor).
       * Production CoinDCX should keep this false.
       */
      relaxedEntry: z.boolean().default(false),
    })
    .default({}),

  scoring: z
    .object({
      weights: z
        .object({
          vwapAlignment: z.number().default(20),
          institutionalZone: z.number().default(20),
          marketStructure: z.number().default(15),
          volumeSpike: z.number().default(15),
          liquiditySweep: z.number().default(10),
          trend: z.number().default(10),
          atrVolatility: z.number().default(5),
          retestQuality: z.number().default(5),
          momentum: z.number().default(5),
        })
        .default({}),
    })
    .default({}),

  /** Used only by backtest engine for fee/slippage simulation */
  backtest: z
    .object({
      feeBps: z.number().nonnegative().default(7.5),
      slippageBps: z.number().nonnegative().default(5),
    })
    .default({}),

  alerts: z.object({
    enabled: z.boolean().default(true),
    telegramBotToken: z.string().optional(),
    telegramChatId: z.string().optional(),
    discordWebhookUrl: z.string().optional(),
  }),

  server: z.object({
    apiPort: z.number().int().positive().default(3100),
    wsPort: z.number().int().positive().default(3101),
    dashboardPort: z.number().int().positive().default(3000),
  }),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
