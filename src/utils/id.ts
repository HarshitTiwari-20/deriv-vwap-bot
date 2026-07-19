import { randomUUID } from 'node:crypto';

export function uuid(): string {
  return randomUUID();
}

export function shortId(prefix = ''): string {
  const id = randomUUID().replace(/-/g, '').slice(0, 12);
  return prefix ? `${prefix}_${id}` : id;
}

export function clientOrderId(symbol: string): string {
  return `av_${symbol.replace(/[^a-zA-Z0-9]/g, '')}_${Date.now().toString(36)}`;
}
