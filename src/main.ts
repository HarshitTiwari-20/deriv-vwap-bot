import { setupContainer } from './di/container.js';
import { eventBus } from './events/event-bus.js';
import { BotOrchestrator } from './services/bot-orchestrator.js';
import { ApiServer } from './services/api-server.js';
import { getLogger } from './utils/logger.js';

async function main(): Promise<void> {
  const config = setupContainer();
  const log = getLogger('main');

  log.info(
    {
      exchange: config.exchange,
      leverage: config.derivatives.leverage,
      marginType: config.derivatives.marginType,
      marginCurrency: config.derivatives.marginCurrency,
      universe: config.scanner.universeSize,
      minConfidence: config.risk.minConfidenceScore,
      allowShort: config.strategy.allowShort,
    },
    'algo-vwap derivatives starting',
  );

  const bot = new BotOrchestrator(config, eventBus);
  const api = new ApiServer(config, bot, eventBus);

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'Shutdown signal received');
    await api.stop();
    await bot.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => {
    log.error({ err }, 'Unhandled rejection');
    eventBus.emit('system:error', {
      context: 'unhandledRejection',
      error: err instanceof Error ? err : new Error(String(err)),
    });
  });

  // API first so the dashboard loads while the bot warms markets/candles
  api.start();
  log.info(
    { apiPort: config.server.apiPort, wsPort: config.server.wsPort },
    'Dashboard API online — starting bot warm-up',
  );

  try {
    await bot.start();
  } catch (err) {
    log.error({ err }, 'Bot start failed — API stays up for kill/status; fix and restart');
    // Keep process alive so dashboard remains reachable
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
