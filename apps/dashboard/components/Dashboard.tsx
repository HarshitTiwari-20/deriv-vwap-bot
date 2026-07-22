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
import {
  fetchStatus,
  getWsUrl,
  postKillSwitch,
  postRedeemProfits,
  postResume,
} from '../lib/api';
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
  const [apiOk, setApiOk] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [busy, setBusy] = useState<'kill' | 'resume' | 'redeem' | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [scanFilter, setScanFilter] = useState('');
  const [scanOnlySignals, setScanOnlySignals] = useState(false);

  const marginCcy =
    status?.marginCurrency ?? status?.risk?.marginCurrency ?? 'USDT';
  const starting = Boolean(status?.mode?.includes('starting'));

  useEffect(() => {
    let closed = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const pull = async () => {
      const s = await fetchStatus();
      if (closed) return;
      setStatus(s);
      setApiOk(s !== null);
    };
    void pull();

    const onMessage = (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(ev.data as string) as { type: string; data: unknown };
        if (msg.type === 'status') {
          setStatus(msg.data as BotStatus);
          setApiOk(true);
        }
        if (msg.type === 'scan') {
          const d = msg.data as {
            ranked: RankedCoin[];
            durationMs?: number;
          };
          setStatus((prev) =>
            prev
              ? {
                  ...prev,
                  scannedPairs: d.ranked,
                  topRanked: d.ranked.slice(0, 10),
                  lastScanAt: Date.now(),
                  lastScanDurationMs: d.durationMs,
                  universeSize: d.ranked.length || prev.universeSize,
                  signalCount: d.ranked.filter((r) => r.signal?.confidence?.passed).length,
                }
              : prev,
          );
          setLogs((l) =>
            [
              `[${new Date().toLocaleTimeString()}] Scan ${d.ranked.length} pairs in ${d.durationMs ?? '?'}ms`,
            ]
              .concat(l)
              .slice(0, 50),
          );
        }
        if (msg.type === 'signal') {
          setLogs((l) =>
            [`[${new Date().toLocaleTimeString()}] Signal generated`].concat(l).slice(0, 50),
          );
        }
        if (msg.type === 'trade') {
          setLogs((l) =>
            [`[${new Date().toLocaleTimeString()}] Trade closed`].concat(l).slice(0, 50),
          );
          void pull();
        }
        if (msg.type === 'position') void pull();
        if (msg.type === 'kill_switch') {
          const d = msg.data as { active: boolean; reason?: string };
          setLogs((l) =>
            [
              `[${new Date().toLocaleTimeString()}] Kill switch ${d.active ? 'ON' : 'OFF'}${
                d.reason ? `: ${d.reason}` : ''
              }`,
            ]
              .concat(l)
              .slice(0, 50),
          );
          void pull();
        }
        if (msg.type === 'wallet_redeem') {
          const d = msg.data as { amount: number; currency: string };
          setLogs((l) =>
            [
              `[${new Date().toLocaleTimeString()}] Redeemed ${d.amount} ${d.currency} → spot`,
            ]
              .concat(l)
              .slice(0, 50),
          );
          void pull();
        }
      } catch {
        /* ignore */
      }
    };

    const connectWs = () => {
      if (closed) return;
      try {
        ws = new WebSocket(getWsUrl());
        ws.onopen = () => setConnected(true);
        ws.onclose = () => {
          setConnected(false);
          if (!closed) reconnectTimer = setTimeout(connectWs, 3000);
        };
        ws.onerror = () => {
          try {
            ws?.close();
          } catch {
            /* ignore */
          }
        };
        ws.onmessage = onMessage;
      } catch {
        setConnected(false);
        if (!closed) reconnectTimer = setTimeout(connectWs, 3000);
      }
    };
    connectWs();

    const poll = setInterval(() => void pull(), 5_000);
    return () => {
      closed = true;
      clearInterval(poll);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    };
  }, []);

  const equityCurve = useMemo(() => {
    const trades = status?.recentTrades ?? [];
    const dayStart = status?.risk.sessionStartBalance ?? status?.risk.accountBalance ?? 0;
    const sorted = [...trades].sort((a, b) => a.closedAt - b.closedAt);
    // Build curve from day-start baseline + cumulative trade PnL (margin currency)
    let e = dayStart;
    const points = sorted.map((t) => {
      e += t.pnl;
      return { t: new Date(t.closedAt).toLocaleTimeString(), equity: e };
    });
    // Anchor current wallet equity as last point when available
    const nowEq = status?.risk.accountBalance;
    if (nowEq != null && Number.isFinite(nowEq)) {
      points.push({
        t: 'now',
        equity: nowEq,
      });
    }
    return points;
  }, [status]);

  const ranked = status?.topRanked ?? [];
  const scannedAll = status?.scannedPairs ?? ranked;
  const filteredScan = useMemo(() => {
    const q = scanFilter.trim().toUpperCase();
    return scannedAll.filter((r) => {
      if (scanOnlySignals && !r.signal) return false;
      if (q && !r.symbol.toUpperCase().includes(q)) return false;
      return true;
    });
  }, [scannedAll, scanFilter, scanOnlySignals]);
  const risk = status?.risk;
  const killOn = Boolean(status?.killSwitchActive || risk?.killSwitchActive);
  const halted = Boolean(status?.tradingHalted || risk?.tradingHalted);

  async function onKill() {
    if (
      !window.confirm(
        'KILL SWITCH\n\nThis will:\n• Halt all new trades\n• Cancel open orders\n• Close all positions at market\n\nContinue?',
      )
    ) {
      return;
    }
    setBusy('kill');
    setActionMsg(null);
    const res = await postKillSwitch('Manual kill switch from dashboard');
    setBusy(null);
    setActionMsg(res.data?.message ?? res.error ?? 'Kill switch sent');
    void fetchStatus().then(setStatus);
  }

  async function onResume() {
    setBusy('resume');
    setActionMsg(null);
    const res = await postResume();
    setBusy(null);
    setActionMsg(res.data?.message ?? res.error ?? 'Resume sent');
    void fetchStatus().then(setStatus);
  }

  async function onRedeem() {
    if (
      !window.confirm(
        `Redeem profits to spot wallet?\n\nTransfers free ${marginCcy} from futures → spot (keeps trading reserve). Open position margin is not moved.`,
      )
    ) {
      return;
    }
    setBusy('redeem');
    setActionMsg(null);
    const res = await postRedeemProfits();
    setBusy(null);
    setActionMsg(res.data?.message ?? res.error ?? 'Redeem finished');
    void fetchStatus().then(setStatus);
  }

  return (
    <div className="space-y-6">
      {!apiOk && (
        <div className="rounded-lg border border-accent-amber/40 bg-accent-amber/10 px-3 py-2 text-sm text-accent-amber">
          Bot API offline on :3100 — start with <code className="font-mono">pnpm dev</code> in
          the project root. Dashboard UI is up; live data appears when the API connects.
        </div>
      )}
      {apiOk && starting && (
        <div className="rounded-lg border border-accent-blue/40 bg-accent-blue/10 px-3 py-2 text-sm text-accent-blue">
          Bot API online — warming markets & candles (micro mode). Scanner data appears shortly…
        </div>
      )}

      {/* Control bar */}
      <div className="card flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm font-semibold text-slate-200">Controls</div>
          <div className="text-xs text-slate-500">
            {status?.mode ?? '—'} · margin {marginCcy} · lev{' '}
            {status?.leverage ?? risk?.defaultLeverage ?? '—'}x · API{' '}
            {apiOk ? (connected ? 'WS live' : 'HTTP ok') : 'down'}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy !== null || !connected}
            onClick={() => void onRedeem()}
            className="rounded-lg border border-accent-green/40 bg-accent-green/15 px-3 py-2 text-sm font-medium text-accent-green transition hover:bg-accent-green/25 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy === 'redeem' ? 'Redeeming…' : `Redeem profits → spot`}
          </button>
          {killOn ? (
            <button
              type="button"
              disabled={busy !== null || !connected}
              onClick={() => void onResume()}
              className="rounded-lg border border-accent-blue/40 bg-accent-blue/15 px-3 py-2 text-sm font-medium text-accent-blue transition hover:bg-accent-blue/25 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy === 'resume' ? 'Resuming…' : 'Resume trading'}
            </button>
          ) : (
            <button
              type="button"
              disabled={busy !== null || !connected}
              onClick={() => void onKill()}
              className="rounded-lg border border-accent-red/50 bg-accent-red/20 px-3 py-2 text-sm font-semibold text-accent-red transition hover:bg-accent-red/30 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy === 'kill' ? 'Killing…' : '☠ Kill switch'}
            </button>
          )}
        </div>
      </div>

      {actionMsg && (
        <div
          className={`rounded-lg border px-3 py-2 text-sm ${
            actionMsg.toLowerCase().includes('fail') ||
            actionMsg.toLowerCase().includes('error') ||
            actionMsg.toLowerCase().includes('nothing')
              ? 'border-accent-amber/40 bg-accent-amber/10 text-accent-amber'
              : 'border-accent-blue/30 bg-accent-blue/10 text-slate-200'
          }`}
        >
          {actionMsg}
        </div>
      )}

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-8">
        <Kpi label="Mode" value={(status?.mode ?? '—').toUpperCase()} accent="red" />
        <Kpi
          label="Status"
          value={
            !apiOk
              ? 'API DOWN'
              : starting
                ? 'STARTING'
                : killOn
                  ? 'KILL ON'
                  : halted
                    ? 'HALTED'
                    : connected
                      ? 'LIVE'
                      : 'HTTP'
          }
          accent={
            !apiOk || killOn || halted
              ? 'red'
              : starting
                ? 'amber'
                : connected
                  ? 'green'
                  : 'amber'
          }
        />
        <Kpi label="Universe" value={String(status?.universeSize ?? scannedAll.length ?? 0)} accent="blue" />
        <Kpi label="Scanned" value={String(scannedAll.length)} />
        <Kpi
          label="Signals"
          value={String(status?.signalCount ?? scannedAll.filter((r) => r.signal).length)}
          accent="green"
        />
        <Kpi
          label="Scan ms"
          value={status?.lastScanDurationMs != null ? String(status.lastScanDurationMs) : '—'}
        />
        <Kpi
          label="Daily PnL"
          value={`${fmt(status?.dailyPnl ?? risk?.dailyPnl ?? 0)} ${marginCcy}`}
          accent={(status?.dailyPnl ?? risk?.dailyPnl ?? 0) >= 0 ? 'green' : 'red'}
        />
        <Kpi label="Open" value={String(status?.openPositions ?? 0)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Best of best */}
        <div className="card lg:col-span-2">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">
              Best of best — Top 10 trade candidates
            </h2>
            <span className="text-xs text-slate-500">
              Last scan:{' '}
              {status?.lastScanAt
                ? new Date(status.lastScanAt).toLocaleTimeString()
                : '—'}
              {status?.lastScanDurationMs != null
                ? ` · ${status.lastScanDurationMs}ms`
                : ''}
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
                      Waiting for scan data… Bot warms 100–200 pairs on start
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
          <Row label="Balance" value={`${fmt(risk?.accountBalance ?? 0)} ${marginCcy}`} />
          <Row label="Equity" value={`${fmt(risk?.equity ?? 0)} ${marginCcy}`} />
          <Row
            label="Capital tier"
            value={(risk?.capitalTier ?? '—').toUpperCase()}
          />
          <Row
            label="Max open (auto)"
            value={String(risk?.adaptiveMaxOpenTrades ?? '—')}
          />
          <Row
            label="≈ Equity USDT"
            value={fmt(risk?.adaptiveEquityUsdt ?? 0, 2)}
          />
          <Row
            label="Session start"
            value={`${fmt(risk?.sessionStartBalance ?? 0)} ${marginCcy}`}
          />
          <Row
            label="Daily PnL"
            value={`${fmt(risk?.dailyPnl ?? 0)} ${marginCcy}`}
            color={(risk?.dailyPnl ?? 0) >= 0 ? 'text-accent-green' : 'text-accent-red'}
          />
          <Row
            label="Daily PnL %"
            value={`${fmt(risk?.dailyPnlPct ?? 0)}%`}
            color={(risk?.dailyPnlPct ?? 0) >= 0 ? 'text-accent-green' : 'text-accent-red'}
          />
          <Row
            label="Day start bal"
            value={`${fmt(risk?.sessionStartBalance ?? 0)} ${marginCcy}`}
          />
          <Row label="Consec. Losses" value={String(risk?.consecutiveLosses ?? 0)} />
          <Row label="Max DD" value={`${fmt(risk?.maxDrawdownPct ?? 0)}%`} />
          <Row label="Total Trades" value={String(risk?.totalTrades ?? 0)} />
          <Row label="Uptime" value={fmtUptime(status?.uptime ?? 0)} />
          <Row label="Leverage" value={`${status?.leverage ?? risk?.defaultLeverage ?? '—'}x`} />
          {killOn && (
            <div className="rounded-lg border border-accent-red/50 bg-accent-red/15 p-2 text-xs font-semibold text-accent-red">
              KILL SWITCH ACTIVE — {risk?.killSwitchReason ?? risk?.haltReason ?? 'manual'}
            </div>
          )}
          {!killOn && halted && (
            <div className="rounded-lg border border-accent-red/40 bg-accent-red/10 p-2 text-xs text-accent-red">
              {risk?.haltReason ?? 'Trading halted'}
            </div>
          )}
        </div>
      </div>

      {/* Full universe scan — all pairs */}
      <div className="card">
        <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">
              Full universe scan — all pairs
            </h2>
            <p className="text-xs text-slate-500">
              Scanning {status?.universeSize ?? scannedAll.length} markets · ranked best → worst ·
              trade only the single best setup that passes risk
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="search"
              placeholder="Filter symbol…"
              value={scanFilter}
              onChange={(e) => setScanFilter(e.target.value)}
              className="rounded-lg border border-surface-border bg-surface px-3 py-1.5 text-sm text-slate-100 placeholder:text-slate-600 focus:border-accent-blue/50 focus:outline-none"
            />
            <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-400">
              <input
                type="checkbox"
                checked={scanOnlySignals}
                onChange={(e) => setScanOnlySignals(e.target.checked)}
                className="rounded border-surface-border"
              />
              Signals only
            </label>
            <span className="text-xs text-slate-500">
              Showing {filteredScan.length}/{scannedAll.length}
            </span>
          </div>
        </div>
        <div className="max-h-[420px] overflow-auto">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 z-10 bg-surface-card text-xs uppercase text-slate-500">
              <tr>
                <th className="pb-2 pr-2 pt-1">#</th>
                <th className="pb-2 pr-2 pt-1">Symbol</th>
                <th className="pb-2 pr-2 pt-1">Score</th>
                <th className="pb-2 pr-2 pt-1">Conf</th>
                <th className="pb-2 pr-2 pt-1">VWAP</th>
                <th className="pb-2 pr-2 pt-1">Mom</th>
                <th className="pb-2 pr-2 pt-1">Trend</th>
                <th className="pb-2 pr-2 pt-1">RVOL</th>
                <th className="pb-2 pr-2 pt-1">Spread</th>
                <th className="pb-2 pt-1">Signal</th>
              </tr>
            </thead>
            <tbody>
              {filteredScan.length === 0 && (
                <tr>
                  <td colSpan={10} className="py-10 text-center text-slate-500">
                    {scannedAll.length === 0
                      ? 'Waiting for full-universe scan…'
                      : 'No pairs match filter'}
                  </td>
                </tr>
              )}
              {filteredScan.map((r) => {
                const conf = r.signal?.confidence.total ?? r.factors.confidence ?? 0;
                const hasSig = Boolean(r.signal);
                return (
                  <tr
                    key={`${r.rank}-${r.symbol}`}
                    className={`border-t border-surface-border/40 hover:bg-white/5 ${
                      hasSig ? 'bg-accent-green/5' : ''
                    }`}
                  >
                    <td className="py-1.5 pr-2 font-mono text-xs text-slate-500">{r.rank}</td>
                    <td className="py-1.5 pr-2 font-semibold">{r.symbol}</td>
                    <td className="py-1.5 pr-2 font-mono text-accent-blue">{fmt(r.score, 1)}</td>
                    <td className="py-1.5 pr-2 font-mono">
                      <ConfBadge value={conf} />
                    </td>
                    <td className="py-1.5 pr-2 font-mono text-xs text-slate-400">
                      {fmt(r.factors.vwapAlignment ?? 0, 0)}
                    </td>
                    <td className="py-1.5 pr-2 font-mono text-xs text-slate-400">
                      {fmt(r.factors.momentum ?? 0, 0)}
                    </td>
                    <td className="py-1.5 pr-2 font-mono text-xs text-slate-400">
                      {fmt(r.factors.trendStrength ?? 0, 0)}
                    </td>
                    <td className="py-1.5 pr-2 font-mono text-xs text-slate-300">
                      {fmt(r.factors.relativeVolume ?? 0, 1)}
                    </td>
                    <td className="py-1.5 pr-2 font-mono text-xs text-slate-400">
                      {fmt(r.factors.spread ?? 0, 0)}
                    </td>
                    <td className="py-1.5">
                      {r.signal ? (
                        <span
                          className={`badge ${
                            r.signal.side === 'buy'
                              ? 'bg-accent-green/20 text-accent-green'
                              : 'bg-accent-red/20 text-accent-red'
                          }`}
                        >
                          {r.signal.side.toUpperCase()} {fmt(r.signal.confidence.total, 0)}
                          {r.signal.riskReward != null
                            ? ` · RR ${fmt(r.signal.riskReward, 1)}`
                            : ''}
                        </span>
                      ) : (
                        <span className="text-xs text-slate-600">watch</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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
                    {p.leverage ? (
                      <span className="ml-1 text-xs text-slate-500">{p.leverage}x</span>
                    ) : null}
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
