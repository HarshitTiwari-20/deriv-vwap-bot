import { EventEmitter } from 'node:events';
import type { DomainEventName, DomainEvents } from '../types/events.js';
import { getLogger } from '../utils/logger.js';

/**
 * Typed in-process event bus. All modules communicate via domain events.
 * Handlers run sequentially per event; errors are isolated and logged.
 */
export class EventBus {
  private readonly ee = new EventEmitter();
  private readonly log = getLogger('EventBus');

  constructor() {
    this.ee.setMaxListeners(100);
  }

  on<K extends DomainEventName>(
    event: K,
    handler: (payload: DomainEvents[K]) => void | Promise<void>,
  ): () => void {
    const wrapped = (payload: DomainEvents[K]) => {
      Promise.resolve()
        .then(() => handler(payload))
        .catch((err: unknown) => {
          this.log.error({ err, event }, 'Event handler failed');
        });
    };
    this.ee.on(event, wrapped);
    return () => this.ee.off(event, wrapped);
  }

  once<K extends DomainEventName>(
    event: K,
    handler: (payload: DomainEvents[K]) => void | Promise<void>,
  ): void {
    this.ee.once(event, (payload: DomainEvents[K]) => {
      Promise.resolve()
        .then(() => handler(payload))
        .catch((err: unknown) => {
          this.log.error({ err, event }, 'Once handler failed');
        });
    });
  }

  emit<K extends DomainEventName>(event: K, payload: DomainEvents[K]): void {
    this.ee.emit(event, payload);
  }

  removeAllListeners(event?: DomainEventName): void {
    if (event) this.ee.removeAllListeners(event);
    else this.ee.removeAllListeners();
  }

  listenerCount(event: DomainEventName): number {
    return this.ee.listenerCount(event);
  }
}

export const eventBus = new EventBus();
