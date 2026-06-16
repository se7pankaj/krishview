/**
 * mt5/mt5.service.ts — MT5 Bridge HTTP Client
 * =============================================
 * NestJS service that calls the Python Flask bridge running on Windows.
 * The bridge wraps the MetaTrader5 Python library.
 *
 * Bridge must be running at MT5_BRIDGE_URL (default: http://localhost:7654)
 * Start it with: python mt5_bridge/bridge.py
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

export interface AccountInfo {
  login: number;
  balance: number;
  equity: number;
  margin: number;
  free_margin: number;
  currency: string;
  company: string;
  server: string;
  leverage: number;
}

export interface Tick {
  symbol: string;
  bid: number;
  ask: number;
  spread: number;
  time: string;
}

export interface Candle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Position {
  ticket: number;
  symbol: string;
  type: 'BUY' | 'SELL';
  lots: number;
  open_price: number;
  sl: number;
  tp: number;
  profit: number;
  magic: number;
  comment: string;
  open_time: string;
}

export interface OrderRequest {
  direction: 'BUY' | 'SELL';
  lots: number;
  sl: number;
  tp: number;
  comment?: string;
}

export interface TradeResult {
  ticket: number;
  price: number;
  lots: number;
  direction: string;
  comment: string;
}

export interface ClosedDeal {
  ticket:    number;
  pnl:       number;
  exitPrice: number;
  exitTime:  string;
}

@Injectable()
export class Mt5Service {
  private readonly logger = new Logger(Mt5Service.name);
  private readonly client: AxiosInstance;
  private readonly symbol: string;

  constructor(private readonly config: ConfigService) {
    const bridgeUrl = this.config.get<string>('MT5_BRIDGE_URL', 'http://localhost:7654');
    this.symbol     = this.config.get<string>('SYMBOL', 'XAUUSD');

    this.client = axios.create({
      baseURL: bridgeUrl,
      timeout: 10_000,
    });

    this.logger.log(`MT5 bridge configured at: ${bridgeUrl}`);
  }

  async ping(): Promise<boolean> {
    try {
      await this.client.get('/ping');
      return true;
    } catch {
      return false;
    }
  }

  async getAccount(): Promise<AccountInfo> {
    const r = await this.client.get<AccountInfo>('/account');
    return r.data;
  }

  async getPrice(symbol?: string): Promise<Tick> {
    const sym = symbol ?? this.symbol;
    const r = await this.client.get<Tick>(`/price/${sym}`);
    return r.data;
  }

  async getCandles(
    timeframe: string,
    count = 150,
    symbol?: string,
  ): Promise<Candle[]> {
    const sym = symbol ?? this.symbol;
    const r   = await this.client.get<{ candles: Candle[] }>('/candles', {
      params: { symbol: sym, timeframe, count },
    });
    return r.data.candles;
  }

  async getPositions(symbol?: string): Promise<Position[]> {
    const sym = symbol ?? this.symbol;
    const r   = await this.client.get<{ positions: Position[] }>('/positions', {
      params: { symbol: sym },
    });
    return r.data.positions ?? [];
  }

  async placeOrder(order: OrderRequest): Promise<TradeResult> {
    const magic   = this.config.get<string>('MAGIC_NUMBER', '20240101');
    const symbol  = this.symbol;

    const r = await this.client.post<TradeResult>('/order', {
      symbol,
      action:  order.direction,
      lots:    order.lots,
      sl:      order.sl,
      tp:      order.tp,
      magic:   parseInt(magic, 10),
      comment: order.comment ?? 'KrishView-SMC',
    });

    this.logger.log(
      `Order placed: #${r.data.ticket} ${order.direction} ${order.lots} ${symbol} @ ${r.data.price}`,
    );
    return r.data;
  }

  async modifyPosition(ticket: number, sl: number, tp: number): Promise<void> {
    await this.client.post('/modify', { ticket, sl, tp });
    this.logger.log(`Modified #${ticket}: SL=${sl} TP=${tp}`);
  }

  async closePosition(ticket: number): Promise<{ ok: boolean; profit: number }> {
    const r = await this.client.post<{ ok: boolean; profit: number }>('/close', { ticket });
    this.logger.log(`Closed #${ticket}: profit=${r.data.profit}`);
    return r.data;
  }

  /**
   * Fetch actual P&L for a closed position from MT5 trade history.
   * Calls /trade_history on the bridge (Sprint 3.1).
   */
  async getClosedDealPnL(ticket: number): Promise<ClosedDeal | null> {
    try {
      const r = await this.client.post<ClosedDeal>('/trade_history', { ticket });
      return r.data;
    } catch (e: any) {
      this.logger.warn(`getClosedDealPnL #${ticket} failed: ${e?.message}`);
      return null;
    }
  }

  /**
   * Partially close a position by reducing lot size.
   * Used for Partial TP (Sprint 3.2).
   */
  async partialClose(ticket: number, lots: number): Promise<{ ok: boolean; profit: number }> {
    const r = await this.client.post<{ ok: boolean; profit: number }>(
      '/partial_close', { ticket, lots },
    );
    this.logger.log(`Partial close #${ticket} ${lots} lots: profit=${r.data.profit}`);
    return r.data;
  }
}
