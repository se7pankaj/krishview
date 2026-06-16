/**
 * dashboard/dashboard.controller.ts — Trading Dashboard API
 * ===========================================================
 * REST endpoints consumed by public/index.html.
 * Sprint 4.1 additions: /approvals, /news, /analytics
 */

import { Controller, Get, Post, Logger, Res } from '@nestjs/common';
import type { Response } from 'express';
import { JournalService } from '../journal/journal.service';
import { Mt5Service, Position } from '../mt5/mt5.service';
import { SmcService } from '../smc/smc.service';
import { ConfigService } from '@nestjs/config';
import { ApprovalService } from '../approval/approval.service';
import { NewsService } from '../news/news.service';
import { AnalysisService } from '../analysis/analysis.service';

@Controller('dashboard')
export class DashboardController {
  private readonly logger = new Logger(DashboardController.name);

  constructor(
    private readonly journal:   JournalService,
    private readonly mt5:       Mt5Service,
    private readonly smc:       SmcService,
    private readonly config:    ConfigService,
    private readonly approval:  ApprovalService,
    private readonly news:      NewsService,
    private readonly analysis:  AnalysisService,
  ) {}

  /** Combined account + daily stats */
  @Get('summary')
  async summary() {
    const symbol = this.config.get<string>('SYMBOL', 'XAUUSD');
    const defaultAccount = { balance: 0, equity: 0, login: 0, server: '' };

    const [account, positions, stats] = await Promise.all([
      this.mt5.getAccount().catch(() => defaultAccount) as Promise<typeof defaultAccount>,
      this.mt5.getPositions(symbol).catch(() => [] as Position[]),
      this.journal.getDailyStats(),
    ]);

    const floatPnL = (positions as Position[]).reduce((s, p) => s + (p.profit || 0), 0);

    return {
      login:       account.login,
      balance:     account.balance,
      equity:      account.equity,
      server:      account.server,
      dailyPnL:    stats.totalPnL,
      totalToday:  stats.total,
      wins:        stats.wins,
      losses:      stats.losses,
      winRate:     stats.winRate,
      openCount:   positions.length,
      floatingPnL: +floatPnL.toFixed(2),
    };
  }

  /** Open positions from MT5 */
  @Get('positions')
  async positions() {
    const symbol = this.config.get<string>('SYMBOL', 'XAUUSD');
    return this.mt5.getPositions(symbol).catch(() => []);
  }

  /** All trades from journal */
  @Get('trades')
  async trades() {
    return this.journal.getAll(200);
  }

  /** All-time stats */
  @Get('stats')
  async stats() {
    return this.journal.getAllTimeStats();
  }

  /** Live SMC state — 4-layer: D1 → H1 → M15 → M5 */
  @Get('smc')
  async smcState() {
    const symbol    = this.config.get<string>('SYMBOL',     'XAUUSD');
    const htfTf     = this.config.get<string>('HTF_TF',     'D1');
    const confirmTf = this.config.get<string>('CONFIRM_TF', 'H1');
    const setupTf   = this.config.get<string>('SETUP_TF',   'M15');
    const entryTf   = this.config.get<string>('ENTRY_TF',   'M5');

    try {
      const [d1, h1, m15, m5] = await Promise.all([
        this.mt5.getCandles(htfTf,     200, symbol),
        this.mt5.getCandles(confirmTf, 200, symbol),
        this.mt5.getCandles(setupTf,   200, symbol),
        this.mt5.getCandles(entryTf,   200, symbol),
      ]);

      const bias   = this.smc.getHTFBias(d1);
      const obs    = this.smc.detectOrderBlocks(m15);
      const fvgs   = this.smc.detectFVGs(m15);
      const sweeps = this.smc.detectLiquiditySweeps(m5);
      const pd     = this.smc.premiumDiscount(m15);
      const h1Structs = this.smc.detectStructure(h1);
      const signal = this.smc.analyze(d1, h1, m15, m5);

      return {
        bias,
        h1Bos:      h1Structs.some(s => s.type === 'BOS'),
        h1Choch:    h1Structs.some(s => s.type === 'CHoCH'),
        obCount:    obs.length,
        fvgCount:   fvgs.length,
        sweepCount: sweeps.filter(s => s.swept).length,
        zone:       pd.zone,
        zonePct:    pd.pct,
        confidence: signal?.confidence ?? 0,
        direction:  signal?.direction ?? null,
      };
    } catch (e: any) {
      return { bias: 'NEUTRAL', error: e.message };
    }
  }

  /** Pending approvals with confidence breakdown (Explainability Engine) */
  @Get('approvals')
  async approvals() {
    const pending = (await this.approval.getAll(20)).filter(a => a.status === 'PENDING');

    // Attach breakdown from the linked Analysis record
    const enriched = await Promise.all(
      pending.map(async a => {
        let breakdown: Record<string, any> | null = null;
        if (a.analysisId) {
          try {
            const anal = await this.analysis.findById(a.analysisId);
            breakdown = anal?.breakdown ?? null;
          } catch { /* ignore */ }
        }
        return { ...a, breakdown };
      }),
    );

    return enriched;
  }

  /** Upcoming high-impact news (Sprint 4.1) */
  @Get('news')
  async upcomingNews() {
    return this.news.getUpcoming(24);
  }

  /** POST /dashboard/trigger — run a fresh analysis cycle immediately */
  @Get('trigger')
  async triggerGet() {
    return { message: 'Send POST /dashboard/trigger to run a manual analysis cycle' };
  }

  /** POST /dashboard/trigger — run a fresh analysis cycle immediately */
  @Post('trigger')
  async trigger() {
    const symbol    = this.config.get<string>('SYMBOL',     'XAUUSD');
    const htfTf     = this.config.get<string>('HTF_TF',     'D1');
    const confirmTf = this.config.get<string>('CONFIRM_TF', 'H1');
    const setupTf   = this.config.get<string>('SETUP_TF',   'M15');
    const entryTf   = this.config.get<string>('ENTRY_TF',   'M5');

    try {
      const [d1, h1, m15, m5] = await Promise.all([
        this.mt5.getCandles(htfTf,     200, symbol),
        this.mt5.getCandles(confirmTf, 200, symbol),
        this.mt5.getCandles(setupTf,   200, symbol),
        this.mt5.getCandles(entryTf,   200, symbol),
      ]);

      const result = await this.analysis.run(d1, h1, m15, m5, symbol);
      return { ok: true, direction: result?.smcSignal?.direction ?? null, timestamp: new Date().toISOString() };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  }

  // ─── Journal APIs (doc §18.3, FR-022 to FR-026) ──────────────────────────

  /** GET /dashboard/journal — all trades (doc §18.3) */
  @Get('journal')
  async journalAll() {
    return this.journal.getAll(200);
  }

  /** GET /dashboard/journal/stats — all-time performance stats (doc §18.3) */
  @Get('journal/stats')
  async journalStats() {
    return this.journal.getAllTimeStats();
  }

  /**
   * GET /dashboard/journal/export — CSV download of all closed trades (FR-026, doc §18.3).
   * Sets Content-Disposition so the browser triggers a file download.
   */
  @Get('journal/export')
  async journalExport(@Res() res: Response) {
    const csv      = await this.journal.exportCsv();
    const filename = `krishview-trades-${new Date().toISOString().slice(0, 10)}.csv`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  }

  /** GET /dashboard/analysis/latest — most recent analysis record (doc §18.2) */
  @Get('analysis/latest')
  async analysisLatest() {
    return this.analysis.getLatest();
  }
}
