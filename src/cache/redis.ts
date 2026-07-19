import { createRequire } from 'node:module';
import type { AppConfig } from '../config/schema.js';
import { getLogger } from '../utils/logger.js';

const log = getLogger('Redis');
const require = createRequire(import.meta.url);

// ioredis CJS default export
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Redis = require('ioredis') as new (
  url: string,
  opts?: Record<string, unknown>,
) => {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: string, ttl: number): Promise<unknown>;
  quit(): Promise<unknown>;
  on(event: string, cb: (...args: unknown[]) => void): void;
};

type RedisClient = InstanceType<typeof Redis>;

let client: RedisClient | null = null;

export function getRedis(config: AppConfig['redis']): RedisClient {
  if (!client) {
    client = new Redis(config.url, {
      password: config.password || undefined,
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });
    client.on('error', (err: unknown) => log.error({ err }, 'Redis error'));
    client.on('connect', () => log.info('Redis connected'));
  }
  return client;
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  if (!client) return null;
  const v = await client.get(key);
  if (!v) return null;
  try {
    return JSON.parse(v) as T;
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, value: unknown, ttlSec = 60): Promise<void> {
  if (!client) return;
  await client.set(key, JSON.stringify(value), 'EX', ttlSec);
}

export async function disconnectRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}
