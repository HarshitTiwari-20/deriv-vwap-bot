import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getLogger } from '../utils/logger.js';
import type { AnalysisContext } from '../types/strategy.js';
import type { SetupSignal } from '../types/strategy.js';

const log = getLogger('WorkerPool');
const __dirname = dirname(fileURLToPath(import.meta.url));

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

/**
 * Small pool of analysis workers for CPU-bound strategy evaluation.
 */
export class WorkerPool {
  private workers: Worker[] = [];
  private rr = 0;
  private pending = new Map<string, Pending>();
  private seq = 0;

  constructor(
    private readonly size: number,
    private readonly mode: string,
  ) {}

  async start(): Promise<void> {
    const workerPath = join(__dirname, 'analysis-worker.ts');
    // Prefer compiled JS in production
    const jsPath = join(__dirname, 'analysis-worker.js');

    for (let i = 0; i < this.size; i++) {
      const useTs = process.env.NODE_ENV !== 'production';
      const worker = useTs
        ? new Worker(workerPath, {
            workerData: { mode: this.mode },
            execArgv: ['--import', 'tsx'],
          })
        : new Worker(jsPath, { workerData: { mode: this.mode } });

      worker.on('message', (msg: { type: string; id: string; result?: unknown; error?: string }) => {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.type === 'error') p.reject(new Error(msg.error ?? 'worker error'));
        else p.resolve(msg.result);
      });
      worker.on('error', (err) => log.error({ err }, 'Worker error'));
      this.workers.push(worker);
    }
    log.info({ size: this.size }, 'Worker pool started');
  }

  async analyze(ctx: AnalysisContext): Promise<{
    signal?: SetupSignal;
    rankFactors: Record<string, number>;
  }> {
    if (this.workers.length === 0) {
      throw new Error('Worker pool not started');
    }
    const id = String(++this.seq);
    const worker = this.workers[this.rr % this.workers.length]!;
    this.rr += 1;

    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      worker.postMessage({ type: 'analyze', id, payload: ctx });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('Worker analyze timeout'));
        }
      }, 5_000);
    });
  }

  async stop(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.terminate()));
    this.workers = [];
    this.pending.clear();
  }
}
