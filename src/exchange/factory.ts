import type { AppConfig } from '../config/schema.js';
import { getLogger } from '../utils/logger.js';
import { BinanceFuturesClient } from './binance-futures-client.js';
import { CoinDcxClient } from './coindcx-client.js';
import type { IExchangeClient } from './types.js';

const log = getLogger('ExchangeFactory');

/**
 * Create the configured exchange client.
 *
 * - binance_testnet → free demo USDT (recommended for testing)
 * - binance         → live Binance USD-M futures
 * - coindcx         → live CoinDCX derivatives
 */
export function createExchangeClient(config: AppConfig): IExchangeClient {
  const provider = config.exchange;

  if (provider === 'binance_testnet' || provider === 'binance') {
    const client = new BinanceFuturesClient(config.binance, config);
    log.info(
      {
        provider,
        testnet: config.binance.testnet,
        baseUrl: config.binance.baseUrl,
      },
      'Using Binance futures exchange',
    );
    return client;
  }

  const client = new CoinDcxClient(config.coindcx, config);
  log.info({ provider: 'coindcx' }, 'Using CoinDCX futures exchange');
  return client;
}
