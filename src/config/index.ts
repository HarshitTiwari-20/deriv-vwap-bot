import { config as loadDotenv } from 'dotenv';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppConfigSchema, type AppConfig } from './schema.js';

loadDotenv();

function num(key: string, fallback?: number): number | undefined {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(key: string, fallback = false): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function parseLeverageMap(raw?: string): Record<string, number> {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw) as Record<string, number>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (Number.isFinite(v) && v >= 1) out[k.toUpperCase().replace(/[-_/]/g, '')] = Math.floor(v);
    }
    return out;
  } catch {
    return {};
  }
}

function loadJsonConfig(path: string): Partial<AppConfig> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Partial<AppConfig>;
  } catch {
    return null;
  }
}

function resolveExchange(): AppConfig['exchange'] {
  const raw = (process.env.EXCHANGE ?? process.env.EXCHANGE_PROVIDER ?? 'binance_testnet')
    .toLowerCase()
    .trim();
  if (raw === 'coindcx') return 'coindcx';
  if (raw === 'binance' || raw === 'binance_live' || raw === 'binance_mainnet') return 'binance';
  return 'binance_testnet';
}

/**
 * Build config from env + config/live.json (or testnet.json) overlay.
 */
export function loadConfig(): AppConfig {
  const exchange = resolveExchange();
  const overlayName = exchange === 'binance_testnet' ? 'testnet.json' : 'live.json';
  const overlayPath = resolve(process.cwd(), 'config', overlayName);
  const fallbackLive = resolve(process.cwd(), 'config', 'live.json');
  const overlay =
    loadJsonConfig(overlayPath) ??
    (overlayName !== 'live.json' ? loadJsonConfig(fallbackLive) : null) ??
    {};

  const isTestnet = exchange === 'binance_testnet';
  const binanceBase =
    process.env.BINANCE_BASE_URL ??
    (isTestnet ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com');

  const fromEnv = {
    nodeEnv: (process.env.NODE_ENV as AppConfig['nodeEnv']) ?? 'development',
    exchange,
    tradingMode: 'live' as const,
    logLevel: (process.env.LOG_LEVEL as AppConfig['logLevel']) ?? 'info',
    coindcx: {
      apiKey: process.env.COINDCX_API_KEY ?? '',
      apiSecret: process.env.COINDCX_API_SECRET ?? '',
      baseUrl: process.env.COINDCX_BASE_URL ?? 'https://api.coindcx.com',
      publicBaseUrl: process.env.COINDCX_PUBLIC_BASE_URL ?? 'https://public.coindcx.com',
      wsUrl: process.env.COINDCX_WS_URL ?? 'wss://stream.coindcx.com',
      publicWsUrl: process.env.COINDCX_PUBLIC_WS_URL ?? 'wss://public.coindcx.com',
    },
    binance: {
      apiKey: process.env.BINANCE_API_KEY ?? '',
      apiSecret: process.env.BINANCE_API_SECRET ?? '',
      testnet: isTestnet,
      baseUrl: binanceBase,
      wsUrl:
        process.env.BINANCE_WS_URL ??
        (isTestnet
          ? 'wss://fstream.binancefuture.com'
          : 'wss://fstream.binance.com'),
    },
    derivatives: {
      marginCurrency: (process.env.DERIV_MARGIN_CURRENCY === 'INR' ? 'INR' : 'USDT') as
        | 'USDT'
        | 'INR',
      leverage: num('DERIV_LEVERAGE', 10)!,
      leverageBySymbol: parseLeverageMap(process.env.DERIV_LEVERAGE_BY_SYMBOL),
      marginType: (process.env.DERIV_MARGIN_TYPE === 'crossed' ? 'crossed' : 'isolated') as
        | 'isolated'
        | 'crossed',
      attachSlTpOnEntry: bool('DERIV_ATTACH_SL_TP', true),
      respectInstrumentMaxLeverage: bool('DERIV_RESPECT_MAX_LEVERAGE', true),
    },
    database: {
      url:
        process.env.DATABASE_URL ??
        'postgresql://algo:algo_secret@localhost:5432/algo_vwap?schema=public',
    },
    redis: {
      url: process.env.REDIS_URL ?? 'redis://localhost:6379',
      password: process.env.REDIS_PASSWORD || undefined,
    },
    risk: {
      accountBalanceUsdt: num('ACCOUNT_BALANCE_USDT', 10_000)!,
      riskPerTradePct: num('RISK_PER_TRADE_PCT', 1)!,
      maxDailyDrawdownPct: num('MAX_DAILY_DRAWDOWN_PCT', 3)!,
      maxConsecutiveLosses: num('MAX_CONSECUTIVE_LOSSES', 3)!,
      maxOpenTrades: num('MAX_OPEN_TRADES', 3)!,
      maxExposurePct: num('MAX_EXPOSURE_PCT', 30)!,
      maxNotionalToEquity: num('MAX_NOTIONAL_TO_EQUITY', 10)!,
      minConfidenceScore: num(
        'MIN_CONFIDENCE_SCORE',
        resolveExchange() === 'binance_testnet' ? 62 : 85,
      )!,
      minRiskReward: num(
        'MIN_RISK_REWARD',
        resolveExchange() === 'binance_testnet' ? 1.5 : 2,
      )!,
    },
    scanner: {
      universeSize: num('SCAN_UNIVERSE_SIZE', resolveExchange() === 'binance_testnet' ? 80 : 150)!,
      minDailyVolumeUsdt: num('MIN_DAILY_VOLUME_USDT', 500_000)!,
      maxSpreadBps: num('MAX_SPREAD_BPS', 50)!,
      universeRefreshMs: num('UNIVERSE_REFRESH_MS', 900_000)!,
      scanCycleMs: num('SCAN_CYCLE_MS', 2_000)!,
    },
    strategy: {
      allowShort: bool('ALLOW_SHORT', true),
      // Auto-relax on testnet unless explicitly disabled
      relaxedEntry:
        process.env.RELAXED_ENTRY !== undefined
          ? bool('RELAXED_ENTRY', false)
          : resolveExchange() === 'binance_testnet',
    },
    alerts: {
      enabled: bool('ALERTS_ENABLED', true),
      telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || undefined,
      telegramChatId: process.env.TELEGRAM_CHAT_ID || undefined,
      discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || undefined,
    },
    server: {
      apiPort: num('BOT_API_PORT', 3100)!,
      wsPort: num('BOT_WS_PORT', 3101)!,
      dashboardPort: num('DASHBOARD_PORT', 3000)!,
    },
  };

  // Force exchange from env over JSON if set
  const merged = deepMerge(
    fromEnv as Record<string, unknown>,
    { ...overlay, exchange } as Record<string, unknown>,
  );

  // Keep binance.testnet consistent with exchange choice
  if (typeof merged.binance === 'object' && merged.binance) {
    (merged.binance as Record<string, unknown>).testnet = isTestnet;
    if (isTestnet && !(merged.binance as Record<string, unknown>).baseUrl) {
      (merged.binance as Record<string, unknown>).baseUrl =
        'https://testnet.binancefuture.com';
    }
    if (!isTestnet && exchange === 'binance') {
      (merged.binance as Record<string, unknown>).baseUrl =
        process.env.BINANCE_BASE_URL ?? 'https://fapi.binance.com';
      (merged.binance as Record<string, unknown>).testnet = false;
    }
  }

  const parsed = AppConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${msg}`);
  }

  const isTest =
    process.env.NODE_ENV === 'test' || process.env.SKIP_API_KEY_CHECK === '1';
  if (!isTest) {
    validateCredentials(parsed.data);
  }

  return parsed.data;
}

function validateCredentials(config: AppConfig): void {
  if (config.exchange === 'coindcx') {
    if (!config.coindcx.apiKey || !config.coindcx.apiSecret) {
      throw new Error(
        'EXCHANGE=coindcx requires COINDCX_API_KEY and COINDCX_API_SECRET.\n' +
          'For free testing use EXCHANGE=binance_testnet with Binance Futures Testnet keys instead.',
      );
    }
    return;
  }

  // binance or binance_testnet
  if (!config.binance.apiKey || !config.binance.apiSecret) {
    throw new Error(
      `${config.exchange} requires BINANCE_API_KEY and BINANCE_API_SECRET.\n` +
        'Get free testnet keys: https://testnet.binancefuture.com → API Management\n' +
        'Then set EXCHANGE=binance_testnet in .env',
    );
  }
}

function deepMerge(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...base };
  for (const [k, v] of Object.entries(overlay)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object' && out[k]) {
      out[k] = deepMerge(out[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

export type { AppConfig } from './schema.js';
export { AppConfigSchema } from './schema.js';

let _config: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (!_config) _config = loadConfig();
  return _config;
}

export function setConfig(config: AppConfig): void {
  _config = config;
}

/** Resolve leverage for a symbol (override map → default) */
export function resolveLeverage(config: AppConfig, symbol: string): number {
  const key = symbol.toUpperCase().replace(/[-_/]/g, '');
  const by = config.derivatives.leverageBySymbol[key];
  if (by !== undefined) return by;
  return config.derivatives.leverage;
}
