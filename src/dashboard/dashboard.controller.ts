/**
 * dashboard/dashboard.controller.ts — Trading Dashboard API
 * ===========================================================
 * REST endpoints consumed by public/index.html.
 * Sprint 4.1 additions: /approvals, /news, /analytics
 */

import { Controller, Get, Post, Param, Logger, Res } from '@nestjs/common';
import type { Response } from 'express';
import { JournalService } from '../journal/journal.service';
import { Mt5Service, Position } from '../mt5/mt5.service';
import { SmcService } from '../smc/smc.service';
import { ConfigService } from '@nestjs/config';
import { ApprovalService } from '../approval/approval.service';
import { NewsService } from '../news/news.service';
import { AnalysisService } from '../analysis/analysis.service';
import { TradingService } from '../trading/trading.service';

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
    private readonly trading:   TradingService,
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

  /** Live bid/ask price */
  @Get('price')
  async price() {
    const symbol = this.config.get<string>('SYMBOL', 'XAUUSD');
    return this.mt5.getPrice(symbol).catch(() => null);
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

  /** Live SMC state — 5-layer: D1 → H4 → H1 → M15 → M5 */
  @Get('smc')
  async smcState() {
    const symbol    = this.config.get<string>('SYMBOL',     'XAUUSD');
    const htfTf     = this.config.get<string>('HTF_TF',     'D1');
    const h4Tf      = this.config.get<string>('H4_TF',      'H4');
    const confirmTf = this.config.get<string>('CONFIRM_TF', 'H1');
    const setupTf   = this.config.get<string>('SETUP_TF',   'M15');
    const entryTf   = this.config.get<string>('ENTRY_TF',   'M5');

    try {
      const [d1, h4, h1, m15, m5] = await Promise.all([
        this.mt5.getCandles(htfTf,     200, symbol),
        this.mt5.getCandles(h4Tf,      200, symbol),
        this.mt5.getCandles(confirmTf, 200, symbol),
        this.mt5.getCandles(setupTf,   200, symbol),
        this.mt5.getCandles(entryTf,   200, symbol),
      ]);

      const bias   = this.smc.getHTFBias(d1);
      const obs    = this.smc.detectOrderBlocks(m15);
      const fvgs   = this.smc.detectFVGs(m15);
      const sweeps = this.smc.detectLiquiditySweeps(m5);
      const pd     = this.smc.premiumDiscount(m15);
      const h4Pd   = this.smc.premiumDiscount(h4);
      const h4Obs  = this.smc.detectOrderBlocks(h4);
      const h1Structs = this.smc.detectStructure(h1);
      const signal = this.smc.analyze(d1, h4, h1, m15, m5);

      return {
        bias,
        h4Zone:     h4Pd.zone,
        h4ZonePct:  h4Pd.pct,
        h4ObCount:  h4Obs.length,
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

  /**
   * GET /dashboard/debug — X-ray every gate in the trade pipeline.
   * Returns a JSON report showing exactly where the cycle would stop.
   * Safe: read-only, does NOT create approvals or place orders.
   */
  @Get('debug')
  async debugCycle() {
    const symbol    = this.config.get<string>('SYMBOL',     'XAUUSD');
    const htfTf     = this.config.get<string>('HTF_TF',     'D1');
    const h4Tf      = this.config.get<string>('H4_TF',      'H4');
    const confirmTf = this.config.get<string>('CONFIRM_TF', 'H1');
    const setupTf   = this.config.get<string>('SETUP_TF',   'M15');
    const entryTf   = this.config.get<string>('ENTRY_TF',   'M5');

    const report: Record<string, any> = {
      symbol,
      timestamp: new Date().toISOString(),
      envFlags: {
        SKIP_SESSION_FILTER: this.config.get<string>('SKIP_SESSION_FILTER', 'false'),
        SKIP_OB_FVG_GATE:    this.config.get<string>('SKIP_OB_FVG_GATE',    'false'),
        SKIP_ZONE_CHECK:     this.config.get<string>('SKIP_ZONE_CHECK',     'false'),
        AI_ENABLED:          this.config.get<string>('AI_ENABLED',           'true'),
        CONFIDENCE_THRESHOLD: this.config.get<string>('CONFIDENCE_THRESHOLD', '60'),
        SPREAD_LIMIT:         this.config.get<string>('SPREAD_LIMIT',         '30'),
      },
    };

    // ── Gate 1: Candles ──────────────────────────────────────────────────────
    let d1: any[] = [], h4: any[] = [], h1: any[] = [], m15: any[] = [], m5: any[] = [];
    try {
      [d1, h4, h1, m15, m5] = await Promise.all([
        this.mt5.getCandles(htfTf,     200, symbol),
        this.mt5.getCandles(h4Tf,      200, symbol),
        this.mt5.getCandles(confirmTf, 200, symbol),
        this.mt5.getCandles(setupTf,   200, symbol),
        this.mt5.getCandles(entryTf,   200, symbol),
      ]);
      report.candles = { d1: d1.length, h4: h4.length, h1: h1.length, m15: m15.length, m5: m5.length, ok: true };
    } catch (e: any) {
      return { ...report, blockedAt: 'CANDLES', error: e.message };
    }
    if (!d1.length || !h4.length || !h1.length || !m15.length || !m5.length) {
      return { ...report, blockedAt: 'CANDLES', error: 'One or more timeframes returned empty — MetaApi account may still be deploying' };
    }

    // ── Gate 2: SMC analysis ─────────────────────────────────────────────────
    let smcState: any = {};
    let analysisResult: any = null;
    try {
      const bias        = this.smc.getHTFBias(d1);
      const obs         = this.smc.detectOrderBlocks(m15);
      const fvgs        = this.smc.detectFVGs(m15);
      const pd          = this.smc.premiumDiscount(m15);
      const h4Pd        = this.smc.premiumDiscount(h4);
      const h4Obs       = this.smc.detectOrderBlocks(h4);
      const h1Structs   = this.smc.detectStructure(h1);
      const smcSignal   = this.smc.analyze(d1, h4, h1, m15, m5);
      const price       = m5[m5.length - 1]?.close ?? 0;

      smcState = {
        bias,
        h4Zone: h4Pd.zone, h4ZonePct: h4Pd.pct, h4ObCount: h4Obs.length,
        zone: pd.zone, zonePct: pd.pct,
        h1BullStructs: h1Structs.filter((s: any) => s.direction === 'BULLISH' || s.bias === 'BULLISH').length,
        h1BearStructs: h1Structs.filter((s: any) => s.direction === 'BEARISH' || s.bias === 'BEARISH').length,
        h1Bos:   h1Structs.some((s: any) => s.type === 'BOS'),
        h1Choch: h1Structs.some((s: any) => s.type === 'CHoCH'),
        obCount: obs.length, fvgCount: fvgs.length,
        currentPrice: price,
        smcSignal: smcSignal ? { direction: smcSignal.direction, confidence: smcSignal.confidence, rr: smcSignal.rr } : null,
        smcOk: smcSignal !== null,
      };
      report.smc = smcState;

      if (!smcSignal) {
        const skipZone   = this.config.get<string>('SKIP_ZONE_CHECK',  'false') === 'true';
        const skipObFvg  = this.config.get<string>('SKIP_OB_FVG_GATE', 'false') === 'true';
        report.blockedAt = 'SMC';
        report.blockedReason = bias === 'NEUTRAL'
          ? 'D1 bias is NEUTRAL — need clear BULLISH or BEARISH daily trend'
          : (bias === 'BULLISH' && pd.zone !== 'discount' && !skipZone)
            ? `D1 BULLISH but M15 is in ${pd.zone} zone — need DISCOUNT for longs`
          : (bias === 'BEARISH' && pd.zone !== 'premium' && !skipZone)
            ? `D1 BEARISH but M15 is in ${pd.zone} zone — need PREMIUM for shorts`
          : (!skipObFvg)
            ? 'No M15 OB or FVG touching price (set SKIP_OB_FVG_GATE=true to bypass)'
            : `SMC returned null despite all bypasses — check NestJS logs for SMC SHORT blocked line`;
        return report;
      }

      analysisResult = await this.analysis.run(d1, h4, h1, m15, m5, symbol);
      report.analysis = {
        ok: analysisResult !== null,
        direction: analysisResult?.smcSignal?.direction ?? analysisResult?.recommendation?.decision ?? 'null',
        aiDecision: analysisResult?.recommendation?.decision ?? 'no AI',
      };

      if (!analysisResult) {
        report.blockedAt = 'ANALYSIS';
        report.blockedReason = 'analysis.run() returned null — AI said WAIT or signal parameters invalid';
        return report;
      }
    } catch (e: any) {
      return { ...report, blockedAt: 'SMC/ANALYSIS', error: e.message };
    }

    // ── Gate 3: Risk ─────────────────────────────────────────────────────────
    try {
      const [account, tick, positions] = await Promise.all([
        this.mt5.getAccount(),
        this.mt5.getPrice(symbol),
        this.mt5.getPositions(symbol),
      ]);

      const nowUtc = new Date().getUTCHours();
      const sessionOk = this.config.get<string>('SKIP_SESSION_FILTER', 'false') === 'true'
        ? true
        : (() => {
            const ls = parseInt(this.config.get('LONDON_START', '7'));
            const le = parseInt(this.config.get('LONDON_END', '16'));
            const ns = parseInt(this.config.get('NY_START', '12'));
            const ne = parseInt(this.config.get('NY_END', '21'));
            return (nowUtc >= ls && nowUtc < le) || (nowUtc >= ns && nowUtc < ne);
          })();

      const smc = analysisResult.smcSignal;
      const rec = analysisResult.recommendation;
      const rr  = rec?.rr ?? smc?.rr ?? 0;
      const confidence = rec?.confidence ?? smc?.confidence ?? 0;
      const spread = tick.spread ?? 0;

      report.risk = {
        utcHour:        nowUtc,
        sessionOk,
        sessionNote:    sessionOk ? 'In session' : `Outside session (GMT ${nowUtc}:xx) — set SKIP_SESSION_FILTER=true to test`,
        openPositions:  positions.length,
        maxTrades:      parseInt(this.config.get('MAX_TRADES', '3')),
        tradesOk:       positions.length < parseInt(this.config.get('MAX_TRADES', '3')),
        spread,
        spreadLimit:    parseInt(this.config.get('SPREAD_LIMIT', '30')),
        spreadOk:       spread <= parseInt(this.config.get('SPREAD_LIMIT', '30')),
        rr,
        minRR:          parseFloat(this.config.get('MIN_RR', '2')),
        rrOk:           rr >= parseFloat(this.config.get('MIN_RR', '2')),
        confidence,
        confidenceMin:  parseFloat(this.config.get('CONFIDENCE_THRESHOLD', '60')),
        confidenceOk:   confidence >= parseFloat(this.config.get('CONFIDENCE_THRESHOLD', '60')),
        balance:        account.balance,
      };

      const firstBlock = !sessionOk   ? 'SESSION_FILTER'
        : !report.risk.tradesOk       ? 'MAX_TRADES'
        : !report.risk.spreadOk       ? 'SPREAD_TOO_WIDE'
        : !report.risk.rrOk           ? 'RR_TOO_LOW'
        : !report.risk.confidenceOk   ? 'CONFIDENCE_TOO_LOW'
        : null;

      if (firstBlock) {
        report.blockedAt     = 'RISK';
        report.blockedReason = firstBlock;
        return report;
      }
    } catch (e: any) {
      return { ...report, blockedAt: 'RISK', error: e.message };
    }

    report.blockedAt     = 'NONE';
    report.blockedReason = '✅ All gates passed — cycle would create an Approval';
    return report;
  }

  /** POST /dashboard/trigger — run the full SMC cycle (analysis → risk → approval → trade) */
  @Post('trigger')
  async trigger() {
    try {
      // Run the full pipeline: SMC → FeatureEngine → AI → Risk → Approval creation
      // executeSMCCycle() creates the Approval record and waits for human decision.
      // We fire it without awaiting so the HTTP response returns immediately;
      // the approval appears in /dashboard/approvals on the next poll.
      this.trading.executeSMCCycle().catch(e =>
        this.logger.error(`Manual trigger cycle error: ${e.message}`),
      );
      return { ok: true, message: 'Cycle started — check Pending Approvals in ~5 seconds', timestamp: new Date().toISOString() };
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

  /** POST /dashboard/sync-history — import closed deals from MT5 into journal */
  @Post('sync-history')
  async syncHistory() {
    await this.trading.importMt5History();
    await this.trading.syncMt5Positions();
    const stats = await this.journal.getAllTimeStats();
    return { ok: true, totalImported: stats.total };
  }

  /**
   * POST /dashboard/reconcile — re-fetch PnL for any CLOSED trades that have exitPrice=0.
   * Uses the existing /trade_history bridge endpoint — no EA recompile needed.
   */
  @Post('reconcile')
  async reconcile() {
    const result = await this.trading.reconcileZeroPnl();
    return { ok: true, ...result };
  }

  /**
   * POST /dashboard/approve/:id — approve a pending trade from the dashboard.
   * Resolves the in-memory Promise that TradingService is waiting on → trade executes.
   */
  @Post('approve/:id')
  async approveFromDashboard(@Param('id') id: string) {
    const result = await this.approval.approve(+id);
    if (!result) return { ok: false, error: `Approval #${id} not found or already resolved` };
    this.logger.log(`Dashboard approved trade approval #${id}`);
    return { ok: true, status: result.status };
  }

  /**
   * POST /dashboard/reject/:id — reject a pending trade from the dashboard.
   */
  @Post('reject/:id')
  async rejectFromDashboard(@Param('id') id: string) {
    const result = await this.approval.reject(+id);
    if (!result) return { ok: false, error: `Approval #${id} not found or already resolved` };
    this.logger.log(`Dashboard rejected trade approval #${id}`);
    return { ok: true, status: result.status };
  }
}
