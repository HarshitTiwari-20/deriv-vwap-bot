import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export interface WsInstance {
  readyState: number;
  on(event: string, listener: (...args: never[]) => void): void;
  removeAllListeners(): void;
  close(): void;
  send(data: string): void;
  ping(): void;
}

export interface WsConstructor {
  new (url: string): WsInstance;
  OPEN: number;
}

export interface WssInstance {
  on(event: string, listener: (...args: never[]) => void): void;
  close(cb?: () => void): void;
}

export interface WssConstructor {
  new (opts: { port: number }): WssInstance;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const wsMod = require('ws') as WsConstructor & {
  WebSocketServer: WssConstructor;
  default?: WsConstructor;
};

export const WebSocket: WsConstructor = (wsMod as { default?: WsConstructor }).default ?? wsMod;
export const WebSocketServer: WssConstructor = wsMod.WebSocketServer;
