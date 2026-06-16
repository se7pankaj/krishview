/**
 * dashboard/dashboard.controller.ts — Trading Dashboard API
 * ===========================================================
 * REST endpoints consumed by public/index.html.
 * Sprint 4.1 additions: /approvals, /news, /analytics
 */

import { Controller, Get, Logger } from '@nestjs/common';
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

  /** Live SMC state */
  @Get('smc')
  async smcState() {
    const symbol  = this.config.get<string>('SYMBOL', 'XAUUSD');
    const htfTf   = this.config.get<string>('HTF_TF', 'H4');
    const entryTf = this.config.get<string>('ENTRY_TF', 'M15');

    try {
      const [htf, ltf] = await Promise.all([
        this.mt5.getCandles(htfTf, 150, symbol),
        this.mt5.getCandles(entryTf, 150, symbol),
      ]);

      const bias   = this.smc.getHTFBias(htf);
      const obs    = this.smc.detectOrderBlocks(ltf);
      const fvgs   = this.smc.detectFVGs(ltf);
      const sweeps = this.smc.detectLiquiditySweeps(ltf);
      const pd     = this.smc.premiumDiscount(ltf);
      const signal = this.smc.analyze(htf, ltf);

      return {
        bias,
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

  /** Trigger manual analysis cycle */
  @Get('trigger')
  async trigger() {
    return { message: 'Use POST /webhook with action BUY/SELL to trigger analysis' };
  }
}
