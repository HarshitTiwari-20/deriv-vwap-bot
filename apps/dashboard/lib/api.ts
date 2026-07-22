import type { BotStatus } from './types';

const API = process.env.NEXT_PUBLIC_BOT_API_URL ?? 'http://localhost:3100';

export async function fetchStatus(): Promise<BotStatus | null> {
  try {
    const res = await fetch(`${API}/api/status`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    return (await res.json()) as BotStatus;
  } catch {
    return null;
  }
}

export function getWsUrl(): string {
  return process.env.NEXT_PUBLIC_BOT_WS_URL ?? 'ws://localhost:3101';
}

async function postJson<T>(
  path: string,
  body: Record<string, unknown> = {},
): Promise<{ ok: boolean; data?: T; error?: string }> {
  try {
    const res = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    const data = (await res.json()) as T & { message?: string; error?: string };
    if (!res.ok) {
      return {
        ok: false,
        data,
        error: (data as { message?: string }).message ?? (data as { error?: string }).error ?? res.statusText,
      };
    }
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface KillSwitchResult {
  ok: boolean;
  closed: number;
  failed: number;
  ordersCancelled: boolean;
  message: string;
}

export interface RedeemResult {
  ok: boolean;
  amount: number;
  currency: string;
  message: string;
}

export interface ResumeResult {
  ok: boolean;
  message: string;
}

/** Flatten + halt all trading (kill switch). */
export function postKillSwitch(reason?: string) {
  return postJson<KillSwitchResult>('/api/kill-switch', {
    reason: reason ?? 'Manual kill switch from dashboard',
  });
}

/** Clear kill switch and resume entries. */
export function postResume() {
  return postJson<ResumeResult>('/api/resume', {});
}

/** Transfer free futures profits to spot wallet. */
export function postRedeemProfits(opts?: { keepBalance?: number; allFree?: boolean }) {
  return postJson<RedeemResult>('/api/redeem-profits', {
    ...(opts?.keepBalance !== undefined ? { keepBalance: opts.keepBalance } : {}),
    ...(opts?.allFree ? { allFree: true } : {}),
  });
}
