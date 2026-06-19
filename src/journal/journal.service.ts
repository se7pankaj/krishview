/**
 * journal/journal.service.ts — Trade Journal
 * ===========================================
 * Stores every trade in PostgreSQL via TypeORM.
 * Replaces the SQLite-based journal.js from the standalone bot.
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';
import { Trade } from './entities/trade.entity';
import { SMCSignal } from '../smc/smc.service';

export interface DailyStats {
  totalPnL: number;
  total: number;
  wins: number;
  losses: number;
  winRate: number;
}

@Injectable()
export class JournalService {
  private readonly logger = new Logger(JournalService.name);

  constructor(
    @InjectRepository(Trade)
    private readonly repo: Repository<Trade>,
  ) {}

  /** Import a position that was opened outside the bot (e.g. manually in MT5) */
  async logManualEntry(params: {
    ticket:    number;
    symbol:    string;
    direction: 'BUY' | 'SELL';
    lots:      number;
    entryPrice: number;
    sl:        number;
    tp:        number;
  }): Promise<Trade> {
    const trade = this.repo.create({
      ticket:      params.ticket,
      symbol:      params.symbol,
      direction:   params.direction,
      lots:        params.lots,
      entryPrice:  params.entryPrice,
      sl:          params.sl,
      tp:          params.tp,
      currentSl:   params.sl,
      rrPlanned:   0,
      confidence:  0,
      smcReasons:  ['manual'],
      status:      'OPEN',
      openTime:    new Date(),
      session:     this.currentSession(),
      trailCount:  0,
      partialTpHit: false,
    });
    const saved = await this.repo.save(trade);
    this.logger.log(`Journal: Manual import #${saved.ticket} ${saved.direction} @ ${saved.entryPrice}`);
    return saved;
  }

  /** Record a new entry (trade placed) */
  async logEntry(params: {
    ticket:     number;
    symbol:     string;
    direction:  'BUY' | 'SELL';
    lots:       number;
    signal:     SMCSignal;
    session?:   string;
    lastAtr?:   number;
    analysisId?: number;
  }): Promise<Trade> {
    const trade = this.repo.create({
      ticket:      params.ticket,
      symbol:      params.symbol,
      direction:   params.direction,
      lots:        params.lots,
      entryPrice:  params.signal.entryPrice,
      sl:          params.signal.sl,
      tp:          params.signal.tp,
      currentSl:   params.signal.sl,
      rrPlanned:   params.signal.rr,
      confidence:  params.signal.confidence,
      smcReasons:  params.signal.reasons,
      status:      'OPEN',
      openTime:    new Date(),
      session:     params.session ?? this.currentSession(),
      lastAtr:     params.lastAtr,
      analysisId:  params.analysisId,
      trailCount:  0,
      partialTpHit: false,
    });

    const saved = await this.repo.save(trade);
    this.logger.log(`Journal: Entry logged #${saved.ticket} ${saved.direction} @ ${saved.entryPrice}`);
    return saved;
  }

  /** Update record when trade closes */
  async logExit(params: {
    ticket: number;
    exitPrice: number;
    pnl: number;
    closeReason: string;
  }): Promise<void> {
    const trade = await this.repo.findOne({ where: { ticket: params.ticket } });
    if (!trade) {
      this.logger.warn(`Journal: Ticket #${params.ticket} not found for exit logging`);
      return;
    }

    const risk   = Math.abs(trade.entryPrice - trade.sl);
    const rrActual = risk > 0
      ? +((params.pnl > 0 ? 1 : -1) * Math.abs(params.exitPrice - trade.entryPrice) / risk).toFixed(2)
      : 0;

    trade.exitPrice   = params.exitPrice;
    trade.pnl         = params.pnl;
    trade.rrActual    = rrActual;
    trade.status      = 'CLOSED';
    trade.closeTime   = new Date();
    trade.closeReason = params.closeReason;

    await this.repo.save(trade);
    this.logger.log(`Journal: Exit logged #${params.ticket} PnL=$${params.pnl} RR:${rrActual}`);
  }

  /** Update SL after trailing/break-even move (Sprint 3.2) */
  async updateSl(ticket: number, newSl: number): Promise<void> {
    const trade = await this.repo.findOne({ where: { ticket } });
    if (!trade) return;
    await this.repo.update(trade.id, {
      currentSl:  newSl,
      trailCount: (trade.trailCount ?? 0) + 1,
    });
  }

  /** Mark partial TP as taken (Sprint 3.2) */
  async markPartialTp(ticket: number): Promise<void> {
    const trade = await this.repo.findOne({ where: { ticket } });
    if (trade) await this.repo.update(trade.id, { partialTpHit: true });
  }

  /** Import a closed deal from MT5 history that isn't already in the journal.
   *  If a record exists with pnl=0 (bad data from a failed deal lookup), overwrite it. */
  async importClosedDeal(params: {
    ticket:     number;
    symbol:     string;
    direction:  'BUY' | 'SELL';
    lots:       number;
    entryPrice: number;
    exitPrice:  number;
    pnl:        number;
    exitTime:   string;
  }): Promise<void> {
    const existing = await this.repo.findOne({ where: { ticket: params.ticket } });
    // Skip if already recorded with real PnL data
    if (existing && (existing.pnl !== 0 || existing.exitPrice !== 0)) return;
    // If exists with zero PnL (bad data), delete and re-import
    if (existing) await this.repo.delete(existing.id);

    const trade = this.repo.create({
      ticket:      params.ticket,
      symbol:      params.symbol,
      direction:   params.direction,
      lots:        params.lots,
      entryPrice:  params.entryPrice || params.exitPrice,
      exitPrice:   params.exitPrice,
      sl:          0,
      tp:          0,
      currentSl:   0,
      rrPlanned:   0,
      rrActual:    0,
      confidence:  0,
      smcReasons:  ['imported'],
      pnl:         params.pnl,
      status:      'CLOSED',
      openTime:    new Date(params.exitTime),
      closeTime:   new Date(params.exitTime),
      closeReason: 'IMPORTED',
      trailCount:  0,
      partialTpHit: false,
    });
    await this.repo.save(trade);
  }

  /** Check if a ticket is already in the journal (any status) */
  async hasTicket(ticket: number): Promise<boolean> {
    const count = await this.repo.count({ where: { ticket } });
    return count > 0;
  }

  /** Get all open trades */
  async getOpenTrades(): Promise<Trade[]> {
    return this.repo.find({ where: { status: 'OPEN' }, order: { openTime: 'ASC' } });
  }

  /** Get CLOSED trades that have exitPrice=0 — need PnL reconciliation */
  async getClosedWithZeroExit(): Promise<Trade[]> {
    return this.repo.find({
      where: { status: 'CLOSED', exitPrice: 0 },
      order: { closeTime: 'DESC' },
    });
  }

  /** Get all trades, newest first */
  async getAll(limit = 100): Promise<Trade[]> {
    return this.repo.find({ order: { createdAt: 'DESC' }, take: limit });
  }

  /** Daily P&L for circuit-breaker check */
  async getDailyPnL(): Promise<number> {
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date();

    const closed = await this.repo.find({
      where: { status: 'CLOSED', closeTime: Between(start, end) },
    });

    return closed.reduce((sum, t) => sum + (Number(t.pnl) || 0), 0);
  }

  /** Daily stats for reporting */
  async getDailyStats(): Promise<DailyStats> {
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date();

    const closed = await this.repo.find({
      where: { status: 'CLOSED', closeTime: Between(start, end) },
    });

    const totalPnL = closed.reduce((sum, t) => sum + (Number(t.pnl) || 0), 0);
    const wins     = closed.filter(t => (Number(t.pnl) || 0) > 0).length;
    const losses   = closed.filter(t => (Number(t.pnl) || 0) <= 0).length;
    const winRate  = closed.length > 0 ? +(wins / closed.length * 100).toFixed(1) : 0;

    return { totalPnL: +totalPnL.toFixed(2), total: closed.length, wins, losses, winRate };
  }

  /** All-time performance stats */
  async getAllTimeStats(): Promise<{
    total: number;
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    avgRR: number;
    totalPnL: number;
    profitFactor: number | null;
  }> {
    const all = await this.repo.find({ where: { status: 'CLOSED' } });
    const wins    = all.filter(t => (Number(t.pnl) || 0) > 0).length;
    const losses  = all.length - wins;
    const totalPnL = all.reduce((s, t) => s + (Number(t.pnl) || 0), 0);
    const avgRR   = all.length > 0
      ? +(all.reduce((s, t) => s + (Number(t.rrActual) || 0), 0) / all.length).toFixed(2)
      : 0;

    const grossProfit = all.reduce((s, t) => {
      const p = Number(t.pnl) || 0;
      return s + (p > 0 ? p : 0);
    }, 0);
    const grossLoss = Math.abs(all.reduce((s, t) => {
      const p = Number(t.pnl) || 0;
      return s + (p < 0 ? p : 0);
    }, 0));
    const profitFactor = grossLoss > 0 ? +(grossProfit / grossLoss).toFixed(2) : null;

    return {
      total: all.length,
      totalTrades: all.length,
      wins, losses,
      winRate: all.length > 0 ? +(wins / all.length * 100).toFixed(1) : 0,
      avgRR, totalPnL: +totalPnL.toFixed(2),
      profitFactor,
    };
  }

  /**
   * Export all closed trades as a CSV string (FR-026, doc §18.3).
   * Caller is responsible for setting response headers.
   */
  async exportCsv(): Promise<string> {
    const trades = await this.repo.find({ where: { status: 'CLOSED' }, order: { closeTime: 'ASC' } });

    const header = [
      'id', 'ticket', 'symbol', 'direction', 'lots',
      'entryPrice', 'exitPrice', 'sl', 'tp',
      'pnl', 'rrPlanned', 'rrActual', 'confidence',
      'session', 'closeReason', 'openTime', 'closeTime',
      'trailCount', 'partialTpHit', 'analysisId',
    ].join(',');

    const rows = trades.map(t => [
      t.id, t.ticket, t.symbol, t.direction, t.lots,
      t.entryPrice, t.exitPrice, t.sl, t.tp,
      t.pnl, t.rrPlanned, t.rrActual, t.confidence,
      t.session ?? '', t.closeReason ?? '',
      t.openTime?.toISOString() ?? '',
      t.closeTime?.toISOString() ?? '',
      t.trailCount, t.partialTpHit ? 1 : 0,
      t.analysisId ?? '',
    ].join(','));

    return [header, ...rows].join('\n');
  }

  /** Count consecutive losses from the most recent trades (doc §16.2) */
  async getConsecutiveLosses(): Promise<number> {
    const recent = await this.repo.find({
      where: { status: 'CLOSED' },
      order: { closeTime: 'DESC' },
      take: 10,
    });

    let streak = 0;
    for (const t of recent) {
      if ((Number(t.pnl) || 0) <= 0) streak++;
      else break;
    }
    return streak;
  }

  private currentSession(): string {
    const h = new Date().getUTCHours();
    if (h >= 7 && h < 12)  return 'london';
    if (h >= 12 && h < 17) return 'london_ny_overlap';
    if (h >= 17 && h < 21) return 'newyork';
    return 'asian';
  }
}
