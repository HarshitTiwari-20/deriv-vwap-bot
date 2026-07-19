import 'reflect-metadata';
import { container } from 'tsyringe';
import { loadConfig, type AppConfig } from '../config/index.js';
import { eventBus } from '../events/event-bus.js';
import { TOKENS } from './tokens.js';
import { createLogger } from '../utils/logger.js';

/**
 * Register core singletons for live derivatives mode.
 */
export function setupContainer(): AppConfig {
  const config = loadConfig();
  const logger = createLogger(config.logLevel, config.nodeEnv !== 'production');

  container.registerInstance(TOKENS.Config, config);
  container.registerInstance(TOKENS.EventBus, eventBus);
  container.registerInstance(TOKENS.Logger, logger);

  return config;
}

export { container, TOKENS };
