/**
 * risk/risk.service.ts — Risk Management Engine
 * ===============================================
 * NestJS port of riskManager.js.
 * Handles: session filter, lot sizing, daily loss circuit-breaker,
 *          spread check, RR filter, trailing stop, partial TP levels.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JournalService } from '../journal/journal.service';
import { NewsService } from '../news/news.service';
import { SMCSignal } from '../smc/smc.service';
import { TelegramService } from '../telegram.service';
import { ActiveSymbolService } from '../trading/active-symbol.service';
import { getActiveSession } from '../common/symbol-registry';

export interface RiskCheckResult {
  ok: boolean;
  reason: string;
}

export interface PartialTP {
  price: number;
  pct: number;
}

@Injectable()
export class RiskService {
  private readonly logger = new Logger(RiskService.name);

  /**
   * Circuit breaker suspend state (doc §16.2, §16.3).
   * When set, all new signals are blocked until this timestamp.
   * Persisted in-memory only — resets on server restart (intentional for safety).
   */
  private suspendedUntil: Date | null = null;

  constructor(
    private readonly config:        ConfigService,
    private readonly journal:       JournalService,
    private readonly news:          NewsService,
    private readonly telegram:      TelegramService,
    private readonly activeSymbol:  ActiveSymbolService,
  ) {}

  private get riskPct():         number { return parseFloat(this.config.get('RISK_PCT', '1')); }
  private get maxDailyLoss():    number { return parseFloat(this.config.get('MAX_DAILY_LOSS_PCT', '3')); }
  private get maxTrades():       number { return parseInt(this.config.get('MAX_TRADES', '3'), 10); }
  private get minRR():           number { return parseFloat(this.config.get('MIN_RR', '2')); }
  private get confidenceMin():   number { return parseFloat(this.config.get('CONFIDENCE_THRESHOLD', '60')); }
  private get maxConsecLosses(): number { return parseInt(this.config.get('MAX_CONSEC_LOSSES', '3'), 10); }
  private get consecPausHours(): number { return parseInt(this.config.get('CONSEC_PAUSE_HOURS', '24'), 10); }

  /** Spread limit from SymbolRegistry; env SPREAD_LIMIT is the global fallback */
  private get spreadLimit(): number {
    return this.activeSymbol.getConfig()?.spreadLimit
      ?? parseInt(this.config.get('SPREAD_LIMIT', '200'), 10);
  }

  /** Set SKIP_SESSION_FILTER=true in .env to allow trading at any hour (testing only) */
  private get skipSessionFilter(): boolean {
    return this.config.get<string>('SKIP_SESSION_FILTER', 'false') === 'true';
  }

  /**
   * Is the current UTC time within any active session for the selected symbol?
   * Sessions are read from SymbolRegistry — no hardcoded London/NY hours.
   */
  isAllowedSession(): boolean {
    if (this.skipSessionFilter) {
      this.logger.warn('Risk: SKIP_SESSION_FILTER=true — session check bypassed (testing mode)');
      return true;
    }

    const now    = new Date();
    const gmtH   = now.getUTCHours();
    const day    = now.getUTCDay(); // 0=Sun, 6=Sat
    const sym    = this.activeSymbol.getSymbol();
    const symCfg = this.activeSymbol.getConfig();

    // Forex/metals/indices/commodities close for the weekend. Crypto
    // (category: 'crypto', e.g. BTCUSD) trades 24/7 and is exempt — mirrors
    // the hard weekend gate in TradingService.isWeekendMarketClosed().
    if (symCfg?.category !== 'crypto' && (day === 0 || day === 6)) {
      this.logger.log('Risk: Weekend — session closed');
      return false;
    }

    const session = getActiveSession(sym, gmtH);

    if (!session) {
      const symCfg  = this.activeSymbol.getConfig();
      const windows = symCfg?.sessions.map(s => `${s.name} ${s.startUtc}–${s.endUtc} UTC`).join(', ') ?? 'none';
      this.logger.log(`Risk: Outside ${sym} sessions (GMT ${gmtH}:xx) — valid windows: ${windows}`);
      return false;
    }

    return true;
  }

  /**
   * Calculate lot size using fixed fractional method.
   * Uses pipSize + pipValuePerLot from SymbolRegistry — works for any pair.
   *
   *   slPips   = |entryPrice − sl| / pipSize
   *   lotSize  = riskUSD / (slPips × pipValuePerLot)
   *
   * @param balance    Account balance in USD
   * @param entryPrice Entry price
   * @param sl         Stop-loss price
   */
  calcLotSize(balance: number, entryPrice: number, sl: number): number {
    const symCfg        = this.activeSymbol.getConfig();
    const pipSize       = symCfg?.pipSize       ?? 0.01; // fallback: gold pip
    const pipValPerLot  = symCfg?.pipValuePerLot ?? 1.0; // fallback: gold pip value

    const riskUSD = balance * (this.riskPct / 100);
    const slPips  = Math.abs(entryPrice - sl) / pipSize;
    const lotSize = riskUSD / (slPips * pipValPerLot);
    const rounded = Math.max(0.01, Math.round(lotSize * 100) / 100);

    this.logger.log(
      `Risk: ${this.activeSymbol.getSymbol()} Balance=$${balance} Risk=${this.riskPct}% → $${riskUSD.toFixed(2)} ` +
      `SLpips=${slPips.toFixed(1)} pipVal=$${pipValPerLot} → Lots=${rounded}`,
    );
    return rounded;
  }

  /** Full pre-trade risk gate (doc §16.1, §16.2) */
  async riskCheck(
    signal: SMCSignal,
    account: { balance: number; equity: number },
    openTradeCount: number,
    spread: number,
  ): Promise<RiskCheckResult> {
    // 0. Circuit breaker suspension (consecutive losses or daily loss — doc §16.2, §16.3)
    if (this.suspendedUntil && new Date() < this.suspendedUntil) {
      const remaining = Math.ceil((this.suspendedUntil.getTime() - Date.now()) / 60_000);
      return { ok: false, reason: `Trading suspended — circuit breaker active (${remaining} min remaining)` };
    } else if (this.suspendedUntil) {
      this.suspendedUntil = null; // suspension expired
      this.logger.log('Risk: Circuit breaker suspension lifted — trading resumed');
      await this.telegram.sendMessage('✅ <b>Circuit Breaker Lifted</b>\n\nTrading has automatically resumed. Monitor closely.');
    }

    // 1. Session
    if (!this.isAllowedSession()) {
      return { ok: false, reason: 'Outside allowed trading sessions' };
    }

    // 1b. News window (Sprint 3.3)
    const newsCheck = await this.news.isNewsWindow();
    if (newsCheck.blocked) {
      return { ok: false, reason: newsCheck.reason };
    }

    // 2. Max trades
    if (openTradeCount >= this.maxTrades) {
      return { ok: false, reason: `Max open trades reached (${this.maxTrades})` };
    }

    // 3. Spread
    if (spread > this.spreadLimit) {
      return { ok: false, reason: `Spread too wide: ${spread} > ${this.spreadLimit} pts` };
    }

    // 4. RR ratio
    if (signal.rr < this.minRR) {
      return { ok: false, reason: `RR too low: ${signal.rr} < ${this.minRR}` };
    }

    // 5. Daily loss circuit breaker (doc §16.3)
    const dailyPnL = await this.journal.getDailyPnL();
    const lossPct  = Math.abs(Math.min(0, dailyPnL)) / account.balance * 100;
    if (lossPct >= this.maxDailyLoss) {
      await this.suspendTrading(
        `Daily loss limit hit: ${lossPct.toFixed(2)}% ≥ ${this.maxDailyLoss}%`,
        '🔴 <b>Daily Loss Limit Hit</b>\n\nLoss: ' + lossPct.toFixed(2) + `% of account balance.\nTrading suspended until tomorrow 09:00 UTC.\n\nStay disciplined. Tomorrow is a new day.`,
        'tomorrow',
      );
      return { ok: false, reason: `Daily loss limit hit: ${lossPct.toFixed(2)}% ≥ ${this.maxDailyLoss}%` };
    }

    // 6. Consecutive loss circuit breaker (doc §16.2)
    const consecLosses = await this.journal.getConsecutiveLosses();
    if (consecLosses >= this.maxConsecLosses) {
      const pauseHours = this.consecPausHours;
      await this.suspendTrading(
        `${consecLosses} consecutive losses — pausing ${pauseHours}h`,
        `⚠️ <b>Consecutive Loss Limit</b>\n\n${consecLosses} losses in a row.\nTrading paused for ${pauseHours} hours.\n\nReview your setup before resuming.`,
        `${pauseHours}h`,
      );
      return { ok: false, reason: `${consecLosses} consecutive losses — paused ${pauseHours}h` };
    }

    // 7. Confidence
    if (signal.confidence < this.confidenceMin) {
      return { ok: false, reason: `Confidence too low: ${signal.confidence}% < ${this.confidenceMin}%` };
    }

    this.logger.log(
      `Risk: All checks passed ✅ | RR:${signal.rr} Spread:${spread} DailyLoss:${lossPct.toFixed(2)}% ConsecLosses:${consecLosses}`,
    );
    return { ok: true, reason: 'OK' };
  }

  /**
   * Suspend trading for a duration and send Telegram alert (doc §16.3).
   * @param logReason  Console log message
   * @param tgMessage  Telegram HTML message
   * @param duration   'tomorrow' (next 09:00 UTC) or '24h' / '4h' etc.
   */
  private async suspendTrading(logReason: string, tgMessage: string, duration: string): Promise<void> {
    if (duration === 'tomorrow') {
      const resume = new Date();
      resume.setUTCDate(resume.getUTCDate() + 1);
      resume.setUTCHours(9, 0, 0, 0);
      this.suspendedUntil = resume;
    } else {
      const hours = parseInt(duration, 10) || 24;
      this.suspendedUntil = new Date(Date.now() + hours * 3_600_000);
    }

    this.logger.warn(`Risk: SUSPENDED — ${logReason}`);
    try {
      await this.telegram.sendMessage(tgMessage);
    } catch { /* non-fatal */ }
  }

  /** Returns current suspension state — for dashboard/health checks */
  getSuspensionState(): { suspended: boolean; until: string | null } {
    if (this.suspendedUntil && new Date() < this.suspendedUntil) {
      return { suspended: true, until: this.suspendedUntil.toISOString() };
    }
    return { suspended: false, until: null };
  }

  /** ATR-based trailing stop — only moves in the profitable direction */
  calcTrailingStop(
    direction: 'BUY' | 'SELL',
    entryPrice: number,
    currentPrice: number,
    currentSL: number,
    atr: number,
    multiplier = 1.5,
  ): number {
    const trail = atr * multiplier;
    if (direction === 'BUY') {
      const newSL = +(currentPrice - trail).toFixed(2);
      return newSL > currentSL ? newSL : currentSL;
    } else {
      const newSL = +(currentPrice + trail).toFixed(2);
      return newSL < currentSL ? newSL : currentSL;
    }
  }

  /** 25% at 1R, 50% at 2R, 25% at 3R */
  partialTPLevels(direction: 'BUY' | 'SELL', entry: number, sl: number): PartialTP[] {
    const risk = Math.abs(entry - sl);
    if (direction === 'BUY') {
      return [
        { price: +(entry + risk * 1).toFixed(2), pct: 25 },
        { price: +(entry + risk * 2).toFixed(2), pct: 50 },
        { price: +(entry + risk * 3).toFixed(2), pct: 25 },
      ];
    }
    return [
      { price: +(entry - risk * 1).toFixed(2), pct: 25 },
      { price: +(entry - risk * 2).toFixed(2), pct: 50 },
      { price: +(entry - risk * 3).toFixed(2), pct: 25 },
    ];
  }
}
