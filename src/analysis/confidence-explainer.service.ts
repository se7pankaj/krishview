/**
 * analysis/confidence-explainer.service.ts — Confidence Explainability Engine
 * =============================================================================
 * Breaks down the trade confidence score into 5 human-readable components:
 *
 *   Trend     +25 / 25   EMA stack aligned, HTF BULLISH
 *   SMC       +24 / 25   OB + FVG + BOS confirmed
 *   Momentum  +18 / 20   RSI oversold, healthy ATR
 *   Liquidity +20 / 20   Liquidity sweep + Discount zone
 *   News       -5 /  5   High-impact event in 22 min
 *   ─────────────────────
 *   Total     82
 *
 * Pure computation — no DB, no HTTP, fully testable.
 * Score range: 0–95 (news is -10 to +5; rest are 0 to 90).
 */

import { Injectable } from '@nestjs/common';
import { FeatureSet } from './feature-engine.service';
import { SMCSignal } from '../smc/smc.service';

// ─── Public Types ──────────────────────────────────────────────────────────────

export interface ComponentScore {
  score: number;
  max:   number;
  reasons: string[];
}

export interface ConfidenceBreakdown {
  /** Clamped 0–100 */
  total:       number;
  trend:       ComponentScore;
  smc:         ComponentScore;
  momentum:    ComponentScore;
  liquidity:   ComponentScore;
  news:        ComponentScore;
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class ConfidenceExplainerService {

  /**
   * Compute a full confidence breakdown.
   * @param features     FeatureSet from FeatureEngineService
   * @param smcSignal    Raw SMC signal (may be null)
   * @param direction    Trade direction being evaluated
   * @param minutesUntilNews  Minutes until next high-impact news event; undefined = no event
   */
  explain(
    features:          FeatureSet,
    smcSignal:         SMCSignal | null,
    direction:         'BUY' | 'SELL',
    minutesUntilNews?: number,
  ): ConfidenceBreakdown {
    const trend     = this.scoreTrend(features, direction);
    const smc       = this.scoreSmc(features, smcSignal, direction);
    const momentum  = this.scoreMomentum(features, direction);
    const liquidity = this.scoreLiquidity(features, direction);
    const news      = this.scoreNews(minutesUntilNews);

    const raw   = trend.score + smc.score + momentum.score + liquidity.score + news.score;
    const total = Math.max(0, Math.min(100, raw));

    return { total, trend, smc, momentum, liquidity, news };
  }

  // ── Trend (+0 to +25) ────────────────────────────────────────────────────────

  private scoreTrend(f: FeatureSet, dir: 'BUY' | 'SELL'): ComponentScore {
    let score = 0;
    const reasons: string[] = [];

    // HTF EMA stack aligned
    if (f.htfTrend.aligned) {
      score += 10;
      reasons.push(`HTF EMA stack aligned (${f.htfTrend.direction})`);
    }

    // LTF EMA stack aligned
    if (f.ltfTrend.aligned) {
      score += 8;
      reasons.push(`LTF EMA stack aligned (${f.ltfTrend.direction})`);
    }

    // HTF SMC bias matches direction
    const biasMatch =
      (dir === 'BUY'  && f.smc.bias === 'BULLISH') ||
      (dir === 'SELL' && f.smc.bias === 'BEARISH');
    if (biasMatch) {
      score += 7;
      reasons.push(`HTF bias ${f.smc.bias} matches direction`);
    } else if (f.smc.bias !== 'NEUTRAL') {
      reasons.push(`⚠ HTF bias ${f.smc.bias} conflicts with ${dir}`);
    }

    if (score === 0) reasons.push('No trend alignment detected');
    return { score, max: 25, reasons };
  }

  // ── SMC (+0 to +25) ──────────────────────────────────────────────────────────

  private scoreSmc(f: FeatureSet, signal: SMCSignal | null, dir: 'BUY' | 'SELL'): ComponentScore {
    let score = 0;
    const reasons: string[] = [];

    // Order Block present
    if (f.smc.obPresent) {
      score += 8;
      reasons.push('Order Block confirmed in zone');
    }

    // Fair Value Gap
    if (f.smc.fvgPresent) {
      score += 7;
      reasons.push('FVG (Fair Value Gap) present');
    }

    // BOS / CHoCH from feature set
    if (f.smc.bos) {
      score += 5;
      reasons.push('BOS (Break of Structure) confirmed');
    }
    if (f.smc.choch) {
      score += 5;
      reasons.push('CHoCH (Change of Character) detected');
    }

    // SMC signal confidence if available
    if (signal && signal.confidence >= 70) {
      // Already counted OB/FVG/BOS above — just log
      reasons.push(`SMC raw confidence ${signal.confidence}%`);
    }

    // Cap at max 25
    score = Math.min(score, 25);
    if (score === 0) reasons.push('No SMC pattern confirmed');
    return { score, max: 25, reasons };
  }

  // ── Momentum (+0 to +20) ─────────────────────────────────────────────────────

  private scoreMomentum(f: FeatureSet, dir: 'BUY' | 'SELL'): ComponentScore {
    let score = 0;
    const reasons: string[] = [];
    const rsi = f.momentum.rsi;

    // RSI zone check
    if (dir === 'BUY') {
      if (f.momentum.rsiZone === 'oversold') {
        score += 10;
        reasons.push(`RSI oversold (${rsi.toFixed(1)}) — bullish reversal zone`);
      } else if (rsi < 55) {
        score += 5;
        reasons.push(`RSI neutral (${rsi.toFixed(1)}) — room to run`);
      } else {
        reasons.push(`⚠ RSI overbought (${rsi.toFixed(1)}) — caution on BUY`);
      }

      // Bullish divergence
      if (f.momentum.bullishDivergence) {
        score += 5;
        reasons.push('Bullish RSI divergence confirmed');
      }
    } else {
      if (f.momentum.rsiZone === 'overbought') {
        score += 10;
        reasons.push(`RSI overbought (${rsi.toFixed(1)}) — bearish reversal zone`);
      } else if (rsi > 45) {
        score += 5;
        reasons.push(`RSI neutral (${rsi.toFixed(1)}) — room to fall`);
      } else {
        reasons.push(`⚠ RSI oversold (${rsi.toFixed(1)}) — caution on SELL`);
      }

      if (f.momentum.bearishDivergence) {
        score += 5;
        reasons.push('Bearish RSI divergence confirmed');
      }
    }

    // ATR health — positive and reasonable (> 1 for XAUUSD)
    if (f.momentum.atr > 0) {
      score += 5;
      reasons.push(`ATR ${f.momentum.atr.toFixed(1)} — healthy volatility`);
    }

    score = Math.min(score, 20);
    if (score === 0) reasons.push('No momentum signal');
    return { score, max: 20, reasons };
  }

  // ── Liquidity (+0 to +20) ────────────────────────────────────────────────────

  private scoreLiquidity(f: FeatureSet, dir: 'BUY' | 'SELL'): ComponentScore {
    let score = 0;
    const reasons: string[] = [];

    // Liquidity sweep in direction
    if (f.smc.liquiditySwept) {
      score += 12;
      reasons.push('Liquidity sweep confirmed — institutional entry likely');
    }

    // Price in discount (BUY) or premium (SELL) zone
    const zone      = f.smc.zone;      // e.g. 'discount' | 'premium' | 'equilibrium'
    const zonePct   = f.smc.zonePct;   // 0-100, where 50 = equilibrium

    if (dir === 'BUY' && (zone === 'discount' || zonePct < 40)) {
      score += 8;
      reasons.push(`Price in discount zone (${zonePct.toFixed(0)}% of range)`);
    } else if (dir === 'SELL' && (zone === 'premium' || zonePct > 60)) {
      score += 8;
      reasons.push(`Price in premium zone (${zonePct.toFixed(0)}% of range)`);
    } else if (zonePct >= 40 && zonePct <= 60) {
      score += 3;
      reasons.push(`Price near equilibrium (${zonePct.toFixed(0)}%)`);
    } else {
      reasons.push(`⚠ Price against ${dir} zone (${zonePct.toFixed(0)}%)`);
    }

    score = Math.min(score, 20);
    return { score, max: 20, reasons };
  }

  // ── News (-10 to +5) ─────────────────────────────────────────────────────────

  private scoreNews(minutesUntilNews?: number): ComponentScore {
    const reasons: string[] = [];
    let score: number;

    if (minutesUntilNews === undefined || minutesUntilNews === null) {
      // No upcoming news known
      score = 5;
      reasons.push('No high-impact news in next 24 h');
    } else if (minutesUntilNews < 0) {
      // Just passed — within blackout after
      score = -3;
      reasons.push('News event recently passed — volatility risk');
    } else if (minutesUntilNews < 15) {
      score = -10;
      reasons.push(`⛔ High-impact event in ${minutesUntilNews} min — BLOCK`);
    } else if (minutesUntilNews < 30) {
      score = -5;
      reasons.push(`⚠ High-impact event in ${minutesUntilNews} min`);
    } else if (minutesUntilNews < 60) {
      score = 0;
      reasons.push(`News event in ${minutesUntilNews} min — monitor`);
    } else {
      score = 5;
      reasons.push(`Next event in ${minutesUntilNews} min — clear window`);
    }

    return { score, max: 5, reasons };
  }

  // ── Formatting Helpers ────────────────────────────────────────────────────────

  /** Render breakdown as a compact Telegram HTML string */
  formatTelegram(bd: ConfidenceBreakdown): string {
    const bar = (score: number, max: number): string => {
      const abs = Math.abs(score);
      const filled = Math.round((abs / Math.max(max, 1)) * 8);
      const sign   = score >= 0 ? '▓' : '░';
      return sign.repeat(filled) + '░'.repeat(Math.max(0, 8 - filled));
    };

    const fmt = (label: string, emoji: string, c: ComponentScore) => {
      const sign  = c.score >= 0 ? '+' : '';
      const width = String(c.max).length + 3; // align
      return `${emoji} <b>${label.padEnd(10)}</b> ${(sign + c.score).padStart(4)} / ${c.max}  ${bar(c.score, c.max)}`;
    };

    return (
      `\n📊 <b>Confidence Breakdown</b>\n` +
      `<code>` +
      `${'─'.repeat(34)}\n` +
      `${fmt('Trend',     '📈', bd.trend)}\n` +
      `${fmt('SMC',       '🔷', bd.smc)}\n` +
      `${fmt('Momentum',  '⚡', bd.momentum)}\n` +
      `${fmt('Liquidity', '💧', bd.liquidity)}\n` +
      `${fmt('News',      '📰', bd.news)}\n` +
      `${'─'.repeat(34)}\n` +
      `  Total: ${bd.total}%` +
      `</code>`
    );
  }

  /** Render as one-line reasons string for a specific component */
  topReasons(bd: ConfidenceBreakdown, max = 3): string[] {
    return [
      ...bd.trend.reasons,
      ...bd.smc.reasons,
      ...bd.momentum.reasons,
      ...bd.liquidity.reasons,
      ...bd.news.reasons,
    ].filter(r => !r.startsWith('⚠') && !r.startsWith('⛔')).slice(0, max);
  }
}
