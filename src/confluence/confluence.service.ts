/**
 * confluence/confluence.service.ts — 360° Multi-Confluence Filter
 * ================================================================
 * Refined scoring approach (v3): mode-aware session timing, corrected
 * volume scaling per candle resolution, and no hard-blocks except
 * D1 EMA200 and RSI extreme extension.
 *
 * HARD BLOCKS (pipeline stops immediately — non-negotiable):
 *   1. Price wrong side of D1 EMA200 (counter-institutional)
 *   2. RSI extreme extension (>75 BUY / <25 SELL) — configurable via env
 *
 * ADDITIVE SCORING LAYERS (everything else is a boost or penalty):
 *   Layer 2 — EMA Stack Alignment  (full stack +15, partial +8, misaligned −8)
 *   Layer 3 — RSI Confirmation      (ideal zone +8, divergence +12, slope +4)
 *   Layer 4 — Fibonacci Confluence  (61.8% +12, 50% +8, 38.2% +5)
 *   Layer 5 — Volume Conviction     (spike ≥1.5× +10, elevated +5, thin −8)
 *   Layer 6 — Session Timing        (mode-aware — see checkSessionTiming())
 *
 * SESSION BONUSES BY MODE:
 *   INSTITUTIONAL  : London-NY overlap 13–16 UTC only (+5)
 *   PRECISION      : London open 07–10 (+8), London-NY overlap 13–16 (+10), NY 16–20 (+5)
 *   QUICK_SCALP    : Asian 00–07 (+3), London open 07–10 (+8), mid 10–13 (+5),
 *                    London-NY overlap 13–16 (+10), NY afternoon 16–20 (+5)
 *
 * VOLUME SCALING:
 *   Baseline candle resolution is mode-dependent (h2Candles are M15 in QS, H1 in Inst).
 *   The ratio-to-entry-candle scaling adapts so comparisons are apple-to-apple.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Candle, SMCSignal } from '../smc/smc.service';
import { FeatureSet } from '../analysis/feature-engine.service';
import { ModeConfig } from '../config/app-config.service';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ConfluenceResult {
  /** false = hard block fired → skip trade immediately */
  pass: boolean;

  /** SMC base confidence adjusted by confluence (capped at 100) */
  adjustedConfidence: number;

  /** Points added/subtracted by all confluence layers */
  confluenceBoost: number;

  /** Human-readable reasons why a hard block fired */
  hardBlocks: string[];

  /** Human-readable reasons for each confidence adjustment */
  boostReasons: string[];

  /** Active trading tier (1=Aggressive, 2=Balanced, 3=Sniper) */
  tradingTier: number;

  /** Minimum confidence required to proceed for the active tier */
  tierThreshold: number;

  /** Per-layer flags for dashboard display */
  emaAligned:    boolean;
  rsiOk:         boolean;
  fibConfluence: boolean;
  volumeSpike:   boolean;
  volumePenalty: boolean;
  inOverlapSession: boolean;
}

// ─── Tier thresholds ──────────────────────────────────────────────────────────

const TIER_THRESHOLDS: Record<number, number> = {
  1: 62,  // Aggressive  — 4–6 trades/day
  2: 74,  // Balanced    — 2–4 trades/day (recommended)
  3: 86,  // Sniper      — 0–2 trades/day
};

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class ConfluenceService {
  private readonly logger = new Logger(ConfluenceService.name);

  constructor(private readonly config: ConfigService) {}

  // ── Config ────────────────────────────────────────────────────────────────

  private get skipEmaHardBlock(): boolean {
    return this.config.get<string>('SKIP_EMA_HARD_BLOCK', 'false') === 'true';
  }
  private get skipRsiHardBlock(): boolean {
    return this.config.get<string>('SKIP_RSI_HARD_BLOCK', 'false') === 'true';
  }
  /** RSI extreme ceiling — no BUY above this (default 75, was 72) */
  private get rsiOverbought(): number {
    return parseFloat(this.config.get<string>('RSI_OVERBOUGHT', '75'));
  }
  /** RSI extreme floor — no SELL below this (default 25, was 28) */
  private get rsiOversold(): number {
    return parseFloat(this.config.get<string>('RSI_OVERSOLD', '25'));
  }
  private get rsiBuyZoneLow(): number  { return 45; }
  private get rsiBuyZoneHigh(): number { return 60; }
  private get rsiSellZoneLow(): number  { return 40; }
  private get rsiSellZoneHigh(): number { return 55; }
  private get fibTolerance(): number { return 0.005; } // 0.5% proximity to fib level

  private get tradingTier(): number {
    const tier = parseInt(this.config.get<string>('TRADING_TIER', '2'), 10);
    return [1, 2, 3].includes(tier) ? tier : 2;
  }
  private get tierThreshold(): number {
    return TIER_THRESHOLDS[this.tradingTier] ?? 74;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MAIN ENTRY POINT
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Apply the 360° confluence filter to an SMC signal.
   *
   * @param signal     - SMCSignal from smc.service.ts (with initial confidence)
   * @param features   - Full FeatureSet from feature-engine.service.ts
   * @param l3Candles  - Layer-3 candles for volume baseline (H1 in Institutional, M15 in Precision/QS)
   * @param l5Candles  - Layer-5 entry candles for volume spike (M5 in Institutional, M1 in Precision/QS)
   * @param modeConfig - Active trading mode — used for session timing and volume scaling
   */
  check(
    signal:     SMCSignal,
    features:   FeatureSet,
    l3Candles:  Candle[],
    l5Candles:  Candle[],
    modeConfig?: ModeConfig,
  ): ConfluenceResult {
    const dir   = signal.direction; // 'BUY' | 'SELL'
    const price = features.price;

    const hardBlocks:   string[] = [];
    const boostReasons: string[] = [];
    let boost = 0;

    // ── Layer 2: EMA Stack ────────────────────────────────────────────────
    const emaResult = this.checkEmaStack(features, dir, price, modeConfig);
    // Only one hard block survives: price wrong side of D1 EMA200
    if (emaResult.hardBlock && !this.skipEmaHardBlock) {
      hardBlocks.push(emaResult.blockReason!);
    }
    boost += emaResult.boost;
    boostReasons.push(...emaResult.boostReasons);

    // ── Layer 3: RSI ──────────────────────────────────────────────────────
    const rsiResult = this.checkRsi(features, dir);
    // Scalp modes (htfTf=H1) treat RSI extreme as a penalty (−15), not a hard block.
    // Gold can run RSI 70–80+ for hours/days in a strong rally — a hard block here
    // kills every BUY signal during the best momentum setups.
    const isScalpMode = modeConfig?.htfTf === 'H1';
    if (rsiResult.hardBlock && !this.skipRsiHardBlock) {
      if (isScalpMode) {
        // Convert hard block to a scoring penalty so confluence can still pass
        boost -= 15;
        boostReasons.push(`RSI extreme (${features.momentum?.rsi?.toFixed(1) ?? '?'}) — momentum caution (−15)`);
      } else {
        hardBlocks.push(rsiResult.blockReason!);
      }
    }
    boost += rsiResult.boost;
    boostReasons.push(...rsiResult.boostReasons);

    // ── Layer 4: Fibonacci ────────────────────────────────────────────────
    const fibResult = this.checkFibonacci(features, price);
    boost += fibResult.boost;
    boostReasons.push(...fibResult.boostReasons);

    // ── Layer 5: Volume ───────────────────────────────────────────────────
    const volResult = this.checkVolume(l3Candles, l5Candles, modeConfig);
    boost += volResult.boost; // may be negative
    boostReasons.push(...volResult.boostReasons);

    // ── Layer 6: Session Timing ───────────────────────────────────────────
    const sessionResult = this.checkSessionTiming(modeConfig);
    boost += sessionResult.boost;
    boostReasons.push(...sessionResult.boostReasons);

    // ── Final score ───────────────────────────────────────────────────────
    const adjustedConfidence = Math.min(100, Math.max(0, signal.confidence + boost));
    const pass = hardBlocks.length === 0;

    const tier      = this.tradingTier;
    const threshold = this.tierThreshold;

    this.logger.log(
      `Confluence [${dir}] Tier${tier}(≥${threshold}): base=${signal.confidence}% ` +
      `boost=${boost >= 0 ? '+' : ''}${boost} → ${adjustedConfidence}% | ` +
      `blocks=${hardBlocks.length} boosts=${boostReasons.length} | ` +
      `EMA=${emaResult.aligned} RSI=${rsiResult.ok} Fib=${fibResult.confluence} ` +
      `Vol=${volResult.spike} Overlap=${sessionResult.inOverlap}`,
    );
    if (hardBlocks.length) {
      this.logger.warn(`Confluence HARD BLOCK [${dir}]: ${hardBlocks.join(' | ')}`);
    }

    return {
      pass,
      adjustedConfidence,
      confluenceBoost: boost,
      hardBlocks,
      boostReasons:    boostReasons.filter(r => r.length > 0),
      tradingTier:     tier,
      tierThreshold:   threshold,
      emaAligned:      emaResult.aligned,
      rsiOk:           rsiResult.ok,
      fibConfluence:   fibResult.confluence,
      volumeSpike:     volResult.spike,
      volumePenalty:   volResult.boost < 0,
      inOverlapSession: sessionResult.inOverlap,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // LAYER 2 — EMA STACK ALIGNMENT
  // ══════════════════════════════════════════════════════════════════════════
  //
  // Hard block: price wrong side of D1 EMA200 only.
  //             (D1+H4 both misaligned → −8 penalty, not a block)
  //
  // Boosts:
  //   Full 3-TF stack (D1+H4+H1 all aligned)  : +15
  //   Partial stack (D1 or H4 aligned)          : +8
  //   H1 EMA200 dynamic bounce/rejection        : +10
  //   H4 EMA20 > EMA50 (bullish) or <  (bearish): +8
  //
  // Penalties:
  //   Both D1 and H4 EMAs misaligned (choppy)   : −8
  // ══════════════════════════════════════════════════════════════════════════

  private checkEmaStack(
    features: FeatureSet,
    dir: 'BUY' | 'SELL',
    price: number,
    modeConfig?: ModeConfig,
  ): { hardBlock: boolean; blockReason?: string; boost: number; boostReasons: string[]; aligned: boolean } {
    const d1 = features.d1Trend;
    const h4 = features.h4Trend;
    const h1 = features.h1Trend;

    let boost = 0;
    const boostReasons: string[] = [];
    let hardBlock  = false;
    let blockReason: string | undefined;
    let aligned    = false;

    // ── D1 EMA200 check — mode-aware ─────────────────────────────────────
    //
    // INSTITUTIONAL (D1 timeframe): hard block. D1 EMA200 is the absolute
    // institutional boundary — never trade against it on daily timeframe.
    //
    // SCALPING MODES (Quick Scalp / Precision / Micro Scalp):
    // Convert to a PENALTY (-15) instead of a hard block.
    // Reason: gold at 4008 is far above D1 EMA200 (~2800). At scalping level
    // (M30/M15/M5 timeframes), valid SELL setups exist within bull markets —
    // short-term corrections of 50-150 pips are normal and tradeable.
    // The D1 EMA200 adds macro context but must not kill every counter-trend scalp.
    //
    // The -15 penalty means counter-trend scalps need stronger local confluence
    // (RSI divergence, Fib, session timing) to overcome it — which is correct.
    const isInstitutional = !modeConfig || modeConfig.htfTf === 'D1';

    if (dir === 'BUY' && price < d1.ema200) {
      if (isInstitutional) {
        hardBlock   = true;
        blockReason = `Price ${price} below D1 EMA200 ${d1.ema200.toFixed(2)} — counter-institutional BUY blocked`;
      } else {
        boost -= 15;
        boostReasons.push(`Counter-trend BUY: price ${price.toFixed(2)} below D1 EMA200 ${d1.ema200.toFixed(2)} — macro bearish context (−15)`);
      }
    }
    if (dir === 'SELL' && price > d1.ema200) {
      if (isInstitutional) {
        hardBlock   = true;
        blockReason = `Price ${price} above D1 EMA200 ${d1.ema200.toFixed(2)} — counter-institutional SELL blocked`;
      } else {
        boost -= 15;
        boostReasons.push(`Counter-trend SELL: price ${price.toFixed(2)} above D1 EMA200 ${d1.ema200.toFixed(2)} — macro bullish context (−15)`);
      }
    }

    // ── Alignment flags ───────────────────────────────────────────────────
    const d1Bullish = d1.ema20 > d1.ema50 && d1.ema50 > d1.ema200;
    const d1Bearish = d1.ema20 < d1.ema50 && d1.ema50 < d1.ema200;
    const h4Bullish = h4.ema20 > h4.ema50 && h4.ema50 > h4.ema200;
    const h4Bearish = h4.ema20 < h4.ema50 && h4.ema50 < h4.ema200;
    const h1Bullish = h1.ema20 > h1.ema50 && h1.ema50 > h1.ema200;
    const h1Bearish = h1.ema20 < h1.ema50 && h1.ema50 < h1.ema200;

    // ── Full 3-TF stack boost ─────────────────────────────────────────────
    const fullBullStack = dir === 'BUY'  && d1Bullish && h4Bullish && h1Bullish;
    const fullBearStack = dir === 'SELL' && d1Bearish && h4Bearish && h1Bearish;

    if (fullBullStack || fullBearStack) {
      boost += 15;
      boostReasons.push(
        `D1+H4+H1 EMA stack fully aligned ${dir === 'BUY' ? 'bullish' : 'bearish'} (+15)`,
      );
      aligned = true;
    } else {
      // Partial alignment — D1 or H4 pointing the right way
      const d1Ok = dir === 'BUY' ? d1Bullish : d1Bearish;
      const h4Ok = dir === 'BUY' ? h4Bullish : h4Bearish;

      if (d1Ok || h4Ok) {
        boost += 8;
        const which = [d1Ok ? 'D1' : null, h4Ok ? 'H4' : null].filter(Boolean).join('+');
        boostReasons.push(`${which} EMA stack aligned ${dir === 'BUY' ? 'bullish' : 'bearish'} (+8)`);
        aligned = true;
      } else {
        // Both misaligned → market is choppy: penalty (not a block)
        boost -= 8;
        boostReasons.push(
          `D1 and H4 EMA stacks both non-${dir === 'BUY' ? 'bullish' : 'bearish'} — choppy market, reduced conviction (−8)`,
        );
      }
    }

    // ── H1 EMA200 dynamic bounce/rejection ────────────────────────────────
    const nearH1Ema200 = Math.abs(price - h1.ema200) / price < 0.002; // within 0.2%
    if (nearH1Ema200) {
      if (dir === 'BUY' && price > h1.ema200) {
        boost += 10;
        boostReasons.push(`Price bouncing off H1 EMA200 ${h1.ema200.toFixed(2)} — dynamic OB confluence (+10)`);
      }
      if (dir === 'SELL' && price < h1.ema200) {
        boost += 10;
        boostReasons.push(`Price rejecting at H1 EMA200 ${h1.ema200.toFixed(2)} — dynamic resistance (+10)`);
      }
    }

    // ── H4 short-term momentum (EMA20 vs EMA50) ───────────────────────────
    if (dir === 'BUY'  && h4.ema20 > h4.ema50) {
      boost += 8;
      boostReasons.push(`H4 EMA20 (${h4.ema20.toFixed(2)}) above EMA50 (${h4.ema50.toFixed(2)}) — H4 bullish momentum (+8)`);
    }
    if (dir === 'SELL' && h4.ema20 < h4.ema50) {
      boost += 8;
      boostReasons.push(`H4 EMA20 (${h4.ema20.toFixed(2)}) below EMA50 (${h4.ema50.toFixed(2)}) — H4 bearish momentum (+8)`);
    }

    // ── Entry-TF EMA20 vs EMA50 momentum direction ───────────────────────
    // OB entries are pullbacks — price is often BELOW EMA20 at the entry zone,
    // so checking price vs EMA20 would always penalise the valid setup.
    // Instead: check if EMA20 is above EMA50 on the entry TF (m5Trend).
    // EMA20 > EMA50 means the short-term trend is bullish regardless of where price
    // currently is. This is a bonus-only check — no penalty, since misalignment
    // is already captured by the D1/H4/H1 EMA stack check above.
    const m5 = features.m5Trend;
    if (m5) {
      if (dir === 'BUY' && m5.ema20 > m5.ema50) {
        boost += 8;
        boostReasons.push(`Entry-TF EMA20 (${m5.ema20.toFixed(2)}) > EMA50 (${m5.ema50.toFixed(2)}) — short-term trend bullish (+8)`);
      } else if (dir === 'SELL' && m5.ema20 < m5.ema50) {
        boost += 8;
        boostReasons.push(`Entry-TF EMA20 (${m5.ema20.toFixed(2)}) < EMA50 (${m5.ema50.toFixed(2)}) — short-term trend bearish (+8)`);
      }
    }

    return { hardBlock, blockReason, boost, boostReasons, aligned };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // LAYER 3 — RSI CONFIRMATION & DIVERGENCE
  // ══════════════════════════════════════════════════════════════════════════
  //
  // Hard block: RSI > 75 (no BUY) / RSI < 25 (no SELL)
  //             Thresholds tightened from 72/28 — allows more valid signals
  //             in strong trends while still blocking genuine exhaustion.
  //
  // Boosts:
  //   Divergence (bullish/bearish)    : +12
  //   Ideal zone (45–60 BUY / 40–55 SELL): +8
  //   RSI slope aligned with trade     : +4
  // ══════════════════════════════════════════════════════════════════════════

  private checkRsi(
    features: FeatureSet,
    dir: 'BUY' | 'SELL',
  ): { hardBlock: boolean; blockReason?: string; boost: number; boostReasons: string[]; ok: boolean } {
    const rsi = features.momentum.rsi;
    const mom = features.momentum;

    let boost = 0;
    const boostReasons: string[] = [];
    let hardBlock   = false;
    let blockReason: string | undefined;
    let ok          = true;

    // ── Hard blocks (extreme extension only) ──────────────────────────────
    if (dir === 'BUY' && rsi > this.rsiOverbought) {
      hardBlock   = true;
      ok          = false;
      blockReason = `RSI ${rsi.toFixed(1)} > ${this.rsiOverbought} — overbought extension, smart money distributing`;
    }
    if (dir === 'SELL' && rsi < this.rsiOversold) {
      hardBlock   = true;
      ok          = false;
      blockReason = `RSI ${rsi.toFixed(1)} < ${this.rsiOversold} — oversold extension, central bank buying accelerates`;
    }

    if (hardBlock) {
      return { hardBlock, blockReason, boost, boostReasons, ok };
    }

    // ── Divergence (highest-value RSI signal) ─────────────────────────────
    if (dir === 'BUY' && mom.bullishDivergence) {
      boost += 12;
      boostReasons.push(`Bullish RSI divergence — price lower low / RSI higher low (institutional accumulation) (+12)`);
    }
    if (dir === 'SELL' && mom.bearishDivergence) {
      boost += 12;
      boostReasons.push(`Bearish RSI divergence — price higher high / RSI lower high (institutional distribution) (+12)`);
    }

    // ── Ideal zone ────────────────────────────────────────────────────────
    if (dir === 'BUY' && rsi >= this.rsiBuyZoneLow && rsi <= this.rsiBuyZoneHigh) {
      boost += 8;
      boostReasons.push(`RSI ${rsi.toFixed(1)} in ideal BUY zone (${this.rsiBuyZoneLow}–${this.rsiBuyZoneHigh}) — momentum reset, rebuilding (+8)`);
    }
    if (dir === 'SELL' && rsi >= this.rsiSellZoneLow && rsi <= this.rsiSellZoneHigh) {
      boost += 8;
      boostReasons.push(`RSI ${rsi.toFixed(1)} in ideal SELL zone (${this.rsiSellZoneLow}–${this.rsiSellZoneHigh}) — momentum fading, rolling over (+8)`);
    }

    // ── RSI slope ─────────────────────────────────────────────────────────
    if (dir === 'BUY'  && mom.rsiTrend === 'rising') {
      boost += 4;
      boostReasons.push(`RSI slope rising — momentum building (+4)`);
    }
    if (dir === 'SELL' && mom.rsiTrend === 'falling') {
      boost += 4;
      boostReasons.push(`RSI slope falling — momentum weakening (+4)`);
    }

    return { hardBlock, blockReason, boost, boostReasons, ok };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // LAYER 4 — FIBONACCI CONFLUENCE
  // ══════════════════════════════════════════════════════════════════════════
  //
  // Boosts only — never a hard block.
  //   Price at 61.8% Golden Ratio          : +12
  //   Price at 50.0% Equilibrium            : +8
  //   Price at 38.2% Retracement            : +5
  //   H4 OB range contains a fib level     : 60% of level points
  // ══════════════════════════════════════════════════════════════════════════

  private checkFibonacci(
    features: FeatureSet,
    price: number,
  ): { boost: number; boostReasons: string[]; confluence: boolean } {
    const fib = features.fibonacci;
    let boost = 0;
    const boostReasons: string[] = [];
    let confluence = false;

    const levels: Array<{ level: number; name: string; pts: number }> = [
      { level: fib.level618, name: '61.8% Golden Ratio', pts: 12 },
      { level: fib.level500, name: '50.0% Equilibrium',  pts:  8 },
      { level: fib.level382, name: '38.2% Retracement',  pts:  5 },
    ];

    // Price at a fib level (highest value)
    for (const { level, name, pts } of levels) {
      if (!level || level === 0) continue;
      const pctDist = Math.abs(price - level) / price;
      if (pctDist <= this.fibTolerance) {
        boost += pts;
        boostReasons.push(`Price at Fibonacci ${name} (${level.toFixed(2)}) — OB/FVG confluence (+${pts})`);
        confluence = true;
        break; // only count the closest level
      }
    }

    // H4 OB contains a fib level (zone is "magnetised")
    if (!confluence && features.smc.h4ObPresent && features.smc.h4ObLow && features.smc.h4ObHigh) {
      for (const { level, name, pts } of levels) {
        if (!level || level === 0) continue;
        if (level >= features.smc.h4ObLow && level <= features.smc.h4ObHigh) {
          const zonePts = Math.round(pts * 0.6);
          boost += zonePts;
          boostReasons.push(
            `H4 OB (${features.smc.h4ObLow}–${features.smc.h4ObHigh}) contains Fibonacci ${name} — zone magnetised (+${zonePts})`,
          );
          confluence = true;
          break;
        }
      }
    }

    return { boost, boostReasons, confluence };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // LAYER 5 — VOLUME CONVICTION
  // ══════════════════════════════════════════════════════════════════════════
  //
  // Volume is NEVER a hard block (tick volume from MetaApi is unreliable
  // enough that a valid setup on moderate volume should still proceed).
  //
  //   M5 spike ≥1.5× baseline  : +10
  //   M5 elevated 1–1.5×       : +5
  //   M5 thin <0.6× (fake-out) : −8
  //   H1 volume rising vs prior : +8
  // ══════════════════════════════════════════════════════════════════════════

  private checkVolume(
    l3Candles:   Candle[],     // Layer-3 candles: H1 in Institutional, M15 in Precision/QS
    l5Candles:   Candle[],     // Layer-5 entry candles: M5 in Institutional, M1 in Precision/QS
    modeConfig?: ModeConfig,
  ): { boost: number; boostReasons: string[]; spike: boolean } {
    const boostReasons: string[] = [];
    let boost = 0;
    let spike = false;

    // Baseline: avg tick volume of last 20 L3 candles
    const l3Vol    = l3Candles.slice(-20).map(c => c.volume ?? 0);
    const avgL3    = l3Vol.length > 0 ? l3Vol.reduce((a, b) => a + b, 0) / l3Vol.length : 0;

    if (avgL3 === 0) {
      this.logger.debug('Volume baseline unavailable (MetaApi may return 0) — skipping volume layer');
      return { boost: 0, boostReasons: [], spike: false };
    }

    // L3→L5 ratio: how many entry candles fit inside one L3 candle.
    // Use confirmTf (actual L3 timeframe) — not htfTf — so MICRO_SCALP gets its own ratio.
    //   Institutional:  L3=H1  → L5=M5  = 12 M5  per H1
    //   Precision/QS:   L3=M15 → L5=M1  = 15 M1  per M15
    //   Micro Scalp:    L3=M5  → L5=M1  =  5 M1  per M5
    const l3ToL5Ratio =
      modeConfig?.confirmTf === 'H1'  ? 12 :  // Institutional
      modeConfig?.confirmTf === 'M15' ? 15 :  // Precision / Quick Scalp
      modeConfig?.confirmTf === 'M5'  ? 5  :  // Micro Scalp
      12;                                      // Fallback

    const l5Baseline = avgL3 / l3ToL5Ratio;
    const recentL5   = l5Candles.slice(-3);
    const maxL5Vol   = Math.max(...recentL5.map(c => c.volume ?? 0));
    const volRatio   = l5Baseline > 0 ? maxL5Vol / l5Baseline : 0;

    // Accurate TF labels from modeConfig for log output
    const l3Label = modeConfig?.confirmTf ?? 'H1';
    const l5Label = modeConfig?.entryTf   ?? 'M5';

    this.logger.debug(
      `Volume: ${l3Label}avg=${avgL3.toFixed(0)} ${l5Label}base=${l5Baseline.toFixed(0)} ` +
      `max${l5Label}=${maxL5Vol} ratio=${volRatio.toFixed(2)}`,
    );

    if (volRatio >= 1.5) {
      boost += 10;
      spike  = true;
      boostReasons.push(`${l5Label} tick volume spike ${volRatio.toFixed(1)}× baseline — institutional sweep confirmed (+10)`);
    } else if (volRatio >= 1.0) {
      boost += 5;
      spike  = true;
      boostReasons.push(`${l5Label} tick volume elevated ${volRatio.toFixed(1)}× baseline — above-average activity (+5)`);
    } else if (volRatio > 0 && volRatio < 0.6) {
      boost -= 8;
      boostReasons.push(`${l5Label} tick volume thin ${volRatio.toFixed(1)}× baseline — low conviction, fake-out risk (−8)`);
    }

    // L3 rising volume (institutions defending the OB)
    if (l3Candles.length >= 2) {
      const last  = l3Candles[l3Candles.length - 1].volume ?? 0;
      const prior = l3Candles[l3Candles.length - 2].volume ?? 0;
      if (prior > 0 && last > prior * 1.3) {
        boost += 8;
        boostReasons.push(`${l3Label} volume rising (${last} vs ${prior}) — institutions defending level (+8)`);
      }
    }

    return { boost, boostReasons, spike };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // LAYER 6 — SESSION / KILLZONE TIMING  (mode-aware v3)
  // ══════════════════════════════════════════════════════════════════════════
  //
  // Session bonuses are calibrated to each mode's trading window.
  //
  // INSTITUTIONAL (London+NY strict):
  //   London-NY overlap 13–16 UTC     : +5
  //
  // PRECISION (Extended 06–20 UTC):
  //   London open 07–10 UTC            : +8  (clean SMC OB touches at open)
  //   London-NY overlap 13–16 UTC      : +10 (max liquidity)
  //   NY afternoon 16–20 UTC           : +5  (NY continuation)
  //   Pre-London 06–07 UTC             : +3  (early positioning)
  //
  // QUICK SCALP (All weekday hours):
  //   Asian session 00–07 UTC          : +3  (lower volatility, still valid)
  //   London open 07–10 UTC            : +8  (best scalp setup window)
  //   London mid-session 10–13 UTC     : +5
  //   London-NY overlap 13–16 UTC      : +10 (max participation — prefer)
  //   NY afternoon 16–20 UTC           : +5
  //   Late NY / pre-Asian 20–00 UTC    : +2  (thin but tradeable in QS)
  // ══════════════════════════════════════════════════════════════════════════

  private checkSessionTiming(
    modeConfig?: ModeConfig,
  ): { boost: number; boostReasons: string[]; inOverlap: boolean } {
    const h = new Date().getUTCHours();

    // ── Quick Scalp — all weekday hours valid, session-weighted ─────────────
    if (modeConfig?.htfTf === 'H1') {
      if (h >= 13 && h < 16) return { boost: 10, inOverlap: true,  boostReasons: [`London-NY overlap (${h}:xx UTC) — maximum volume, best scalp momentum (+10)`] };
      if (h >= 7  && h < 10) return { boost: 8,  inOverlap: false, boostReasons: [`London open killzone (${h}:xx UTC) — clean OB/FVG touches (+8)`] };
      if (h >= 10 && h < 13) return { boost: 5,  inOverlap: false, boostReasons: [`London mid-session (${h}:xx UTC) — continuation flow (+5)`] };
      if (h >= 16 && h < 20) return { boost: 5,  inOverlap: false, boostReasons: [`NY afternoon session (${h}:xx UTC) — US continuation (+5)`] };
      if (h >= 0  && h < 7)  return { boost: 3,  inOverlap: false, boostReasons: [`Asian session (${h}:xx UTC) — lower volatility, range valid (+3)`] };
      // 20–00 UTC: late NY / pre-Asian
      return { boost: 2, inOverlap: false, boostReasons: [`Late NY / pre-Asian (${h}:xx UTC) — thin but valid for QS (+2)`] };
    }

    // ── Precision Scalp — extended 06:00–20:00 UTC weekdays ─────────────────
    if (modeConfig?.htfTf === 'H4') {
      if (h >= 13 && h < 16) return { boost: 10, inOverlap: true,  boostReasons: [`London-NY overlap (${h}:xx UTC) — maximum institutional participation (+10)`] };
      if (h >= 7  && h < 10) return { boost: 8,  inOverlap: false, boostReasons: [`London open killzone (${h}:xx UTC) — H1 OB sweeps at their cleanest (+8)`] };
      if (h >= 16 && h < 20) return { boost: 5,  inOverlap: false, boostReasons: [`NY afternoon session (${h}:xx UTC) — US continuation (+5)`] };
      if (h >= 6  && h < 7)  return { boost: 3,  inOverlap: false, boostReasons: [`Pre-London (${h}:xx UTC) — early positioning (+3)`] };
      if (h >= 10 && h < 13) return { boost: 5,  inOverlap: false, boostReasons: [`London mid-session (${h}:xx UTC) — steady flow (+5)`] };
      // Outside 06–20: no bonus (trading is still allowed in extended mode but not preferred)
      return { boost: 0, inOverlap: false, boostReasons: [] };
    }

    // ── Institutional — strict London + NY killzones ─────────────────────────
    if (h >= 13 && h < 16) {
      return {
        boost: 5, inOverlap: true,
        boostReasons: [`London-NY overlap (${h}:xx UTC) — maximum institutional participation (+5)`],
      };
    }
    if (h >= 7 && h < 10) {
      return {
        boost: 3, inOverlap: false,
        boostReasons: [`London open killzone (${h}:xx UTC) — institutional order flow active (+3)`],
      };
    }

    return { boost: 0, boostReasons: [], inOverlap: false };
  }
}
