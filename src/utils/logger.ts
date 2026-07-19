import pino, { type Logger, type LoggerOptions } from 'pino';

let rootLogger: Logger | null = null;

export function createLogger(level = 'info', pretty = true): Logger {
  const options: LoggerOptions = {
    level,
    base: { service: 'algo-vwap' },
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (pretty && process.env.NODE_ENV !== 'production') {
    rootLogger = pino({
      ...options,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname,service',
        },
      },
    });
  } else {
    rootLogger = pino(options);
  }
  return rootLogger;
}

export function getLogger(name?: string): Logger {
  if (!rootLogger) createLogger(process.env.LOG_LEVEL ?? 'info');
  return name ? rootLogger!.child({ module: name }) : rootLogger!;
}

export type { Logger };
