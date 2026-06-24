/**
 * trading/trading.service.ts — Main Trading Orchestrator (Sprint 2)
 * ==================================================================
 * Pipeline: SMC → FeatureEngine → AI Reasoning → Approval → Execute
 * Uses native setInterval (no @nestjs/schedule dependency).
 */

import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SmcService } from '../smc/smc.service';
import { RiskService } from '../risk/risk.service';
import { Mt5Service } from '../mt5/mt5.service';
import { JournalService } from '../journal/journal.service';
import { TelegramService } from '../telegram.service';
import { AnalysisService } from '../analysis/analysis.service';
import { ApprovalService } from '../approval/approval.service';
import { MlService } from '../ml/ml.service';
import { ConfidenceExplainerService } from '../analysis/confidence-explainer.service';
import { NewsService } from '../news/news.service';
import { ActiveSymbolService } from './active-symbol.service';
import { SymbolSpecService } from '../symbol/symbol-spec.service';
import { AppConfigService } from '../config/app-config.service';
import { getActiveSession } from '../common/symbol-registry';

@Injectable()
export class TradingService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TradingService.name);

  // ── Dynamic getter — reads from SymbolModule at call time, never cached ──
  private get symbol(): string { return this.activeSymbol.getSymbol(); }

  private readonly skipKillzoneCheck: boolean;
  private lastDailyReport = -1;

  /** In-memory retry counter for trades where deal PnL wasn't available yet */
  private readonly reconcileRetries = new Map<number, number>();
  private readonly MAX_RECONCILE_RETRIES = 20; // ~10 minutes at 30s intervals

  constructor(
    private readonly config:       ConfigService,
    private readonly smc:          SmcService,
    private readonly risk:         RiskService,
    private readonly mt5:          Mt5Service,
    private readonly journal:      JournalService,
    private readonly telegram:     TelegramService,
    private readonly analysis:     AnalysisService,
    private readonly approval:     ApprovalService,
    private readonly ml:           MlService,
    private readonly explainer:    ConfidenceExplainerService,
    private readonly news:         NewsService,
    private readonly activeSymbol: ActiveSymbolService,
    private readonly symbolSpec:   SymbolSpecService,
    private readonly appConfig:    AppConfigService,
  ) {
    this.skipKillzoneCheck = this.config.get<string>('SKIP_KILLZONE_CHECK', 'false') === 'true';
  }

  /**
   * Returns true if now is inside any active session for the current symbol.
   *
   * - INSTITUTIONAL: uses the strict London+NY killzone windows from SymbolRegistry
   * - PRECISION: extended hours 06:00–20:00 UTC on any weekday (broader intraday window
   *   that captures European open, US open, and mid-session setups)
   */
  private async inKillzone(): Promise<{ active: boolean; name: string }> {
    const h   = new Date().getUTCHours();
    const day = new Date().getUTCDay(); // 0=Sun, 6=Sat
    const mode = await this.appConfig.getActiveModeConfig();

    if (mode.extendedHours) {
      // Weekends always blocked (non-crypto markets closed regardless of mode)
      if (day === 0 || day === 6) return { active: false, name: 'None' };

      // Quick Scalp — all weekday hours (00:00–23:59 UTC), catches Asian + European + US
      if (mode.htfTf === 'H1') return { active: true, name: 'All-day scalp' };

      // Precision Scalp — extended window: Mon–Fri 06:00–20:00 UTC
      if (h >= 6 && h < 20) return { active: true, name: 'Extended (06–20 UTC)' };
      return { active: false, name: 'None' };
    }

    // Institutional — strict London + NY killzones from SymbolRegistry
    const sym     = this.activeSymbol.getSymbol();
    const session = getActiveSession(sym, h);
    return session
      ? { active: true,  name: session }
      : { active: false, name: 'None'  };
  }

  /**
   * True if the active symbol's underlying market is fundamentally closed
   * for the weekend (forex/metals/indices/commodities all close). Crypto
   * (category: 'crypto', e.g. BTCUSD) trades 24/7 and is exempt.
   *
   * This is a HARD block — unlike the killzone hour gate, it is never
   * bypassed by forceRun, because no human approval can make a genuinely
   * closed market accept an order. Without this, the bot would still send
   * Telegram approval requests on Sat/Sun for symbols that simply cannot
   * execute, and then immediately follow up with a MARKET_CLOSED error.
   */
  private isWeekendMarketClosed(): boolean {
    const cfg = this.activeSymbol.getConfig();
    if (cfg?.category === 'crypto') return false; // BTCUSD etc. trade 24/7

    const now  = new Date();
    const day  = now.getUTCDay();   // 0 = Sunday, 6 = Saturday
    const hour = now.getUTCHours();

    // Market closes Friday ~21:00 UTC, reopens Sunday ~21:00-22:00 UTC.
    // Treat all of Saturday and Sunday-before-reopen as closed.
    if (day === 6) return true;
    if (day === 0 && hour < 21) return true;
    return false;
  }

  async onApplicationBootstrap(): Promise<void> {
    const alive = await this.mt5.ping();
    if (!alive) {
      this.logger.warn('MetaApi unreachable — account may still be deploying, retrying on first cycle');
      await this.telegram.sendMessage(
        '⚠️ <b>KrishView started</b> — MetaApi not yet reachable.\n\n' +
        'Account may still be deploying. It will connect automatically in 1-2 minutes.',
      );
    } else {
      try {
        const account = await this.mt5.getAccount();
        this.logger.log(`MT5 connected — #${account.login}  $${account.balance}`);
        await this.telegram.notifyStartup(account);
      } catch (e: any) {
        this.logger.error(`Startup error: ${e.message}`);
      }
    }

    // SMC + AI cycle every 5 min
    setInterval(() => {
      this.runSMCCycle().catch(e =>
        this.logger.error(`SMC cycle error: ${e.message}`),
      );
    }, 5 * 60 * 1000);

    // Import historical closed deals from MT5 (one-time on startup)
    this.importMt5History().catch(e =>
      this.logger.error(`History import error: ${e.message}`),
    );

    // Sync any MT5 positions not yet in the journal (catches manually-opened trades)
    // Delay 15s on startup so it doesn't clash with the dashboard's initial polling burst
    setTimeout(() => {
      this.syncMt5Positions().catch(e =>
        this.logger.error(`Position sync error: ${e.message}`),
      );
    }, 15_000);

    // Open-trade monitor every 60 s (was 30 s — halved to avoid MetaApi 429 collisions)
    setInterval(() => {
      this.syncMt5Positions()
        .then(() => this.monitorOpenTrades())
        .catch(e => this.logger.error(`Monitor error: ${e.message}`));
    }, 60_000);

    // Daily report check every minute
    setInterval(() => {
      const utcHour = new Date().getUTCHours();
      if (utcHour === 22 && this.lastDailyReport !== utcHour) {
        this.lastDailyReport = utcHour;
        this.sendDailyReport().catch(e =>
          this.logger.error(`Daily report error: ${e.message}`),
        );
      }
    }, 60_000);
  }

  // ─── SMC + AI + Approval Cycle ────────────────────────────────────────────

  async runSMCCycle(): Promise<void> {
    try {
      await this.executeSMCCycle();
    } catch (e: any) {
      this.logger.error(`SMC cycle error: ${e.message}`);
    }
  }

  /**
   * Sprint 2 pipeline:
   *   1. Fetch candles
   *   2. AnalysisService.run() → SMC + FeatureEngine + GPT-4
   *   3. Risk check
   *   4. Send Telegram approval message with inline keyboard
   *   5. Wait for APPROVED / REJECTED / EXPIRED
   *   6. Execute trade if approved
   */
  /**
   * @param hintDirection  Optional direction hint from webhook (BUY/SELL).
   * @param forceRun       When true (manual dashboard trigger) the killzone gate
   *                       is skipped so analysis always runs on demand. Trade
   *                       execution still proceeds normally — the human approving
   *                       the trade is the final gate off-hours.
   */
  async executeSMCCycle(hintDirection?: 'BUY' | 'SELL', forceRun = false): Promise<void> {
    this.logger.log(`════ SMC Cycle START — ${this.symbol} ════`);

    // Weekend gate — hard block for non-crypto symbols, never bypassed.
    // Cheap, zero-dependency heuristic — always available even if MetaApi
    // is unreachable, so this stays as the first line of defense.
    if (this.isWeekendMarketClosed()) {
      this.logger.log(`SMC Cycle SKIPPED — ${this.symbol} market closed for the weekend`);
      return;
    }

    // Broker-verified market-open check — catches what the heuristic above
    // can't: holidays, maintenance windows, and whether THIS broker really
    // keeps crypto open on weekends (settles that with real data instead of
    // assuming). Fails open (returns true) if unreachable/uncached, so it
    // layers on top of the hardcoded gate rather than replacing it.
    if (!(await this.symbolSpec.isMarketOpen(this.symbol))) {
      this.logger.log(`SMC Cycle SKIPPED — ${this.symbol} market closed per broker's real trading schedule`);
      return;
    }

    // Killzone gate — only skip when automated timer fires outside session.
    // forceRun=true (manual trigger) bypasses this so the dashboard always works.
    const kz = await this.inKillzone();
    if (!kz.active && !this.skipKillzoneCheck && !forceRun) {
      const mode = await this.appConfig.getActiveModeConfig();
      const hint = mode.extendedHours
        ? 'Extended mode: waiting for 06:00 UTC'
        : `Next: London 07:00 or NY 13:00`;
      this.logger.log(`SMC Cycle SKIPPED — outside killzone (UTC hour: ${new Date().getUTCHours()}). ${hint}`);
      return;
    }
    if (kz.active) {
      this.logger.log(`✅ Killzone active: ${kz.name} session`);
    } else if (forceRun) {
      this.logger.log(`⚠️ Off-hours — killzone gate bypassed by manual trigger`);
    } else {
      this.logger.log(`⚠️ Killzone check bypassed (SKIP_KILLZONE_CHECK=true) — running outside session`);
    }

    // 1. Candles — fetch 5 layers for the active trading mode.
    //    INSTITUTIONAL: D1 → H4 → H1 → M15 → M5
    //    PRECISION:     H4 → H1 → M15 → M5 → M1
    //    Sequential with 300ms gaps to avoid simultaneous MetaApi historyClient calls → 429
    const mode   = await this.appConfig.getActiveModeConfig();
    const tfDelay = (ms: number) => new Promise(r => setTimeout(r, ms));
    this.logger.log(`[1/6] Mode: ${mode.label} (${mode.htfTf}→${mode.h4Tf}→${mode.confirmTf}→${mode.setupTf}→${mode.entryTf})`);

    const htfCandles     = await this.mt5.getCandles(mode.htfTf,     200, this.symbol);
    await tfDelay(300);
    const h4Candles      = await this.mt5.getCandles(mode.h4Tf,      200, this.symbol);
    await tfDelay(300);
    const confirmCandles = await this.mt5.getCandles(mode.confirmTf, 200, this.symbol);
    await tfDelay(300);
    const setupCandles   = await this.mt5.getCandles(mode.setupTf,   200, this.symbol);
    await tfDelay(300);
    const entryCandles   = await this.mt5.getCandles(mode.entryTf,   200, this.symbol);

    this.logger.log(
      `[1/6] Candles: L1=${htfCandles?.length ?? 0} L2=${h4Candles?.length ?? 0} ` +
      `L3=${confirmCandles?.length ?? 0} L4=${setupCandles?.length ?? 0} L5=${entryCandles?.length ?? 0}`,
    );

    if (!htfCandles?.length || !h4Candles?.length || !confirmCandles?.length || !setupCandles?.length || !entryCandles?.length) {
      this.logger.warn('[1/6] BLOCKED: one or more timeframes returned empty — MetaApi account may still be deploying');
      return;
    }

    // 2. Full analysis (5-layer SMC + FeatureEngine + AI)
    this.logger.log(`[2/6] Running 5-layer analysis (${mode.htfTf}→${mode.h4Tf}→${mode.confirmTf}→${mode.setupTf}→${mode.entryTf} → FeatureEngine → AI)…`);
    const result = await this.analysis.run(
      htfCandles, h4Candles, confirmCandles, setupCandles, entryCandles,
      this.symbol,
      { minConfidence: mode.minConfidence, modeLabel: mode.label },
    );
    if (!result) {
      this.logger.warn('[2/6] BLOCKED: analysis.run() returned null — SMC found no valid setup (check OB/FVG/zone logs above) or AI said WAIT');
      return;
    }
    this.logger.log(`[2/6] Analysis OK — analysisId=${result.analysisId}`);

    // Resolve final trade parameters (AI takes priority over raw SMC)
    const rec = result.recommendation;
    const smc = result.smcSignal;

    const direction = (rec?.decision ?? smc?.direction) as 'BUY' | 'SELL' | undefined;
    this.logger.log(`[3/6] Direction resolved: ${direction ?? 'null'} (AI=${rec?.decision ?? 'none'} SMC=${smc?.direction ?? 'none'})`);
    if (!direction || direction === 'WAIT' as any) {
      this.logger.warn('[3/6] BLOCKED: direction is null or WAIT');
      return;
    }

    if (hintDirection && direction !== hintDirection) {
      this.logger.log(`[3/6] BLOCKED: signal (${direction}) conflicts with hint (${hintDirection})`);
      return;
    }

    const entry   = rec?.entryPrice ?? smc?.entryPrice ?? 0;
    const sl      = rec?.stopLoss   ?? smc?.sl         ?? 0;
    const tp      = rec?.takeProfit ?? smc?.tp         ?? 0;
    const rr      = rec?.rr         ?? smc?.rr         ?? 0;
    const reasons = rec?.reasons    ?? smc?.reasons    ?? [];

    this.logger.log(`[3/6] Levels: entry=${entry} sl=${sl} tp=${tp} rr=${rr}`);

    // 2b. ML confidence blend (Sprint 4.3)
    const aiConfidence = rec?.confidence ?? smc?.confidence ?? 0;
    const mlPrediction = await this.ml.predict(result.features, direction);
    const confidence   = this.ml.blendConfidence(aiConfidence, mlPrediction);
    if (mlPrediction) {
      this.logger.log(
        `ML blend: AI=${aiConfidence}% × ML=${mlPrediction.mlConfidence}% → blended=${confidence}%`,
      );
    }

    // 2c. Explainability breakdown (Sprint 5 — Explainability Engine)
    const upcomingNews     = await this.news.getUpcoming(1);  // next 1 hour
    const minutesUntilNews = upcomingNews.length > 0
      ? Math.round((new Date(upcomingNews[0].date).getTime() - Date.now()) / 60_000)
      : undefined;
    const breakdown = this.explainer.explain(result.features, result.smcSignal, direction, minutesUntilNews);
    this.logger.log(
      `Explainability: total=${breakdown.total} ` +
      `[trend=${breakdown.trend.score} smc=${breakdown.smc.score} ` +
      `momentum=${breakdown.momentum.score} liquidity=${breakdown.liquidity.score} news=${breakdown.news.score}]`,
    );
    // Persist breakdown so dashboard + analytics can use it
    await this.analysis.saveBreakdown(result.analysisId, breakdown as any);

    if (!entry || !sl || !tp) {
      this.logger.warn(`[3/6] BLOCKED: price levels incomplete — entry=${entry} sl=${sl} tp=${tp}`);
      return;
    }

    // 3. Risk check — sequential to avoid concurrent MetaApi calls → 429
    this.logger.log('[4/6] Running risk checks…');
    const account       = await this.mt5.getAccount();
    const tick          = await this.mt5.getPrice(this.symbol);
    const openPositions = await this.mt5.getPositions(this.symbol);

    this.logger.log(`[4/6] Account: balance=${account.balance} equity=${account.equity} | spread=${tick.spread} | openPositions=${openPositions.length}`);

    // Build a signal-compatible object for RiskService
    const signalForRisk = {
      direction, entryPrice: entry, sl, tp, rr,
      confidence, reasons,
      ob: smc?.ob, fvg: smc?.fvg, sweep: smc?.sweep,
    };

    const check = await this.risk.riskCheck(
      signalForRisk as any, account, openPositions.length, tick.spread,
    );
    if (!check.ok) {
      this.logger.warn(`[4/6] BLOCKED by risk gate: ${check.reason}`);
      await this.telegram.notifySignalSkipped(check.reason);
      await this.analysis.updateStatus(result.analysisId, 'SKIPPED');
      return;
    }
    this.logger.log('[4/6] Risk checks passed ✅');

    // 4. Create approval record + send Telegram message
    this.logger.log('[5/6] Creating approval record…');
    const approvalRecord = await this.approval.create({
      analysisId: result.analysisId,
      symbol: this.symbol,
      direction, entry, sl, tp, rr, confidence,
    });

    await this.analysis.updateStatus(result.analysisId, 'AWAITING_APPROVAL');

    const msgId = await this.telegram.sendApprovalMessage({
      approvalId:  approvalRecord.id,
      analysisId:  result.analysisId,
      symbol:      this.symbol,
      direction, entry, sl, tp, rr, confidence,
      reasons,
      aiUsed: !!rec,
      breakdown,
      tradingTier:   result.confluence?.tradingTier,
      tierThreshold: result.confluence?.tierThreshold,
    });

    if (msgId) {
      await this.approval.setTelegramMsgId(approvalRecord.id, msgId, this.config.get('TELEGRAM_CHAT_ID', ''));
    }

    this.logger.log(`[5/6] Approval #${approvalRecord.id} created — waiting for dashboard/Telegram decision (timeout=${this.config.get('APPROVAL_TIMEOUT_MINUTES', '5')}m)…`);

    // 5. Wait for human decision
    const decision = await this.approval.waitForDecision(approvalRecord.id);
    this.logger.log(`[5/6] Approval #${approvalRecord.id} → ${decision}`);

    if (decision !== 'APPROVED') {
      await this.analysis.updateStatus(result.analysisId,
        decision === 'REJECTED' ? 'REJECTED' : 'EXPIRED',
      );
      return;
    }

    // 6. Execute trade
    this.logger.log('[6/6] APPROVED — placing order in MT5…');
    await this.analysis.updateStatus(result.analysisId, 'APPROVED');

    const lots = await this.risk.calcLotSize(account.balance, entry, sl);
    let orderResult: { ticket: number; price: number };

    try {
      orderResult = await this.mt5.placeOrder({
        direction,
        lots,
        sl,
        tp,
        comment: `KV-${confidence}%${rec ? '-AI' : '-SMC'}`,
      });
    } catch (e: any) {
      const detail = e?.response?.data?.error ?? e.message;
      this.logger.error(`Order failed: ${detail}`);
      await this.telegram.notifyError(`Order failed: ${detail}`);
      return;
    }

    await this.journal.logEntry({
      ticket:     orderResult.ticket,
      symbol:     this.symbol,
      direction,
      lots,
      signal:     signalForRisk as any,
      lastAtr:    result.features.momentum.atr,
      analysisId: result.analysisId,
    });

    await this.telegram.notifyEntry(signalForRisk as any, orderResult.ticket, lots, this.symbol);
    this.logger.log(`✅ Trade #${orderResult.ticket} ${direction} ${lots} @ ${orderResult.price}`);
  }

  // ─── Reconcile Trades with Missing PnL ───────────────────────────────────

  /**
   * Re-queries MT5 deal history for any CLOSED trades that have exitPrice=0
   * (caused by bridge timeout at time of close). Called from POST /dashboard/reconcile.
   * Works with the existing /trade_history bridge endpoint — no EA recompile needed.
   */
  async reconcileZeroPnl(): Promise<{ fixed: number; failed: number }> {
    const badTrades = await this.journal.getClosedWithZeroExit();
    let fixed = 0;
    let failed = 0;

    for (const trade of badTrades) {
      this.logger.log(`Reconciling #${trade.ticket}...`);
      const deal = await this.mt5.getClosedDealPnL(trade.ticket);

      if (deal && deal.exitPrice > 0) {
        const closeReason = deal.pnl > 0 ? 'TP_HIT' : deal.pnl < 0 ? 'SL_HIT' : 'CLOSED';
        await this.journal.logExit({
          ticket:      trade.ticket,
          exitPrice:   deal.exitPrice,
          pnl:         deal.pnl,
          closeReason,
        });
        this.logger.log(`#${trade.ticket}: pnl=${deal.pnl} exit=${deal.exitPrice} ✓`);
        fixed++;
      } else {
        this.logger.warn(`#${trade.ticket}: deal still not found in MT5 history`);
        failed++;
      }
    }

    return { fixed, failed };
  }

  // ─── Import MT5 Closed Deal History ──────────────────────────────────────

  async importMt5History(): Promise<void> {
    try {
      const deals = await this.mt5.getAllClosedDeals();
      let imported = 0;
      for (const deal of deals) {
        await this.journal.importClosedDeal({
          ticket:    deal.ticket,
          symbol:    deal.symbol || this.symbol,
          direction: deal.type,
          lots:      deal.lots,
          entryPrice: deal.entryPrice ?? deal.exitPrice,
          exitPrice: deal.exitPrice,
          pnl:       deal.pnl,
          exitTime:  deal.exitTime,
        });
        imported++;
      }
      if (imported > 0) {
        this.logger.log(`Imported ${imported} historical deals from MT5`);
      }
    } catch (e: any) {
      this.logger.warn(`importMt5History failed: ${e.message}`);
    }
  }

  // ─── Sync MT5 Positions → Journal ────────────────────────────────────────

  /**
   * Import any open MT5 positions that aren't yet in the journal.
   * This handles trades opened manually in MT5 or before the bot started.
   */
  async syncMt5Positions(): Promise<void> {
    try {
      const positions = await this.mt5.getPositions(this.symbol);
      for (const pos of positions) {
        const known = await this.journal.hasTicket(pos.ticket);
        if (!known) {
          await this.journal.logManualEntry({
            ticket:     pos.ticket,
            symbol:     pos.symbol,
            direction:  pos.type,
            lots:       pos.lots,
            entryPrice: pos.open_price,
            sl:         pos.sl ?? 0,
            tp:         pos.tp ?? 0,
          });
          this.logger.log(`Synced manual MT5 position #${pos.ticket} ${pos.type} @ ${pos.open_price}`);
        }
      }
    } catch (e: any) {
      this.logger.warn(`syncMt5Positions failed: ${e.message}`);
    }
  }

  // ─── Monitor Open Trades ──────────────────────────────────────────────────

  async monitorOpenTrades(): Promise<void> {
    const openJournal = await this.journal.getOpenTrades();
    if (!openJournal.length) return;

    const openBroker  = await this.mt5.getPositions(this.symbol);
    const brokerMap   = new Map(openBroker.map(p => [p.ticket, p]));

    // Fetch price ONCE for the whole loop — avoids N calls per N open trades every 60s
    const sharedTick = await this.mt5.getPrice(this.symbol).catch(() => null);

    for (const trade of openJournal) {
      const brokerPos = brokerMap.get(trade.ticket);

      if (!brokerPos) {
        // ── Position closed at broker — record actual P&L ────────────────
        const deal = await this.mt5.getClosedDealPnL(trade.ticket);

        if (!deal || deal.exitPrice === 0) {
          // Deal not yet in MT5 history — retry next cycle
          const attempts = (this.reconcileRetries.get(trade.ticket) ?? 0) + 1;
          this.reconcileRetries.set(trade.ticket, attempts);

          if (attempts < this.MAX_RECONCILE_RETRIES) {
            this.logger.warn(
              `PnL not available for #${trade.ticket} (attempt ${attempts}/${this.MAX_RECONCILE_RETRIES}) — will retry`,
            );
            continue;   // leave as OPEN; retry next 30s cycle
          }

          // After MAX retries, give up and close with whatever data we have
          this.logger.error(
            `Could not fetch PnL for #${trade.ticket} after ${attempts} attempts — closing with $0`,
          );
        }

        const pnl         = deal?.pnl       ?? 0;
        const exitPrice   = deal?.exitPrice  ?? 0;
        const closeReason = pnl > 0 ? 'TP_HIT' : pnl < 0 ? 'SL_HIT' : 'CLOSED';

        this.reconcileRetries.delete(trade.ticket);
        await this.journal.logExit({ ticket: trade.ticket, exitPrice, pnl, closeReason });
        await this.telegram.notifyExit(trade.ticket, trade.direction, exitPrice, pnl, closeReason);
        continue;
      }

      // ── Max Hold Time auto-close (doc §15.2) ─────────────────────────────
      const maxHoldHours = parseInt(this.config.get('MAX_HOLD_HOURS', '24'), 10);
      const openTime = trade.openTime ? new Date(trade.openTime) : null;
      if (openTime && (Date.now() - openTime.getTime()) > maxHoldHours * 3_600_000) {
        try {
          const tick = sharedTick ?? await this.mt5.getPrice(this.symbol);
          const exitPrice = trade.direction === 'BUY' ? tick.bid : tick.ask;
          await this.mt5.closePosition(trade.ticket);
          const pnl = (trade.direction === 'BUY'
            ? exitPrice - Number(trade.entryPrice)
            : Number(trade.entryPrice) - exitPrice) * Number(trade.lots) * 100;
          await this.journal.logExit({ ticket: trade.ticket, exitPrice, pnl: +pnl.toFixed(2), closeReason: 'MAX_HOLD_TIME' });
          await this.telegram.sendMessage(
            `⏰ <b>Max Hold Time Reached</b> — #${trade.ticket}\n` +
            `${trade.direction} ${trade.lots} lots @ ${trade.entryPrice}\n` +
            `Auto-closed at ${exitPrice} after ${maxHoldHours}h\n` +
            `P&L: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`,
          );
          this.logger.warn(`Max hold time exceeded — auto-closed #${trade.ticket}`);
        } catch (e: any) {
          this.logger.error(`Max hold time close failed #${trade.ticket}: ${e.message}`);
        }
        continue;
      }

      // ── Active SL Management for open positions (Sprint 3.2) ─────────────
      await this.manageOpenPosition(trade, brokerPos, sharedTick);
    }
  }

  /**
   * Sprint 3.2 — Trailing Stop + Break-Even + Partial TP
   * Called on every 30s monitor tick for each open trade.
   */
  private async manageOpenPosition(
    trade: any,
    brokerPos: any,
    sharedTick?: { bid: number; ask: number } | null,
  ): Promise<void> {
    // Reuse shared tick fetched once per monitor cycle — avoids N getPrice() calls per N trades
    const tick    = sharedTick ?? await this.mt5.getPrice(this.symbol);
    const price   = trade.direction === 'BUY' ? tick.bid : tick.ask;
    const atr     = Number(trade.lastAtr) || 5; // fallback 5 pts if not stored
    const entry   = Number(trade.entryPrice);
    const currentSl = Number(trade.currentSl ?? trade.sl);
    const tp      = Number(trade.tp);

    // How far price has moved in our favour (positive = good)
    const moved = trade.direction === 'BUY'
      ? price - entry
      : entry - price;

    // ── Partial TP at 1:1 RR (50% close) ────────────────────────────────────
    if (!trade.partialTpHit && moved >= atr) {
      try {
        const closeLots = Math.max(0.01, Math.round(Number(trade.lots) * 0.5 * 100) / 100);
        await this.mt5.partialClose(trade.ticket, closeLots);
        await this.journal.markPartialTp(trade.ticket);
        await this.telegram.sendMessage(
          `🎯 <b>Partial TP</b> — #${trade.ticket}\n` +
          `Closed ${closeLots} lots at ${price} (1:1 RR reached)\n` +
          `Remaining position still running.`,
        );
        this.logger.log(`Partial TP taken on #${trade.ticket} at ${price}`);
      } catch (e: any) {
        this.logger.warn(`Partial TP failed #${trade.ticket}: ${e.message}`);
      }
    }

    // ── Break-Even after 1× ATR ──────────────────────────────────────────────
    const beSl = trade.direction === 'BUY'
      ? entry + 0.1     // 0.1pt above entry for BUY
      : entry - 0.1;    // 0.1pt below entry for SELL

    const atBreakEven = trade.direction === 'BUY'
      ? currentSl >= beSl
      : currentSl <= beSl;

    if (!atBreakEven && moved >= atr) {
      try {
        await this.mt5.modifyPosition(trade.ticket, beSl, tp);
        await this.journal.updateSl(trade.ticket, beSl);
        await this.telegram.sendMessage(
          `🛡 <b>Break-Even</b> — #${trade.ticket}\n` +
          `SL moved to ${beSl.toFixed(2)} (entry)\n` +
          `Trade is now risk-free.`,
        );
        this.logger.log(`Break-even set on #${trade.ticket}: SL → ${beSl}`);
        return; // don't trail same candle
      } catch (e: any) {
        this.logger.warn(`Break-even failed #${trade.ticket}: ${e.message}`);
      }
    }

    // ── Trailing Stop after 2× ATR ───────────────────────────────────────────
    if (moved >= 2 * atr) {
      const newSl = trade.direction === 'BUY'
        ? price - atr          // trail 1 ATR below current price
        : price + atr;         // trail 1 ATR above current price

      const slImproved = trade.direction === 'BUY'
        ? newSl > currentSl
        : newSl < currentSl;

      if (slImproved) {
        try {
          await this.mt5.modifyPosition(trade.ticket, newSl, tp);
          await this.journal.updateSl(trade.ticket, newSl);
          this.logger.log(
            `Trailing stop #${trade.ticket}: SL ${currentSl.toFixed(2)} → ${newSl.toFixed(2)}`,
          );
        } catch (e: any) {
          this.logger.warn(`Trail failed #${trade.ticket}: ${e.message}`);
        }
      }
    }
  }

  // ─── Daily Report ─────────────────────────────────────────────────────────

  async sendDailyReport(): Promise<void> {
    const [stats, account] = await Promise.all([
      this.journal.getDailyStats(),
      this.mt5.getAccount(),
    ]);
    await this.telegram.notifyDailyReport(stats, account.balance);
  }

  // ─── TradingView Webhook Handler ──────────────────────────────────────────

  async handleWebhookAlert(alert: {
    symbol: string;
    action: 'BUY' | 'SELL' | 'CLOSE_ALL';
    timeframe: string;
    price: number;
    reason?: string;
  }): Promise<void> {
    this.logger.log(`Webhook: ${alert.action} ${alert.symbol} @ ${alert.price}`);

    if (alert.action === 'CLOSE_ALL') {
      const positions = await this.mt5.getPositions(this.symbol);
      for (const pos of positions) {
        await this.mt5.closePosition(pos.ticket);
        await this.telegram.sendMessage(
          `🔔 <b>Alert: Close All</b>\nClosed #${pos.ticket} via TradingView alert`,
        );
      }
      return;
    }

    await this.executeSMCCycle(alert.action);
  }
}
