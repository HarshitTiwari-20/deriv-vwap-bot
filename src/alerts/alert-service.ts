import type { AppConfig } from '../config/schema.js';
import type { EventBus } from '../events/event-bus.js';
import type { SetupSignal } from '../types/strategy.js';
import type { ClosedTrade, Position } from '../types/trading.js';
import { getLogger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';

const log = getLogger('AlertService');

export class AlertService {
  constructor(
    private readonly config: AppConfig['alerts'],
    private readonly eventBus: EventBus,
  ) {}

  wire(): void {
    this.eventBus.on('signal:generated', ({ signal }) => {
      if (signal.confidence.passed) void this.sendSignal(signal);
    });
    this.eventBus.on('position:opened', ({ position }) => {
      void this.sendPositionOpened(position);
    });
    this.eventBus.on('position:closed', ({ trade }) => {
      void this.sendTradeClosed(trade);
    });
    this.eventBus.on('risk:halt', ({ reason }) => {
      void this.broadcast(`⚠️ TRADING HALTED\n\n${reason}`);
    });
    this.eventBus.on('risk:resume', () => {
      void this.broadcast('✅ Trading resumed for new session');
    });
    this.eventBus.on('risk:kill_switch', ({ active, reason }) => {
      void this.broadcast(
        active
          ? `🛑 KILL SWITCH ON\n\n${reason ?? 'Manual'}`
          : '✅ Kill switch cleared — trading enabled',
      );
    });
    this.eventBus.on('wallet:redeem', ({ amount, currency }) => {
      void this.broadcast(`💰 Redeemed ${amount} ${currency} futures → spot wallet`);
    });
  }

  formatSignal(signal: SetupSignal): string {
    const checks = signal.reasons.map((r) => `✓ ${r}`).join('\n');
    return [
      `${signal.side === 'buy' ? '🟢 BUY' : '🔴 SELL'} SIGNAL`,
      '',
      `Pair: ${signal.symbol}`,
      `Timeframe: ${signal.timeframe}`,
      `Confidence: ${signal.confidence.total}%`,
      '',
      `Entry: ${signal.entry}`,
      `Stop Loss: ${signal.stopLoss}`,
      `TP1: ${signal.takeProfit1}`,
      `TP2: ${signal.takeProfit2}`,
      signal.takeProfit3 !== undefined ? `TP3: ${signal.takeProfit3}` : null,
      `R:R: ${signal.riskReward.toFixed(2)}`,
      '',
      'Reason:',
      checks,
    ]
      .filter((x) => x !== null)
      .join('\n');
  }

  async sendSignal(signal: SetupSignal): Promise<void> {
    await this.broadcast(this.formatSignal(signal));
  }

  async sendPositionOpened(position: Position): Promise<void> {
    const msg = [
      `📥 POSITION OPENED`,
      `Pair: ${position.symbol}`,
      `Side: ${position.side.toUpperCase()}`,
      `Entry: ${position.entryPrice}`,
      `Qty: ${position.quantity}`,
      `SL: ${position.stopLoss}`,
      `Confidence: ${position.confidence}%`,
      `Leverage: ${position.leverage}x`,
      `Margin: ${position.marginUsed.toFixed(2)}`,
      `Mode: live-derivatives`,
    ].join('\n');
    await this.broadcast(msg);
  }

  async sendTradeClosed(trade: ClosedTrade): Promise<void> {
    const emoji = trade.pnl >= 0 ? '✅' : '❌';
    const msg = [
      `${emoji} TRADE CLOSED`,
      `Pair: ${trade.symbol}`,
      `Side: ${trade.side.toUpperCase()}`,
      `Entry: ${trade.entryPrice} → Exit: ${trade.exitPrice}`,
      `PnL: ${trade.pnl.toFixed(2)} USDT (${trade.pnlPct.toFixed(2)}%)`,
      `R: ${trade.rMultiple.toFixed(2)}`,
      `Reason: ${trade.exitReason}`,
    ].join('\n');
    await this.broadcast(msg);
  }

  async broadcast(message: string): Promise<void> {
    if (!this.config.enabled) return;
    const tasks: Promise<void>[] = [];
    if (this.config.telegramBotToken && this.config.telegramChatId) {
      tasks.push(this.sendTelegram(message));
    }
    if (this.config.discordWebhookUrl) {
      tasks.push(this.sendDiscord(message));
    }
    if (tasks.length === 0) {
      log.debug({ message: message.slice(0, 80) }, 'Alert (no channels configured)');
      return;
    }
    await Promise.allSettled(tasks);
    this.eventBus.emit('alert:sent', { channel: 'all', message });
  }

  private async sendTelegram(text: string): Promise<void> {
    const token = this.config.telegramBotToken!;
    const chatId = this.config.telegramChatId!;
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    await withRetry(async () => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          disable_web_page_preview: true,
        }),
      });
      if (!res.ok) {
        const err = new Error(`Telegram ${res.status}`) as Error & { status: number };
        err.status = res.status;
        throw err;
      }
    });
    log.info('Telegram alert sent');
  }

  private async sendDiscord(content: string): Promise<void> {
    const url = this.config.discordWebhookUrl!;
    await withRetry(async () => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: content.slice(0, 2000) }),
      });
      if (!res.ok) {
        const err = new Error(`Discord ${res.status}`) as Error & { status: number };
        err.status = res.status;
        throw err;
      }
    });
    log.info('Discord alert sent');
  }
}
