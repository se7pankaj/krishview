/**
 * mt5/mt5.service.ts — MetaApi Cloud REST Client
 * ================================================
 * Replaces the local KrishViewBridge EA + bridge_mac.py with
 * MetaApi cloud REST API. No local EA or bridge script needed.
 *
 * MT5 runs in MetaApi's cloud — works 24/7 even when your Mac is off.
 * Docs: https://metaapi.cloud/docs/client/
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

// ─── Interfaces (unchanged — rest of app stays the same) ──────────────────────

export interface AccountInfo {
  login:       number;
  balance:     number;
  equity:      number;
  margin:      number;
  free_margin: number;
  currency:    string;
  company:     string;
  server:      string;
  leverage:    number;
}

export interface Tick {
  symbol: string;
  bid:    number;
  ask:    number;
  spread: number;
  time:   string;
}

export interface Candle {
  time:   string;
  open:   number;
  high:   number;
  low:    number;
  close:  number;
  volume: number;
}

export interface Position {
  ticket:        number;
  symbol:        string;
  type:          'BUY' | 'SELL';
  lots:          number;
  open_price:    number;
  current_price: number;
  sl:            number;
  tp:            number;
  profit:        number;
  magic:         number;
  comment:       string;
  open_time:     string;
}

export interface OrderRequest {
  direction: 'BUY' | 'SELL';
  lots:      number;
  sl:        number;
  tp:        number;
  comment?:  string;
}

export interface TradeResult {
  ticket:    number;
  price:     number;
  lots:      number;
  direction: string;
  comment:   string;
}

export interface ClosedDeal {
  ticket:    number;
  pnl:       number;
  exitPrice: number;
  exitTime:  string;
}

// ─── Timeframe mapping: env values → MetaApi format ───────────────────────────

const TF_MAP: Record<string, string> = {
  D1: '1d', H4: '4h', H1: '1h', H2: '2h',
  M30: '30m', M15: '15m', M5: '5m', M1: '1m',
};

@Injectable()
export class Mt5Service {
  private readonly logger = new Logger(Mt5Service.name);
  private readonly client:         AxiosInstance;
  private readonly historyClient:  AxiosInstance;  // historical candles use different hostname
  private readonly symbol: string;
  private readonly accountId: string;

  constructor(private readonly config: ConfigService) {
    const token     = this.config.get<string>('METAAPI_TOKEN',      '');
    const accountId = this.config.get<string>('METAAPI_ACCOUNT_ID', '');
    const region    = this.config.get<string>('METAAPI_REGION',     'london');
    this.symbol     = this.config.get<string>('SYMBOL', 'XAUUSD');
    this.accountId  = accountId;

    const headers = {
      'auth-token':   token,
      'Content-Type': 'application/json',
    };

    this.client = axios.create({
      baseURL: `https://mt-client-api-v1.${region}.agiliumtrade.ai`,
      timeout: 30_000,
      headers,
    });

    // Historical market data is hosted on a separate subdomain per MetaApi docs
    this.historyClient = axios.create({
      baseURL: `https://mt-market-data-client-api-v1.${region}.agiliumtrade.ai`,
      timeout: 60_000,  // candle requests can take longer
      headers,
    });

    this.logger.log(`MetaApi configured: accountId=${accountId} region=${region}`);
  }

  private toMetaTf(tf: string): string {
    return TF_MAP[tf] ?? tf;
  }

  private get acctPath(): string {
    return `/users/current/accounts/${this.accountId}`;
  }

  // ─── Ping ─────────────────────────────────────────────────────────────────

  async ping(): Promise<boolean> {
    try {
      await this.client.get(`${this.acctPath}/account-information`);
      return true;
    } catch {
      return false;
    }
  }

  // ─── Account info ─────────────────────────────────────────────────────────

  async getAccount(): Promise<AccountInfo> {
    const r = await this.client.get(`${this.acctPath}/account-information`);
    const d = r.data;
    return {
      login:       parseInt(d.login, 10),
      balance:     d.balance,
      equity:      d.equity,
      margin:      d.margin      ?? 0,
      free_margin: d.freeMargin  ?? d.free_margin ?? 0,
      currency:    d.currency,
      company:     d.broker      ?? d.company ?? '',
      server:      d.server,
      leverage:    d.leverage,
    };
  }

  // ─── Current price ────────────────────────────────────────────────────────

  async getPrice(symbol?: string): Promise<Tick> {
    const sym = symbol ?? this.symbol;
    const r   = await this.client.get(
      `${this.acctPath}/symbols/${sym}/current-price`,
      { params: { keepSubscription: false } },
    );
    const d      = r.data;
    const spread = +((d.ask - d.bid) * 10).toFixed(1); // points
    return {
      symbol: sym,
      bid:    d.bid,
      ask:    d.ask,
      spread,
      time:   d.time ?? new Date().toISOString(),
    };
  }

  // ─── Candles ──────────────────────────────────────────────────────────────

  async getCandles(timeframe: string, count = 150, symbol?: string): Promise<Candle[]> {
    const sym = symbol ?? this.symbol;
    const tf  = this.toMetaTf(timeframe);

    const r = await this.historyClient.get(
      `${this.acctPath}/historical-market-data/symbols/${sym}/timeframes/${tf}/candles`,
      { params: { limit: count } },
    );

    const raw: any[] = r.data?.candles ?? r.data ?? [];

    const candles = raw.map(c => ({
      time:   c.time,
      open:   c.open,
      high:   c.high,
      low:    c.low,
      close:  c.close,
      volume: c.tickVolume ?? c.volume ?? 0,
    }));

    // Ensure ascending order (oldest first)
    candles.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
    return candles;
  }

  // ─── Open positions ───────────────────────────────────────────────────────

  async getPositions(symbol?: string): Promise<Position[]> {
    const sym = symbol ?? this.symbol;
    const r   = await this.client.get(`${this.acctPath}/positions`);
    const all: any[] = r.data ?? [];

    return all
      .filter(p => p.symbol === sym)
      .map(p => ({
        ticket:        parseInt(p.id, 10),
        symbol:        p.symbol,
        type:          p.type === 'POSITION_TYPE_BUY' ? 'BUY' as const : 'SELL' as const,
        lots:          p.volume,
        open_price:    p.openPrice,
        current_price: p.currentPrice ?? p.openPrice,
        sl:            p.stopLoss    ?? 0,
        tp:            p.takeProfit  ?? 0,
        profit:        p.profit      ?? 0,
        magic:         p.magic       ?? 0,
        comment:       p.comment     ?? '',
        open_time:     p.time,
      }));
  }

  // ─── Place order ──────────────────────────────────────────────────────────

  async placeOrder(order: OrderRequest): Promise<TradeResult> {
    const magic  = parseInt(this.config.get<string>('MAGIC_NUMBER', '20240101'), 10);
    const symbol = this.symbol;

    const r = await this.client.post(`${this.acctPath}/trade`, {
      actionType: order.direction === 'BUY' ? 'ORDER_TYPE_BUY' : 'ORDER_TYPE_SELL',
      symbol,
      volume:     order.lots,
      stopLoss:   order.sl,
      takeProfit: order.tp,
      magic,
      comment:    order.comment ?? 'KrishView-SMC',
    });

    const d = r.data;
    if (d.numericCode && d.numericCode !== 10009) {
      throw new Error(`MT5 rejected order: ${d.stringCode} — ${d.message}`);
    }

    const ticket = parseInt(d.positionId ?? d.orderId ?? '0', 10);
    this.logger.log(`Order placed: #${ticket} ${order.direction} ${order.lots} ${symbol}`);

    return {
      ticket,
      price:     d.price     ?? 0,
      lots:      order.lots,
      direction: order.direction,
      comment:   order.comment ?? 'KrishView-SMC',
    };
  }

  // ─── Modify position SL/TP ────────────────────────────────────────────────

  async modifyPosition(ticket: number, sl: number, tp: number): Promise<void> {
    await this.client.post(`${this.acctPath}/trade`, {
      actionType: 'POSITION_MODIFY',
      positionId: String(ticket),
      stopLoss:   sl,
      takeProfit: tp,
    });
    this.logger.log(`Modified #${ticket}: SL=${sl} TP=${tp}`);
  }

  // ─── Close position ───────────────────────────────────────────────────────

  async closePosition(ticket: number): Promise<{ ok: boolean; profit: number }> {
    const positions = await this.getPositions().catch((): Position[] => []);
    const profit    = positions.find(p => p.ticket === ticket)?.profit ?? 0;

    const r  = await this.client.post(`${this.acctPath}/trade`, {
      actionType: 'POSITION_CLOSE_ID',
      positionId: String(ticket),
    });
    const ok = r.data?.numericCode === 10009 || r.data?.stringCode === 'TRADE_RETCODE_DONE';
    this.logger.log(`Closed #${ticket}: profit=${profit}`);
    return { ok, profit };
  }

  // ─── Closed deal PnL ─────────────────────────────────────────────────────

  /**
   * @param ticket  This is actually the POSITION id (placeOrder() returns
   *                positionId as "ticket" — see TradeResult). MetaApi's
   *                /history-deals/ticket/:ticket endpoint filters by an
   *                individual DEAL ticket, which is a different number —
   *                querying it with a position id returns an empty array
   *                almost every time, which is why this used to silently
   *                fall back to Exit=0/PnL=$0.00 after retries exhausted.
   *                /history-deals/position/:positionId is the correct
   *                endpoint — it returns every deal (entry + exit) tied to
   *                that position.
   */
  async getClosedDealPnL(ticket: number): Promise<ClosedDeal | null> {
    try {
      const r     = await this.client.get(`${this.acctPath}/history-deals/position/${ticket}`);
      const deals: any[] = r.data ?? [];

      const closing = deals.find(d =>
        d.entryType === 'DEAL_ENTRY_OUT' || d.entry === 'DEAL_ENTRY_OUT',
      ) ?? deals[deals.length - 1];

      if (closing && closing.price > 0) {
        return {
          ticket,
          pnl:       closing.profit ?? 0,
          exitPrice: closing.price  ?? 0,
          exitTime:  closing.time   ?? '',
        };
      }
      return null;
    } catch (e: any) {
      this.logger.warn(`getClosedDealPnL #${ticket} failed: ${e?.message}`);
      return null;
    }
  }

  // ─── All closed deals (last 365 days) ────────────────────────────────────

  async getAllClosedDeals(): Promise<Array<{
    ticket: number; deal: number; symbol: string; type: 'BUY' | 'SELL';
    lots: number; entryPrice: number; exitPrice: number; pnl: number; exitTime: string;
  }>> {
    try {
      const start = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
      const end   = new Date().toISOString();
      const r     = await this.client.get(
        `${this.acctPath}/history-deals/time/${start}/${end}`,
      );
      const deals: any[] = r.data ?? [];

      return deals
        .filter(d => d.symbol === this.symbol &&
          (d.entryType === 'DEAL_ENTRY_OUT' || d.entry === 'DEAL_ENTRY_OUT'))
        .map(d => ({
          ticket:     parseInt(d.positionId ?? d.id, 10),
          deal:       parseInt(d.id, 10),
          symbol:     d.symbol,
          type:       d.type === 'DEAL_TYPE_BUY' ? 'BUY' as const : 'SELL' as const,
          lots:       d.volume    ?? 0,
          entryPrice: 0,
          exitPrice:  d.price     ?? 0,
          pnl:        d.profit    ?? 0,
          exitTime:   d.time      ?? '',
        }));
    } catch (e: any) {
      this.logger.warn(`getAllClosedDeals failed: ${e?.message}`);
      return [];
    }
  }

  // ─── Partial close ────────────────────────────────────────────────────────

  async partialClose(ticket: number, lots: number): Promise<{ ok: boolean; profit: number }> {
    const r  = await this.client.post(`${this.acctPath}/trade`, {
      actionType: 'POSITION_PARTIAL',
      positionId: String(ticket),
      volume:     lots,
    });
    const ok = r.data?.numericCode === 10009 || r.data?.stringCode === 'TRADE_RETCODE_DONE';
    this.logger.log(`Partial close #${ticket} ${lots} lots`);
    return { ok, profit: 0 };
  }
}
