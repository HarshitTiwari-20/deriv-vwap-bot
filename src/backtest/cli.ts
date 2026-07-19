#!/usr/bin/env node
/**
 * CLI: pnpm backtest -- --symbol BTCUSDT --tf 1m --file ./data/btcusdt-1m.json
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../config/index.js';
import { createLogger, getLogger } from '../utils/logger.js';
import type { Candle, Timeframe } from '../types/market.js';
import { BacktestEngine } from './engine.js';
import { BinanceFuturesClient } from '../exchange/binance-futures-client.js';

createLogger(process.env.LOG_LEVEL ?? 'info');
const log = getLogger('BacktestCLI');

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[++i]! : 'true';
      out[key] = val;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const symbol = (args.symbol ?? 'BTCUSDT').toUpperCase();
  const tf = (args.tf ?? '1m') as Timeframe;
  const capital = Number(args.capital ?? 10_000);
  process.env.SKIP_API_KEY_CHECK = '1';
  const config = loadConfig();
  const engine = new BacktestEngine(config);

  let candles: Candle[] = [];

  if (args.file) {
    const path = resolve(args.file);
    if (!existsSync(path)) throw new Error(`File not found: ${path}`);
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Candle[];
    candles = raw.map((c) => ({
      ...c,
      symbol: c.symbol ?? symbol,
      timeframe: (c.timeframe ?? tf) as Timeframe,
      closed: true,
    }));
  } else {
    // Public klines need no API key — use Binance (testnet or mainnet base)
    log.info({ exchange: config.exchange }, 'Fetching public futures candles…');
    const client = new BinanceFuturesClient(
      {
        ...config.binance,
        // Public market data works on mainnet fapi even for strategy testing
        baseUrl:
          config.exchange === 'binance'
            ? config.binance.baseUrl
            : 'https://fapi.binance.com',
        testnet: false,
      },
      config,
    );
    candles = await client.getCandles(symbol, tf, Number(args.limit ?? 1000));
  }

  if (candles.length < 50) {
    log.error({ count: candles.length }, 'Not enough candles');
    process.exit(1);
  }

  const result = engine.run(candles, {
    symbol,
    primaryTf: tf,
    initialCapital: capital,
    feeBps: config.backtest.feeBps,
    slippageBps: config.backtest.slippageBps,
  });

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        symbol,
        timeframe: tf,
        candles: candles.length,
        signals: result.signals,
        skipped: result.skipped,
        metrics: {
          ...result.metrics,
          equityCurve: `[${result.metrics.equityCurve.length} points]`,
        },
        lastTrades: result.trades.slice(-5),
      },
      null,
      2,
    ),
  );

  if (args.walkforward === 'true') {
    const wf = engine.walkForward(candles, {
      symbol,
      primaryTf: tf,
      initialCapital: capital,
      feeBps: config.backtest.feeBps,
      slippageBps: config.backtest.slippageBps,
    });
    // eslint-disable-next-line no-console
    console.log('Walk-forward combined:', {
      trades: wf.combined.totalTrades,
      winRate: wf.combined.winRate,
      pnl: wf.combined.totalPnl,
      maxDd: wf.combined.maxDrawdownPct,
    });
  }

  if (args.montecarlo === 'true') {
    const mc = engine.monteCarlo(result.trades, capital);
    // eslint-disable-next-line no-console
    console.log('Monte Carlo:', mc);
  }
}

main().catch((err) => {
  log.error({ err }, 'Backtest failed');
  process.exit(1);
});
