import { sleep } from './math.js';

export interface RetryOptions {
  retries?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  jitter?: boolean;
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

const defaultShouldRetry = (err: unknown): boolean => {
  if (err && typeof err === 'object') {
    const e = err as { status?: number; code?: string; message?: string };
    if (e.status === 429) return true;
    if (e.status && e.status >= 500) return true;
    if (e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT' || e.code === 'ECONNREFUSED') return true;
    if (e.message?.includes('rate limit')) return true;
  }
  return false;
};

/**
 * Exponential backoff with optional jitter. Safe for rate-limited REST APIs.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    retries = 5,
    minDelayMs = 200,
    maxDelayMs = 10_000,
    factor = 2,
    jitter = true,
    shouldRetry = defaultShouldRetry,
    onRetry,
  } = options;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt >= retries || !shouldRetry(err, attempt)) throw err;
      let delay = Math.min(maxDelayMs, minDelayMs * factor ** attempt);
      if (jitter) delay = delay * (0.5 + Math.random() * 0.5);
      onRetry?.(err, attempt + 1, delay);
      await sleep(delay);
    }
  }
  throw lastError;
}

/**
 * Simple token-bucket rate limiter for outbound API calls.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly maxTokens: number,
    private readonly refillPerSec: number,
  ) {
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillPerSec);
    this.lastRefill = now;
  }

  async acquire(cost = 1): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= cost) {
        this.tokens -= cost;
        return;
      }
      const need = cost - this.tokens;
      const waitMs = Math.ceil((need / this.refillPerSec) * 1000);
      await sleep(Math.max(10, waitMs));
    }
  }
}
