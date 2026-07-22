import type {
  Balance,
  FuturesPosition,
  Order,
  OrderRequest,
} from '../types/trading.js';
import type { Candle, MarketMeta, Ticker, Timeframe } from '../types/market.js';

export interface FuturesInstrumentMeta extends MarketMeta {
  pair: string;
  maxLeverageLong: number;
  maxLeverageShort: number;
  quantityIncrement: number;
  priceIncrement: number;
  minTradeSize: number;
  unitContractValue: number;
}

export interface WalletTransferResult {
  ok: boolean;
  currency: string;
  amount: number;
  transferType: 'deposit' | 'withdraw';
  raw?: unknown;
}

export interface IExchangeClient {
  readonly name: string;
  getMarkets(): Promise<MarketMeta[]>;
  getTicker(symbol: string): Promise<Ticker>;
  getTickers(): Promise<Ticker[]>;
  getCandles(symbol: string, timeframe: Timeframe, limit?: number): Promise<Candle[]>;
  getBalances(): Promise<Balance[]>;
  placeOrder(request: OrderRequest): Promise<Order>;
  cancelOrder(orderId: string, symbol?: string): Promise<Order>;
  getOrder(orderId: string, symbol?: string): Promise<Order>;
  getOpenOrders(symbol?: string): Promise<Order[]>;
  /** Futures extensions */
  getFuturesPositions?(): Promise<FuturesPosition[]>;
  exitFuturesPosition?(positionId: string): Promise<void>;
  updateLeverage?(symbol: string, leverage: number): Promise<void>;
  getInstrument?(symbol: string): Promise<FuturesInstrumentMeta | undefined>;
  toPair?(symbol: string): string;
  /** Cancel every open futures order (kill switch) */
  cancelAllOpenOrders?(): Promise<void>;
  /**
   * Move funds between spot and futures wallet.
   * transferType withdraw = futures → spot (redeem), deposit = spot → futures.
   */
  transferFuturesWallet?(
    transferType: 'deposit' | 'withdraw',
    amount: number,
    currency: string,
  ): Promise<WalletTransferResult>;
  /** USDT→INR rate for INR-margin sizing (1 when margin is USDT) */
  getUsdtInrRate?(): Promise<number>;
  /**
   * Attach exchange-side take-profit / stop-loss to an open futures position.
   * CoinDCX: POST .../positions/create_tpsl
   */
  createPositionTpsl?(
    positionId: string,
    opts: { stopLoss?: number; takeProfit?: number; symbol?: string },
  ): Promise<void>;
}

export type { Balance, Order, OrderRequest, Candle, Ticker, MarketMeta, Timeframe, FuturesPosition };
