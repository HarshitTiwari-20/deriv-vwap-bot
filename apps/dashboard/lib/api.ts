import type { BotStatus } from './types';

const API = process.env.NEXT_PUBLIC_BOT_API_URL ?? 'http://localhost:3100';

export async function fetchStatus(): Promise<BotStatus | null> {
  try {
    const res = await fetch(`${API}/api/status`, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as BotStatus;
  } catch {
    return null;
  }
}

export function getWsUrl(): string {
  return process.env.NEXT_PUBLIC_BOT_WS_URL ?? 'ws://localhost:3101';
}
