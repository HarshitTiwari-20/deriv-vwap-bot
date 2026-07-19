import { Queue, Worker, type Job } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';
import { getLogger } from '../utils/logger.js';

const log = getLogger('Queue');

export const QUEUE_NAMES = {
  SCAN: 'scan-jobs',
  ALERTS: 'alert-jobs',
  PERSIST: 'persist-jobs',
} as const;

export function createConnection(redisUrl: string): ConnectionOptions {
  const u = new URL(redisUrl);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    password: u.password || undefined,
  };
}

export function createScanQueue(redisUrl: string): Queue {
  return new Queue(QUEUE_NAMES.SCAN, { connection: createConnection(redisUrl) });
}

export function createAlertQueue(redisUrl: string): Queue {
  return new Queue(QUEUE_NAMES.ALERTS, { connection: createConnection(redisUrl) });
}

/**
 * Optional BullMQ workers for durable job processing (alerts, persistence).
 * Core scan loop stays in-process for latency; queues handle fan-out side effects.
 */
export function startAlertWorker(
  redisUrl: string,
  handler: (job: Job) => Promise<void>,
): Worker {
  const worker = new Worker(QUEUE_NAMES.ALERTS, handler, {
    connection: createConnection(redisUrl),
    concurrency: 5,
  });
  worker.on('failed', (job, err) =>
    log.error({ jobId: job?.id, err }, 'Alert job failed'),
  );
  return worker;
}

export function startPersistWorker(
  redisUrl: string,
  handler: (job: Job) => Promise<void>,
): Worker {
  const worker = new Worker(QUEUE_NAMES.PERSIST, handler, {
    connection: createConnection(redisUrl),
    concurrency: 3,
  });
  worker.on('failed', (job, err) =>
    log.error({ jobId: job?.id, err }, 'Persist job failed'),
  );
  return worker;
}
