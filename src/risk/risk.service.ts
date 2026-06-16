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

// XAUUSD: 1 standard lot = 100 oz → $10/pip × 10 pts per price unit
const XAUUSD_PIP_VALUE_PER_LOT = 10;

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

  constructor(
    private readonly config:  ConfigService,
    private readonly journal: JournalService,
    private readonly news:    NewsService,
  ) {}

  private get riskPct():      number { return parseFloat(this.config.get('RISK_PCT', '1')); }
  private get maxDailyLoss(): number { return parseFloat(this.config.get('MAX_DAILY_LOSS_PCT', '3')); }
  private get maxTrades():    number { return parseInt(this.config.get('MAX_TRADES', '3'), 10); }
  private get minRR():        number { return parseFloat(this.config.get('MIN_RR', '2')); }
  private get spreadLimit():  number { return parseInt(this.config.get('SPREAD_LIMIT', '30'), 10); }
  private get confidenceMin():number { return parseFloat(this.config.get('CONFIDENCE_THRESHOLD', '60')); }
  private get londonStart():  number { return parseInt(this.config.get('LONDON_START', '7'), 10); }
  private get londonEnd():    number { return parseInt(this.config.get('LONDON_END', '16'), 10); }
  private get nyStart():      number { return parseInt(this.config.get('NY_START', '12'), 10); }
  private get nyEnd():        number { return parseInt(this.config.get('NY_END', '21'), 10); }

  /** Is the current UTC time within London or NY session? */
  isAllowedSession(): boolean {
    const now  = new Date();
    const gmtH = now.getUTCHours();
    const day  = now.getUTCDay(); // 0=Sun, 6=Sat

    if (day === 0 || day === 6) {
      this.logger.log('Risk: Weekend — session closed');
      return false;
    }

    const inLondon = gmtH >= this.londonStart && gmtH < this.londonEnd;
    const inNY     = gmtH >= this.nyStart      && gmtH < this.nyEnd;

    if (!inLondon && !inNY) {
      this.logger.log(`Risk: Outside trading sessions (GMT ${gmtH}:xx)`);
      return false;
    }
    return true;
  }

  /**
   * Calculate lot size using fixed fractional method.
   * @param balance    Account balance in USD
   * @param entryPrice Entry price
   * @param sl         Stop-loss price
   */
  calcLotSize(balance: number, entryPrice: number, sl: number): number {
    const riskUSD  = balance * (this.riskPct / 100);
    const slPoints = Math.abs(entryPrice - sl) * 10; // price pts to pips for XAUUSD
    const lotSize  = riskUSD / (slPoints * XAUUSD_PIP_VALUE_PER_LOT);
    const rounded  = Math.max(0.01, Math.round(lotSize * 100) / 100);

    this.logger.log(
      `Risk: Balance=$${balance} Risk=${this.riskPct}% → $${riskUSD.toFixed(2)} ` +
      `SLpts=${slPoints.toFixed(1)} → Lots=${rounded}`,
    );
    return rounded;
  }

  /** Full pre-trade risk gate */
  async riskCheck(
    signal: SMCSignal,
    account: { balance: number; equity: number },
    openTradeCount: number,
    spread: number,
  ): Promise<RiskCheckResult> {
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

    // 5. Daily loss circuit breaker
    const dailyPnL = await this.journal.getDailyPnL();
    const lossPct  = Math.abs(Math.min(0, dailyPnL)) / account.balance * 100;
    if (lossPct >= this.maxDailyLoss) {
      return {
        ok: false,
        reason: `Daily loss limit hit: ${lossPct.toFixed(2)}% ≥ ${this.maxDailyLoss}%`,
      };
    }

    // 6. Confidence
    if (signal.confidence < this.confidenceMin) {
      return { ok: false, reason: `Confidence too low: ${signal.confidence}% < ${this.confidenceMin}%` };
    }

    this.logger.log(
      `Risk: All checks passed ✅ | RR:${signal.rr} Spread:${spread} DailyLoss:${lossPct.toFixed(2)}%`,
    );
    return { ok: true, reason: 'OK' };
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
