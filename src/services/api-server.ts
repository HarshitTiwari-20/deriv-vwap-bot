import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { BotOrchestrator } from './bot-orchestrator.js';
import type { EventBus } from '../events/event-bus.js';
import type { AppConfig } from '../config/schema.js';
import { getLogger } from '../utils/logger.js';
import { WebSocketServer, type WsInstance } from '../websocket/ws-shim.js';

const log = getLogger('ApiServer');

/**
 * Lightweight HTTP + WS API for the Next.js dashboard.
 */
export class ApiServer {
  private httpServer?: ReturnType<typeof createServer>;
  private wss?: ReturnType<typeof createWss>;
  private clients = new Set<WsInstance>();

  constructor(
    private readonly config: AppConfig,
    private readonly bot: BotOrchestrator,
    private readonly eventBus: EventBus,
  ) {}

  start(): void {
    const port = this.config.server.apiPort;
    const wsPort = this.config.server.wsPort;

    this.httpServer = createServer((req, res) => {
      void this.handleHttp(req, res);
    });
    this.httpServer.listen(port, () => log.info({ port }, 'HTTP API listening'));

    this.wss = createWss(wsPort);
    this.wss.on('connection', ((ws: WsInstance) => {
      this.clients.add(ws);
      ws.send(JSON.stringify({ type: 'status', data: this.bot.getStatus() }));
      ws.on('close', (() => this.clients.delete(ws)) as (...args: never[]) => void);
    }) as (...args: never[]) => void);
    log.info({ wsPort }, 'Dashboard WS listening');

    const push = (type: string, data: unknown) => {
      const msg = JSON.stringify({ type, data, t: Date.now() });
      for (const c of this.clients) {
        try {
          c.send(msg);
        } catch {
          /* ignore broken client */
        }
      }
    };

    this.eventBus.on('scan:complete', ({ ranked, durationMs }) =>
      push('scan', { ranked, durationMs }),
    );
    this.eventBus.on('position:opened', ({ position }) => push('position', position));
    this.eventBus.on('position:closed', ({ trade }) => push('trade', trade));
    this.eventBus.on('position:updated', ({ position }) => push('position_update', position));
    this.eventBus.on('signal:generated', ({ signal }) => push('signal', signal));
    this.eventBus.on('risk:halt', ({ state, reason }) => push('risk_halt', { state, reason }));
    this.eventBus.on('ticker:update', ({ ticker }) => {
      push('ticker', ticker);
    });

    setInterval(() => push('status', this.bot.getStatus()), 5_000);
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url ?? '/';
    try {
      if (url === '/health') {
        this.json(res, 200, { ok: true, ts: Date.now() });
        return;
      }
      if (url === '/api/status') {
        this.json(res, 200, this.bot.getStatus());
        return;
      }
      if (url === '/api/ranked') {
        this.json(res, 200, this.bot.getStatus().topRanked);
        return;
      }
      if (url === '/api/positions') {
        this.json(res, 200, this.bot.getStatus().openPositionsDetail);
        return;
      }
      if (url === '/api/trades') {
        this.json(res, 200, this.bot.getStatus().recentTrades);
        return;
      }
      if (url === '/api/risk') {
        this.json(res, 200, this.bot.getStatus().risk);
        return;
      }
      if (url === '/api/zones') {
        this.json(res, 200, this.bot.getStatus().zones);
        return;
      }
      this.json(res, 404, { error: 'not found' });
    } catch (err) {
      log.error({ err }, 'API error');
      this.json(res, 500, { error: 'internal' });
    }
  }

  private json(res: ServerResponse, code: number, body: unknown): void {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  async stop(): Promise<void> {
    for (const c of this.clients) c.close();
    await new Promise<void>((resolve) => this.httpServer?.close(() => resolve()));
    await new Promise<void>((resolve) => this.wss?.close(() => resolve()));
  }
}

function createWss(port: number) {
  return new WebSocketServer({ port });
}
