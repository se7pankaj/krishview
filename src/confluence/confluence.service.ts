/**
 * confluence/confluence.service.ts — 360° Multi-Confluence Filter
 * ================================================================
 * Refined scoring approach (v2): fewer hard blocks, more additive confidence.
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
 *   Layer 6 — Session Timing        (London-NY overlap 13–16 UTC +5)
 *
 * TRADING TIERS (set TRADING_TIER in .env):
 *   1 = Aggressive  → threshold 62  → 4–6 trades/day, ~55–60% WR
 *   2 = Balanced    → threshold 74  → 2–4 trades/day, ~62–68% WR  ← default
 *   3 = Sniper      → threshold 86  → 0–2 trades/day, ~70%+ WR
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Candle, SMCSignal } from '../smc/smc.service';
import { FeatureSet } from '../analysis/feature-engine.service';

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
   * @param signal    - SMCSignal from smc.service.ts (with initial confidence)
   * @param features  - Full FeatureSet from feature-engine.service.ts
   * @param h1Candles - Raw H1 candles for volume baseline
   * @param m5Candles - Raw M5 candles for recent sweep volume
   */
  check(
    signal:    SMCSignal,
    features:  FeatureSet,
    h1Candles: Candle[],
    m5Candles: Candle[],
  ): ConfluenceResult {
    const dir   = signal.direction; // 'BUY' | 'SELL'
    const price = features.price;

    const hardBlocks:   string[] = [];
    const boostReasons: string[] = [];
    let boost = 0;

    // ── Layer 2: EMA Stack ────────────────────────────────────────────────
    const emaResult = this.checkEmaStack(features, dir, price);
    // Only one hard block survives: price wrong side of D1 EMA200
    if (emaResult.hardBlock && !this.skipEmaHardBlock) {
      hardBlocks.push(emaResult.blockReason!);
    }
    boost += emaResult.boost;
    boostReasons.push(...emaResult.boostReasons);

    // ── Layer 3: RSI ──────────────────────────────────────────────────────
    const rsiResult = this.checkRsi(features, dir);
    if (rsiResult.hardBlock && !this.skipRsiHardBlock) {
      hardBlocks.push(rsiResult.blockReason!);
    }
    boost += rsiResult.boost;
    boostReasons.push(...rsiResult.boostReasons);

    // ── Layer 4: Fibonacci ────────────────────────────────────────────────
    const fibResult = this.checkFibonacci(features, price);
    boost += fibResult.boost;
    boostReasons.push(...fibResult.boostReasons);

    // ── Layer 5: Volume ───────────────────────────────────────────────────
    const volResult = this.checkVolume(h1Candles, m5Candles);
    boost += volResult.boost; // may be negative
    boostReasons.push(...volResult.boostReasons);

    // ── Layer 6: Session Timing ───────────────────────────────────────────
    const sessionResult = this.checkSessionTiming();
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
  ): { hardBlock: boolean; blockReason?: string; boost: number; boostReasons: string[]; aligned: boolean } {
    const d1 = features.d1Trend;
    const h4 = features.h4Trend;
    const h1 = features.h1Trend;

    let boost = 0;
    const boostReasons: string[] = [];
    let hardBlock  = false;
    let blockReason: string | undefined;
    let aligned    = false;

    // ── ONLY hard block: price vs D1 EMA200 ───────────────────────────────
    if (dir === 'BUY' && price < d1.ema200) {
      hardBlock   = true;
      blockReason = `Price ${price} below D1 EMA200 ${d1.ema200.toFixed(2)} — counter-institutional BUY blocked`;
    }
    if (dir === 'SELL' && price > d1.ema200) {
      hardBlock   = true;
      blockReason = `Price ${price} above D1 EMA200 ${d1.ema200.toFixed(2)} — counter-institutional SELL blocked`;
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
    h1Candles: Candle[],
    m5Candles: Candle[],
  ): { boost: number; boostReasons: string[]; spike: boolean } {
    const boostReasons: string[] = [];
    let boost = 0;
    let spike = false;

    // Baseline: avg tick volume of last 20 H1 candles
    const h1Vol   = h1Candles.slice(-20).map(c => c.volume ?? 0);
    const avgH1   = h1Vol.length > 0 ? h1Vol.reduce((a, b) => a + b, 0) / h1Vol.length : 0;

    if (avgH1 === 0) {
      this.logger.debug('Volume baseline unavailable (MetaApi may return 0) — skipping volume layer');
      return { boost: 0, boostReasons: [], spike: false };
    }

    // M5 scaling: 1 H1 ≈ 12 M5 candles
    const m5Baseline = avgH1 / 12;
    const recentM5   = m5Candles.slice(-3);
    const maxM5Vol   = Math.max(...recentM5.map(c => c.volume ?? 0));
    const volRatio   = m5Baseline > 0 ? maxM5Vol / m5Baseline : 0;

    this.logger.debug(
      `Volume: H1avg=${avgH1.toFixed(0)} M5base=${m5Baseline.toFixed(0)} ` +
      `maxM5=${maxM5Vol} ratio=${volRatio.toFixed(2)}`,
    );

    if (volRatio >= 1.5) {
      boost += 10;
      spike  = true;
      boostReasons.push(`M5 tick volume spike ${volRatio.toFixed(1)}× baseline — institutional sweep confirmed (+10)`);
    } else if (volRatio >= 1.0) {
      boost += 5;
      spike  = true;
      boostReasons.push(`M5 tick volume elevated ${volRatio.toFixed(1)}× baseline — above-average activity (+5)`);
    } else if (volRatio > 0 && volRatio < 0.6) {
      boost -= 8;
      boostReasons.push(`M5 tick volume thin ${volRatio.toFixed(1)}× baseline — low conviction, fake-out risk (−8)`);
    }

    // H1 rising volume (institutions defending the OB)
    if (h1Candles.length >= 2) {
      const last  = h1Candles[h1Candles.length - 1].volume ?? 0;
      const prior = h1Candles[h1Candles.length - 2].volume ?? 0;
      if (prior > 0 && last > prior * 1.3) {
        boost += 8;
        boostReasons.push(`H1 volume rising (${last} vs ${prior}) — institutions defending level (+8)`);
      }
    }

    return { boost, boostReasons, spike };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // LAYER 6 — SESSION / KILLZONE TIMING
  // ══════════════════════════════════════════════════════════════════════════
  //
  // London-NY overlap (13:00–16:00 UTC) is statistically the strongest
  // window for XAUUSD: London liquidity + NY institutional volume firing
  // simultaneously. Signals during this window get a small bonus.
  //
  //   In London-NY overlap (13–16 UTC) : +5
  // ══════════════════════════════════════════════════════════════════════════

  private checkSessionTiming(): { boost: number; boostReasons: string[]; inOverlap: boolean } {
    const utcHour = new Date().getUTCHours();
    const inOverlap = utcHour >= 13 && utcHour < 16;

    if (inOverlap) {
      return {
        boost: 5,
        boostReasons: [`London-NY overlap session (${utcHour}:xx UTC) — maximum institutional participation (+5)`],
        inOverlap: true,
      };
    }

    return { boost: 0, boostReasons: [], inOverlap: false };
  }
}
