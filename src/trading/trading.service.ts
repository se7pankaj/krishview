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

@Injectable()
export class TradingService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TradingService.name);
  private readonly symbol: string;
  private readonly htfTf: string;
  private readonly entryTf: string;
  private lastDailyReport = -1;

  constructor(
    private readonly config:    ConfigService,
    private readonly smc:       SmcService,
    private readonly risk:      RiskService,
    private readonly mt5:       Mt5Service,
    private readonly journal:   JournalService,
    private readonly telegram:  TelegramService,
    private readonly analysis:  AnalysisService,
    private readonly approval:  ApprovalService,
    private readonly ml:        MlService,
    private readonly explainer: ConfidenceExplainerService,
    private readonly news:      NewsService,
  ) {
    this.symbol  = this.config.get<string>('SYMBOL', 'XAUUSD');
    this.htfTf   = this.config.get<string>('HTF_TF', 'H4');
    this.entryTf = this.config.get<string>('ENTRY_TF', 'M15');
  }

  async onApplicationBootstrap(): Promise<void> {
    const alive = await this.mt5.ping();
    if (!alive) {
      this.logger.warn('MT5 bridge offline — start bridge.py on Windows machine');
      await this.telegram.sendMessage(
        '⚠️ <b>KrishView started</b> — MT5 bridge is offline.\n\n' +
        'Run <code>python mt5_bridge/bridge.py</code> on your Windows machine.',
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

    // Open-trade monitor every 30 s
    setInterval(() => {
      this.monitorOpenTrades().catch(e =>
        this.logger.error(`Monitor error: ${e.message}`),
      );
    }, 30_000);

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
  async executeSMCCycle(hintDirection?: 'BUY' | 'SELL'): Promise<void> {
    this.logger.log(`SMC Cycle starting — ${this.symbol}`);

    // 1. Candles
    const [htfCandles, ltfCandles] = await Promise.all([
      this.mt5.getCandles(this.htfTf, 200, this.symbol),
      this.mt5.getCandles(this.entryTf, 150, this.symbol),
    ]);

    if (!htfCandles?.length || !ltfCandles?.length) {
      this.logger.warn('SMC Cycle: no candle data from bridge');
      return;
    }

    // 2. Full analysis (SMC + FeatureEngine + AI)
    const result = await this.analysis.run(htfCandles, ltfCandles, this.symbol);
    if (!result) {
      this.logger.log('SMC Cycle: no actionable signal');
      return;
    }

    // Resolve final trade parameters (AI takes priority over raw SMC)
    const rec = result.recommendation;
    const smc = result.smcSignal;

    const direction = (rec?.decision ?? smc?.direction) as 'BUY' | 'SELL' | undefined;
    if (!direction || direction === 'WAIT' as any) return;

    if (hintDirection && direction !== hintDirection) {
      this.logger.log(`Signal (${direction}) conflicts with hint (${hintDirection}) — skip`);
      return;
    }

    const entry   = rec?.entryPrice ?? smc?.entryPrice ?? 0;
    const sl      = rec?.stopLoss   ?? smc?.sl         ?? 0;
    const tp      = rec?.takeProfit ?? smc?.tp         ?? 0;
    const rr      = rec?.rr         ?? smc?.rr         ?? 0;
    const reasons = rec?.reasons    ?? smc?.reasons    ?? [];

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
      this.logger.warn('SMC Cycle: incomplete price levels — skip');
      return;
    }

    // 3. Risk check
    const [account, tick, openPositions] = await Promise.all([
      this.mt5.getAccount(),
      this.mt5.getPrice(this.symbol),
      this.mt5.getPositions(this.symbol),
    ]);

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
      this.logger.log(`Risk gate blocked: ${check.reason}`);
      await this.telegram.notifySignalSkipped(check.reason);
      await this.analysis.updateStatus(result.analysisId, 'SKIPPED');
      return;
    }

    // 4. Create approval record + send Telegram message
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
    });

    if (msgId) {
      await this.approval.setTelegramMsgId(approvalRecord.id, msgId, this.config.get('TELEGRAM_CHAT_ID', ''));
    }

    // 5. Wait for human decision
    this.logger.log(`Waiting for Telegram approval #${approvalRecord.id}...`);
    const decision = await this.approval.waitForDecision(approvalRecord.id);
    this.logger.log(`Approval #${approvalRecord.id} → ${decision}`);

    if (decision !== 'APPROVED') {
      await this.analysis.updateStatus(result.analysisId,
        decision === 'REJECTED' ? 'REJECTED' : 'EXPIRED',
      );
      return;
    }

    // 6. Execute trade
    await this.analysis.updateStatus(result.analysisId, 'APPROVED');

    const lots = this.risk.calcLotSize(account.balance, entry, sl);
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
      this.logger.error(`Order failed: ${e.message}`);
      await this.telegram.notifyError(`Order failed: ${e.message}`);
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

  // ─── Monitor Open Trades ──────────────────────────────────────────────────

  async monitorOpenTrades(): Promise<void> {
    const openJournal = await this.journal.getOpenTrades();
    if (!openJournal.length) return;

    const openBroker  = await this.mt5.getPositions(this.symbol);
    const brokerMap   = new Map(openBroker.map(p => [p.ticket, p]));

    for (const trade of openJournal) {
      const brokerPos = brokerMap.get(trade.ticket);

      if (!brokerPos) {
        // ── Position closed at broker — record actual P&L (Sprint 3.1) ────
        const deal = await this.mt5.getClosedDealPnL(trade.ticket);
        const pnl       = deal?.pnl       ?? 0;
        const exitPrice = deal?.exitPrice  ?? 0;
        const closeReason = pnl >= 0 ? 'TP_HIT' : 'SL_HIT';

        await this.journal.logExit({ ticket: trade.ticket, exitPrice, pnl, closeReason });
        await this.telegram.notifyExit(trade.ticket, trade.direction, exitPrice, pnl, closeReason);
        continue;
      }

      // ── Active SL Management for open positions (Sprint 3.2) ─────────────
      await this.manageOpenPosition(trade, brokerPos);
    }
  }

  /**
   * Sprint 3.2 — Trailing Stop + Break-Even + Partial TP
   * Called on every 30s monitor tick for each open trade.
   */
  private async manageOpenPosition(
    trade: any,
    brokerPos: any,
  ): Promise<void> {
    const tick    = await this.mt5.getPrice(this.symbol);
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
