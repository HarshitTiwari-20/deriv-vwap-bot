'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { fetchStatus, getWsUrl } from '../lib/api';
import type { BotStatus, RankedCoin } from '../lib/types';

function fmt(n: number, d = 2): string {
  return Number.isFinite(n) ? n.toFixed(d) : '—';
}

function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
}

export default function Dashboard() {
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [connected, setConnected] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);

  useEffect(() => {
    void fetchStatus().then(setStatus);

    const ws = new WebSocket(getWsUrl());
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as { type: string; data: unknown };
        if (msg.type === 'status') setStatus(msg.data as BotStatus);
        if (msg.type === 'scan') {
          setStatus((prev) =>
            prev
              ? {
                  ...prev,
                  topRanked: (msg.data as { ranked: RankedCoin[] }).ranked,
                  lastScanAt: Date.now(),
                }
              : prev,
          );
          setLogs((l) =>
            [`[${new Date().toLocaleTimeString()}] Scan complete`].concat(l).slice(0, 50),
          );
        }
        if (msg.type === 'signal') {
          setLogs((l) =>
            [`[${new Date().toLocaleTimeString()}] Signal generated`]
              .concat(l)
              .slice(0, 50),
          );
        }
        if (msg.type === 'trade') {
          setLogs((l) =>
            [`[${new Date().toLocaleTimeString()}] Trade closed`]
              .concat(l)
              .slice(0, 50),
          );
          void fetchStatus().then(setStatus);
        }
        if (msg.type === 'position') {
          void fetchStatus().then(setStatus);
        }
      } catch {
        /* ignore */
      }
    };

    const poll = setInterval(() => void fetchStatus().then(setStatus), 10_000);
    return () => {
      ws.close();
      clearInterval(poll);
    };
  }, []);

  const equityCurve = useMemo(() => {
    const trades = status?.recentTrades ?? [];
    const eq = status?.risk.accountBalance ?? 10000;
    // rebuild roughly from reverse
    const sorted = [...trades].sort((a, b) => a.closedAt - b.closedAt);
    const start = eq - sorted.reduce((s, t) => s + t.pnl, 0);
    let e = start;
    return sorted.map((t) => {
      e += t.pnl;
      return { t: new Date(t.closedAt).toLocaleTimeString(), equity: e };
    });
  }, [status]);

  const ranked = status?.topRanked ?? [];
  const risk = status?.risk;

  return (
    <div className="space-y-6">
      {/* KPI row */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
        <Kpi
          label="Mode"
          value={(status?.mode ?? '—').toUpperCase()}
          accent="red"
        />
        <Kpi
          label="Status"
          value={
            status?.tradingHalted
              ? 'HALTED'
              : connected
                ? 'LIVE'
                : 'OFFLINE'
          }
          accent={status?.tradingHalted ? 'red' : connected ? 'green' : 'amber'}
        />
        <Kpi label="Universe" value={String(status?.universeSize ?? 0)} />
        <Kpi
          label="Daily PnL"
          value={`${fmt(status?.dailyPnl ?? 0)} USDT`}
          accent={(status?.dailyPnl ?? 0) >= 0 ? 'green' : 'red'}
        />
        <Kpi label="Win Rate" value={`${fmt(status?.winRate ?? 0, 1)}%`} />
        <Kpi label="Open" value={String(status?.openPositions ?? 0)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Ranked coins */}
        <div className="card lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">
              Live Scanner — Top 10
            </h2>
            <span className="text-xs text-slate-500">
              Last scan:{' '}
              {status?.lastScanAt
                ? new Date(status.lastScanAt).toLocaleTimeString()
                : '—'}
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase text-slate-500">
                <tr>
                  <th className="pb-2 pr-2">#</th>
                  <th className="pb-2 pr-2">Symbol</th>
                  <th className="pb-2 pr-2">Score</th>
                  <th className="pb-2 pr-2">Conf</th>
                  <th className="pb-2 pr-2">RVOL</th>
                  <th className="pb-2 pr-2">Signal</th>
                </tr>
              </thead>
              <tbody>
                {ranked.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-slate-500">
                      Waiting for scan data… Start the bot API on :3100
                    </td>
                  </tr>
                )}
                {ranked.map((r) => (
                  <tr
                    key={r.symbol}
                    className="border-t border-surface-border/60 hover:bg-white/5"
                  >
                    <td className="py-2 pr-2 font-mono text-slate-400">{r.rank}</td>
                    <td className="py-2 pr-2 font-semibold">{r.symbol}</td>
                    <td className="py-2 pr-2 font-mono text-accent-blue">
                      {fmt(r.score, 1)}
                    </td>
                    <td className="py-2 pr-2 font-mono">
                      <ConfBadge value={r.signal?.confidence.total ?? r.factors.confidence ?? 0} />
                    </td>
                    <td className="py-2 pr-2 font-mono text-slate-300">
                      {fmt(r.factors.relativeVolume ?? 0, 1)}
                    </td>
                    <td className="py-2 pr-2">
                      {r.signal ? (
                        <span
                          className={`badge ${
                            r.signal.side === 'buy'
                              ? 'bg-accent-green/20 text-accent-green'
                              : 'bg-accent-red/20 text-accent-red'
                          }`}
                        >
                          {r.signal.side.toUpperCase()} {fmt(r.signal.confidence.total, 0)}%
                        </span>
                      ) : (
                        <span className="text-slate-600">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Risk */}
        <div className="card space-y-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">
            Risk Metrics
          </h2>
          <Row label="Balance" value={`${fmt(risk?.accountBalance ?? 0)} USDT`} />
          <Row label="Equity" value={`${fmt(risk?.equity ?? 0)} USDT`} />
          <Row
            label="Daily PnL %"
            value={`${fmt(risk?.dailyPnlPct ?? 0)}%`}
            color={(risk?.dailyPnlPct ?? 0) >= 0 ? 'text-accent-green' : 'text-accent-red'}
          />
          <Row label="Consec. Losses" value={String(risk?.consecutiveLosses ?? 0)} />
          <Row label="Max DD" value={`${fmt(risk?.maxDrawdownPct ?? 0)}%`} />
          <Row label="Total Trades" value={String(risk?.totalTrades ?? 0)} />
          <Row label="Uptime" value={fmtUptime(status?.uptime ?? 0)} />
          {status?.tradingHalted && (
            <div className="rounded-lg border border-accent-red/40 bg-accent-red/10 p-2 text-xs text-accent-red">
              {risk?.haltReason ?? 'Trading halted'}
            </div>
          )}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Positions */}
        <div className="card">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-400">
            Open Trades
          </h2>
          <div className="space-y-2">
            {(status?.openPositionsDetail ?? []).length === 0 && (
              <p className="py-6 text-center text-sm text-slate-500">No open positions</p>
            )}
            {(status?.openPositionsDetail ?? []).map((p) => (
              <div
                key={p.id}
                className="flex items-center justify-between rounded-lg border border-surface-border bg-surface/50 px-3 py-2 text-sm"
              >
                <div>
                  <div className="font-semibold">
                    {p.symbol}{' '}
                    <span
                      className={
                        p.side === 'buy' ? 'text-accent-green' : 'text-accent-red'
                      }
                    >
                      {p.side.toUpperCase()}
                    </span>
                  </div>
                  <div className="text-xs text-slate-400">
                    Entry {fmt(p.entryPrice)} · SL {fmt(p.currentStop)} · Conf{' '}
                    {fmt(p.confidence, 0)}%
                  </div>
                </div>
                <div
                  className={`font-mono ${
                    p.unrealizedPnl >= 0 ? 'text-accent-green' : 'text-accent-red'
                  }`}
                >
                  {fmt(p.unrealizedPnl)}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Equity / PnL chart */}
        <div className="card">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-400">
            Equity Curve
          </h2>
          <div className="h-56">
            {equityCurve.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={equityCurve}>
                  <defs>
                    <linearGradient id="eq" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#38bdf8" stopOpacity={0.4} />
                      <stop offset="100%" stopColor="#38bdf8" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="#1e2a40" strokeDasharray="3 3" />
                  <XAxis dataKey="t" tick={{ fill: '#64748b', fontSize: 10 }} />
                  <YAxis tick={{ fill: '#64748b', fontSize: 10 }} domain={['auto', 'auto']} />
                  <Tooltip
                    contentStyle={{
                      background: '#121a2b',
                      border: '1px solid #1e2a40',
                      borderRadius: 8,
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="equity"
                    stroke="#38bdf8"
                    fill="url(#eq)"
                    strokeWidth={2}
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-slate-500">
                No closed trades yet
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Trade history */}
        <div className="card">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-400">
            Trade History
          </h2>
          <div className="max-h-64 overflow-y-auto">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-surface-card text-xs uppercase text-slate-500">
                <tr>
                  <th className="pb-2">Pair</th>
                  <th className="pb-2">PnL</th>
                  <th className="pb-2">R</th>
                  <th className="pb-2">Exit</th>
                </tr>
              </thead>
              <tbody>
                {(status?.recentTrades ?? []).map((t) => (
                  <tr key={t.id} className="border-t border-surface-border/50">
                    <td className="py-1.5 font-medium">{t.symbol}</td>
                    <td
                      className={`py-1.5 font-mono ${
                        t.pnl >= 0 ? 'text-accent-green' : 'text-accent-red'
                      }`}
                    >
                      {fmt(t.pnl)}
                    </td>
                    <td className="py-1.5 font-mono">{fmt(t.rMultiple)}</td>
                    <td className="py-1.5 text-xs text-slate-400">{t.exitReason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Zones + score breakdown */}
        <div className="card">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-400">
            Institutional Zones
          </h2>
          <div className="mb-4 h-40">
            {(status?.zones ?? []).length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={(status?.zones ?? []).slice(0, 12).map((z) => ({
                    name: z.symbol.slice(0, 6),
                    strength: z.strengthScore,
                  }))}
                >
                  <CartesianGrid stroke="#1e2a40" strokeDasharray="3 3" />
                  <XAxis dataKey="name" tick={{ fill: '#64748b', fontSize: 10 }} />
                  <YAxis tick={{ fill: '#64748b', fontSize: 10 }} />
                  <Tooltip
                    contentStyle={{
                      background: '#121a2b',
                      border: '1px solid #1e2a40',
                    }}
                  />
                  <Bar dataKey="strength" fill="#22c55e" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-slate-500">
                No active zones
              </div>
            )}
          </div>
          <div className="max-h-32 space-y-1 overflow-y-auto text-xs">
            {(status?.zones ?? []).slice(0, 8).map((z) => (
              <div key={z.id} className="flex justify-between text-slate-400">
                <span>
                  {z.symbol}{' '}
                  <span
                    className={
                      z.type === 'demand' ? 'text-accent-green' : 'text-accent-red'
                    }
                  >
                    {z.type}
                  </span>
                </span>
                <span className="font-mono">
                  {fmt(z.low)}–{fmt(z.high)} · str {fmt(z.strengthScore, 0)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Logs */}
      <div className="card">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-400">
          Event Log
        </h2>
        <div className="max-h-40 overflow-y-auto font-mono text-xs text-slate-400 space-y-1">
          {logs.length === 0 && <p>No events yet</p>}
          {logs.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Kpi({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: 'green' | 'red' | 'blue' | 'amber';
}) {
  const color =
    accent === 'green'
      ? 'text-accent-green'
      : accent === 'red'
        ? 'text-accent-red'
        : accent === 'amber'
          ? 'text-accent-amber'
          : accent === 'blue'
            ? 'text-accent-blue'
            : 'text-slate-100';
  return (
    <div className="card py-3">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${color}`}>{value}</div>
    </div>
  );
}

function Row({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-slate-400">{label}</span>
      <span className={`font-mono ${color ?? 'text-slate-100'}`}>{value}</span>
    </div>
  );
}

function ConfBadge({ value }: { value: number }) {
  const c =
    value >= 85
      ? 'text-accent-green'
      : value >= 70
        ? 'text-accent-amber'
        : 'text-slate-400';
  return <span className={`font-mono ${c}`}>{fmt(value, 0)}</span>;
}
