/**
 * smc/smc.service.ts — Smart Money Concepts Analysis Engine
 * ==========================================================
 * NestJS port of the standalone smc.js bot module.
 * Uses ConfigService for tuning parameters.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModeConfig } from '../config/app-config.service';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Candle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface StructureEvent {
  index: number;
  price: number;
  type: 'BOS' | 'CHoCH';
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  time: string;
}

export interface OrderBlock {
  type: 'BULLISH_OB' | 'BEARISH_OB';
  high: number;
  low: number;
  mid: number;
  time: string;
  index: number;
  strength: number;
  mitigated: boolean;
  broken: boolean;
}

export interface FVG {
  type: 'BULLISH_FVG' | 'BEARISH_FVG';
  high: number;
  low: number;
  mid: number;
  time: string;
  index: number;
  filled: boolean;
  fillPct: number;
}

export interface LiquiditySweep {
  type: 'equal_highs' | 'equal_lows' | 'swing_high' | 'swing_low';
  price: number;
  index: number;
  time: string;
  swept: boolean;
}

export interface PremiumDiscount {
  zone: 'premium' | 'discount' | 'equilibrium';
  pct: number;
  swingHigh: number;
  swingLow: number;
  equilibrium: number;
}

export interface SMCSignal {
  direction: 'BUY' | 'SELL';
  bias: 'BULLISH' | 'BEARISH';
  entryPrice: number;
  sl: number;
  tp: number;
  rr: number;
  confidence: number;
  reasons: string[];
  ob: OrderBlock | null;
  fvg: FVG | null;
  structure: StructureEvent | null;
  sweep: LiquiditySweep | null;
}

// ─── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class SmcService {
  private readonly logger = new Logger(SmcService.name);

  constructor(private readonly config: ConfigService) {}

  private get obThreshold(): number {
    return parseFloat(this.config.get<string>('OB_THRESHOLD', '0.6'));
  }
  private get fvgMinGap(): number {
    return parseFloat(this.config.get<string>('FVG_MIN_GAP', '0.5'));
  }
  private get liqPips(): number {
    return parseFloat(this.config.get<string>('LIQ_PIPS', '0.5'));
  }
  private get minRR(): number {
    return parseFloat(this.config.get<string>('MIN_RR', '2'));
  }
  private get confidenceThreshold(): number {
    return parseFloat(this.config.get<string>('CONFIDENCE_THRESHOLD', '60'));
  }
  /** Set SKIP_OB_FVG_GATE=true in .env to bypass the OB/FVG touch requirement (testing only) */
  private get skipObFvgGate(): boolean {
    return this.config.get<string>('SKIP_OB_FVG_GATE', 'false') === 'true';
  }
  /** Set SKIP_ZONE_CHECK=true in .env to bypass premium/discount zone requirement (testing only) */
  private get skipZoneCheck(): boolean {
    return this.config.get<string>('SKIP_ZONE_CHECK', 'false') === 'true';
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private atr(candles: Candle[], period = 14): number {
    const trs = candles.map((c, i) => {
      if (i === 0) return c.high - c.low;
      const prev = candles[i - 1].close;
      return Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
    });
    const recent = trs.slice(-period);
    return recent.reduce((a, b) => a + b, 0) / recent.length;
  }

  private swingHighs(candles: Candle[], n = 3): number[] {
    const out: number[] = [];
    for (let i = n; i < candles.length - n; i++) {
      const slice = candles.slice(i - n, i + n + 1).map(c => c.high);
      if (candles[i].high === Math.max(...slice)) out.push(i);
    }
    return out;
  }

  private swingLows(candles: Candle[], n = 3): number[] {
    const out: number[] = [];
    for (let i = n; i < candles.length - n; i++) {
      const slice = candles.slice(i - n, i + n + 1).map(c => c.low);
      if (candles[i].low === Math.min(...slice)) out.push(i);
    }
    return out;
  }

  // ─── 1. Market Structure ──────────────────────────────────────────────────

  detectStructure(
    candles: Candle[],
    existingBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' = 'NEUTRAL',
  ): StructureEvent[] {
    const shs = this.swingHighs(candles);
    const sls = this.swingLows(candles);
    if (shs.length < 2 || sls.length < 2) return [];

    const results: StructureEvent[] = [];
    let lastSH = candles[shs[shs.length - 2]].high;
    let lastSL = candles[sls[sls.length - 2]].low;

    const startIdx = Math.max(shs[shs.length - 2], sls[sls.length - 2]) + 1;
    for (let i = startIdx; i < candles.length; i++) {
      const c = candles[i];
      if (c.close > lastSH) {
        const type = existingBias === 'BULLISH' ? 'BOS' : 'CHoCH';
        results.push({ index: i, price: lastSH, type, bias: 'BULLISH', time: c.time });
        lastSH = c.high;
      } else if (c.close < lastSL) {
        const type = existingBias === 'BEARISH' ? 'BOS' : 'CHoCH';
        results.push({ index: i, price: lastSL, type, bias: 'BEARISH', time: c.time });
        lastSL = c.low;
      }
    }
    return results;
  }

  getHTFBias(htfCandles: Candle[]): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
    const structs = this.detectStructure(htfCandles);
    if (!structs.length) return 'NEUTRAL';
    const recent = structs.slice(-6);
    const bulls = recent.filter(s => s.bias === 'BULLISH').length;
    const bears = recent.filter(s => s.bias === 'BEARISH').length;
    if (bulls > bears) return 'BULLISH';
    if (bears > bulls) return 'BEARISH';
    // Equal count: use the MOST RECENT structure event as tiebreaker instead of
    // blocking all trades. A 3/3 split with the last event bullish still has
    // bullish momentum — better to trade it with lower confidence than skip it.
    return structs[structs.length - 1].bias;
  }

  // ─── 2. Order Blocks ──────────────────────────────────────────────────────

  detectOrderBlocks(candles: Candle[]): OrderBlock[] {
    const A = this.atr(candles);
    const obs: OrderBlock[] = [];
    const threshold = this.obThreshold;

    for (let i = 1; i < candles.length - 3; i++) {
      const c = candles[i];
      const bodySize = Math.abs(c.close - c.open);
      const range = c.high - c.low || 0.001;
      if (bodySize / range < threshold) continue;

      const ahead = candles.slice(i + 1, i + 4);

      if (c.close < c.open) {
        const impulseHigh = Math.max(...ahead.map(x => x.high));
        if (impulseHigh > c.high + A) {
          const strength = Math.min(3, (impulseHigh - c.high) / A);
          obs.push({
            type: 'BULLISH_OB', high: c.high, low: c.low,
            mid: (c.high + c.low) / 2, time: c.time, index: i,
            strength: +strength.toFixed(2), mitigated: false, broken: false,
          });
        }
      } else if (c.close > c.open) {
        const impulseLow = Math.min(...ahead.map(x => x.low));
        if (impulseLow < c.low - A) {
          const strength = Math.min(3, (c.low - impulseLow) / A);
          obs.push({
            type: 'BEARISH_OB', high: c.high, low: c.low,
            mid: (c.high + c.low) / 2, time: c.time, index: i,
            strength: +strength.toFixed(2), mitigated: false, broken: false,
          });
        }
      }
    }

    for (const ob of obs) {
      const future = candles.slice(ob.index + 1);
      if (ob.type === 'BULLISH_OB') {
        ob.mitigated = future.some(c => c.low <= ob.high);
        ob.broken    = future.some(c => c.close < ob.low);
      } else {
        ob.mitigated = future.some(c => c.high >= ob.low);
        ob.broken    = future.some(c => c.close > ob.high);
      }
    }

    return obs.filter(ob => !ob.broken);
  }

  // ─── 3. Fair Value Gaps ───────────────────────────────────────────────────

  detectFVGs(candles: Candle[]): FVG[] {
    const fvgs: FVG[] = [];
    const minGap = this.fvgMinGap;

    for (let i = 1; i < candles.length - 1; i++) {
      const prev = candles[i - 1];
      const next = candles[i + 1];

      if (next.low > prev.high && (next.low - prev.high) >= minGap) {
        fvgs.push({
          type: 'BULLISH_FVG', high: next.low, low: prev.high,
          mid: (next.low + prev.high) / 2, time: candles[i].time,
          index: i, filled: false, fillPct: 0,
        });
      } else if (prev.low > next.high && (prev.low - next.high) >= minGap) {
        fvgs.push({
          type: 'BEARISH_FVG', high: prev.low, low: next.high,
          mid: (prev.low + next.high) / 2, time: candles[i].time,
          index: i, filled: false, fillPct: 0,
        });
      }
    }

    for (const fvg of fvgs) {
      const future = candles.slice(fvg.index + 2);
      if (fvg.type === 'BULLISH_FVG') {
        const touch = future.find(c => c.low <= fvg.high);
        if (touch) {
          fvg.fillPct = Math.min(100, ((fvg.high - touch.low) / (fvg.high - fvg.low)) * 100);
          fvg.filled  = fvg.fillPct >= 100;
        }
      } else {
        const touch = future.find(c => c.high >= fvg.low);
        if (touch) {
          fvg.fillPct = Math.min(100, ((touch.high - fvg.low) / (fvg.high - fvg.low)) * 100);
          fvg.filled  = fvg.fillPct >= 100;
        }
      }
    }

    return fvgs.filter(f => !f.filled);
  }

  // ─── 4. Liquidity Sweeps ──────────────────────────────────────────────────

  detectLiquiditySweeps(candles: Candle[]): LiquiditySweep[] {
    const shs    = this.swingHighs(candles, 5);
    const sls    = this.swingLows(candles, 5);
    const sweeps: LiquiditySweep[] = [];
    const tol    = this.liqPips;

    for (let i = 0; i < shs.length - 1; i++) {
      const h1 = candles[shs[i]].high;
      const h2 = candles[shs[i + 1]].high;
      if (Math.abs(h1 - h2) <= tol) {
        const future = candles.slice(shs[i + 1] + 1);
        const swept  = future.some(c => c.high > h2 + tol / 2);
        sweeps.push({ type: 'equal_highs', price: h2, index: shs[i + 1], time: candles[shs[i + 1]].time, swept });
      }
    }

    for (let i = 0; i < sls.length - 1; i++) {
      const l1 = candles[sls[i]].low;
      const l2 = candles[sls[i + 1]].low;
      if (Math.abs(l1 - l2) <= tol) {
        const future = candles.slice(sls[i + 1] + 1);
        const swept  = future.some(c => c.low < l2 - tol / 2);
        sweeps.push({ type: 'equal_lows', price: l2, index: sls[i + 1], time: candles[sls[i + 1]].time, swept });
      }
    }

    if (shs.length) {
      const idx   = shs[shs.length - 1];
      const price = candles[idx].high;
      const swept = candles.slice(idx + 1).some(c => c.high > price);
      sweeps.push({ type: 'swing_high', price, index: idx, time: candles[idx].time, swept });
    }

    if (sls.length) {
      const idx   = sls[sls.length - 1];
      const price = candles[idx].low;
      const swept = candles.slice(idx + 1).some(c => c.low < price);
      sweeps.push({ type: 'swing_low', price, index: idx, time: candles[idx].time, swept });
    }

    return sweeps;
  }

  // ─── 5. Premium / Discount ────────────────────────────────────────────────

  premiumDiscount(candles: Candle[]): PremiumDiscount {
    const swingHigh  = Math.max(...candles.map(c => c.high));
    const swingLow   = Math.min(...candles.map(c => c.low));
    const range      = swingHigh - swingLow || 1;
    const current    = candles[candles.length - 1].close;
    const pct        = ((current - swingLow) / range) * 100;
    return {
      zone: pct > 55 ? 'premium' : pct < 45 ? 'discount' : 'equilibrium',
      pct:  +pct.toFixed(1),
      swingHigh,
      swingLow,
      equilibrium: (swingHigh + swingLow) / 2,
    };
  }

  // ─── 6. Main Confluent Analysis ───────────────────────────────────────────

  /**
   * 5-layer top-down SMC analysis — generates 3–5 setups/day on XAUUSD
   *
   *   Layer 1 — D1  : macro bias (BULLISH / BEARISH)
   *   Layer 2 — H4  : intermediate bias + primary OBs/FVGs (MONEY LAYER)
   *   Layer 3 — H1  : BOS / CHoCH structural confirmation
   *   Layer 4 — M15 : entry zone refinement (OB / FVG within H4 zone)
   *   Layer 5 — M5  : precise trigger (liquidity sweep + MSS)
   *
   * H4 OBs are the primary entry zones — they carry the highest weight
   * because institutional players defend 4H order blocks on gold.
   */
  analyze(
    d1Candles:  Candle[],
    h4Candles:  Candle[],   // L2 slot — M30 in QS, H4 in Institutional
    h1Candles:  Candle[],   // L3 slot — M15 in QS, H1 in Institutional
    m15Candles: Candle[],   // L4 slot — M5 in QS, M15 in Institutional
    m5Candles:  Candle[],   // L5 slot — M1 in QS, M5 in Institutional
    modeConfig?: ModeConfig,
  ): SMCSignal | null {
    const price = m5Candles[m5Candles.length - 1].close;

    // Mode-aware internal threshold.
    // The SMC score must exceed this BEFORE confluence runs. Set it low enough
    // that confluence can do its work (add session/EMA/RSI/Fib boosts).
    // Formula: mode.minConfidence − 20, floored at 35.
    // Quick Scalp  (≥58%): SMC gate = 38  — confluece adds the remaining margin
    // Precision    (≥62%): SMC gate = 42
    // Institutional(≥74%): SMC gate = 54
    const threshold = modeConfig
      ? Math.max(modeConfig.minConfidence - 20, 35)
      : this.confidenceThreshold;

    // Mode-aware minimum RR for TP placement.
    // Quick Scalp / Micro Scalp: 1.5 (tighter targets, more frequent fills)
    // Precision / Institutional: 2.0
    const effectiveMinRR = modeConfig?.htfTf === 'H1' ? 1.5 : this.minRR;

    // ── Layer 1: D1 macro bias ───────────────────────────────────────────────
    const htfBias = this.getHTFBias(d1Candles);
    this.logger.log(`SMC | D1 Bias: ${htfBias} | Price: ${price}`);
    if (htfBias === 'NEUTRAL') return null;

    // ── Layer 2: H4 intermediate (PRIMARY ENTRY ZONES) ──────────────────────
    const h4Structs = this.detectStructure(h4Candles, htfBias);
    const h4OBs     = this.detectOrderBlocks(h4Candles);
    const h4FVGs    = this.detectFVGs(h4Candles);
    const h4ATR     = this.atr(h4Candles);
    // ATR of the L4 slot (M5 in QS, M15 in Institutional) — used for M15 OB proximity
    const m15ATR    = this.atr(m15Candles);

    // Zone calculation uses the LAST 40 candles only (not all 200).
    // Using 200 candles in a trending market sets swingHigh to weeks-old extremes —
    // in a 4-day downtrend, price is always at 5-10% of the 200-candle range = "deep
    // discount forever" and the SHORT gate never opens. 40 candles ≈ 20h on M30,
    // 2 days on H1, 7 days on H4 — captures recent swing structure appropriately.
    const ZONE_LOOKBACK = 40;
    const h4Pd = this.premiumDiscount(h4Candles.slice(-ZONE_LOOKBACK));

    this.logger.log(`SMC | H4 Zone: ${h4Pd.zone} (${h4Pd.pct}%) swH=${h4Pd.swingHigh.toFixed(2)} swL=${h4Pd.swingLow.toFixed(2)} | H4 OBs: ${h4OBs.length} | H4 FVGs: ${h4FVGs.length}`);

    // ── Layer 3: H1 structural confirmation ─────────────────────────────────
    const h1Structs     = this.detectStructure(h1Candles, htfBias);
    const h1BullStructs = h1Structs.filter(s => s.bias === 'BULLISH');
    const h1BearStructs = h1Structs.filter(s => s.bias === 'BEARISH');

    // ── Layer 4: M15 setup refinement ───────────────────────────────────────
    const m15OBs  = this.detectOrderBlocks(m15Candles);
    const m15FVGs = this.detectFVGs(m15Candles);
    const m15Pd   = this.premiumDiscount(m15Candles.slice(-ZONE_LOOKBACK));

    // ── Layer 5: M5 trigger ─────────────────────────────────────────────────
    const m5Sweeps = this.detectLiquiditySweeps(m5Candles);

    this.logger.log(`SMC | H1 Bull: ${h1BullStructs.length} Bear: ${h1BearStructs.length} | M15 OBs: ${m15OBs.length} FVGs: ${m15FVGs.length}`);

    // ════════════════════════════════════════════════════════════════════════
    // LONG SETUP
    // ════════════════════════════════════════════════════════════════════════
    if (htfBias === 'BULLISH') {
      // Zone gate: H4 discount OR equilibrium zone is valid for longs.
      // SCALP MODES (htfTf=H1) skip this gate entirely — in trending markets the
      // 40-candle M30 range shows "premium" almost every cycle, permanently blocking
      // BUY signals. Momentum scalps trade WITH the trend from OBs, not against it.
      const isScalpMode = modeConfig?.htfTf === 'H1';
      if (!isScalpMode && h4Pd.zone === 'premium' && !this.skipZoneCheck) {
        this.logger.log(`SMC LONG skip: H4 in premium (need discount or equilibrium)`);
        return null;
      }

      let confidence = 20;
      const reasons: string[] = [`D1 BULLISH Bias`];

      // H4 zone bonus — full bonus for discount (ideal BUY zone), half for equilibrium
      if (h4Pd.zone === 'discount') {
        reasons.push(`H4 Discount Zone (${h4Pd.pct}%)`);
        confidence += 10;
      } else if (h4Pd.zone === 'equilibrium') {
        reasons.push(`H4 Equilibrium (${h4Pd.pct}%) — fair value BUY`);
        confidence += 5;
      }

      // H4 OB proximity — ATR-based, not exact inside-OB.
      // "Within 0.5 ATR of the OB bounds" catches price approaching the zone
      // (the actual entry signal in SMC) not just price already inside it.
      // In QS mode h4ATR is M30 ATR; in Institutional it's true H4 ATR.
      const h4Ob = [...h4OBs].reverse().find(o =>
        o.type === 'BULLISH_OB' &&
        price >= o.low  - h4ATR * 0.5 &&
        price <= o.high + h4ATR * 0.5,
      );
      if (h4Ob) {
        const inside = price >= h4Ob.low && price <= h4Ob.high;
        reasons.push(`H4 Bullish OB ${h4Ob.low.toFixed(2)}–${h4Ob.high.toFixed(2)} str:${h4Ob.strength}${inside ? '' : ' (approaching)'}`);
        confidence += inside ? 25 : 15;  // full bonus if inside, partial if approaching
      }

      // H4 FVG proximity — allow ± 0.3 ATR approach
      const h4Fvg = [...h4FVGs].reverse().find(f =>
        f.type === 'BULLISH_FVG' &&
        price >= f.low  - h4ATR * 0.3 &&
        price <= f.high + h4ATR * 0.3,
      );
      if (h4Fvg) {
        reasons.push(`H4 Bullish FVG ${h4Fvg.low.toFixed(2)}–${h4Fvg.high.toFixed(2)}`);
        confidence += 20;
      }

      // H4 structural alignment
      const h4BullStructs = h4Structs.filter(s => s.bias === 'BULLISH');
      if (h4BullStructs.length) {
        const last = h4BullStructs[h4BullStructs.length - 1];
        reasons.push(`H4 ${last.type} Bullish @ ${last.price.toFixed(2)}`);
        confidence += 15;
      }

      // H1 BOS/CHoCH confirmation
      if (h1BullStructs.length) {
        const last = h1BullStructs[h1BullStructs.length - 1];
        reasons.push(`H1 ${last.type} Bullish @ ${last.price.toFixed(2)}`);
        confidence += 12;
      }

      // M15 OB refinement — ATR-based proximity (m15ATR = L4 slot ATR)
      const m15Ob = [...m15OBs].reverse().find(o =>
        o.type === 'BULLISH_OB' &&
        price >= o.low  - m15ATR * 0.5 &&
        price <= o.high + m15ATR * 0.5,
      );
      if (m15Ob) {
        reasons.push(`M15 Bullish OB ${m15Ob.low.toFixed(2)}–${m15Ob.high.toFixed(2)}`);
        confidence += 8;
      }

      // M15 FVG refinement — ATR-based proximity
      const m15Fvg = [...m15FVGs].reverse().find(f =>
        f.type === 'BULLISH_FVG' &&
        price >= f.low  - m15ATR * 0.3 &&
        price <= f.high + m15ATR * 0.3,
      );
      if (m15Fvg) {
        reasons.push(`M15 Bullish FVG ${m15Fvg.low.toFixed(2)}–${m15Fvg.high.toFixed(2)}`);
        confidence += 6;
      }

      // M5 liquidity sweep (stop hunt confirms smart money entry)
      const sweptLow = m5Sweeps.filter(s =>
        (s.type === 'equal_lows' || s.type === 'swing_low') && s.swept,
      );
      if (sweptLow.length) {
        reasons.push('M5 Stop Hunt: lows swept → reversal imminent');
        confidence += 10;
      }

      // ── Candle body confirmation at zone ─────────────────────────────────
      // In SMC the SETUP candle at an OB is often bearish (stop hunt / liquidity
      // sweep grabs stops below the zone). The CONFIRMATION candle follows 1-2 bars
      // later. So we look at the last 3 entry-TF candles and reward if any of them
      // shows a strong bullish close — but NEVER penalise a bearish candle (it is the
      // expected sweep before the reversal).
      const hasZone = h4Ob || h4Fvg || m15Ob || m15Fvg;
      if (hasZone) {
        const last   = m5Candles[m5Candles.length - 1];
        const prev   = m5Candles[m5Candles.length - 2];
        // Engulfing: last candle closes above prev open AND opens below prev close
        const isEngulfing = prev &&
          last.close > last.open &&
          last.close > prev.open &&
          last.open  < prev.close;
        if (isEngulfing) {
          reasons.push('Bullish engulfing at BUY zone — institutional entry confirmed (+15)');
          confidence += 15;
        } else {
          // Any strong bullish close in the last 3 candles counts as partial confirmation
          const recentBullish = m5Candles.slice(-3).find(c => {
            const r = (c.high - c.low) || 0.0001;
            return c.close > c.open && (c.close - c.open) / r > 0.5;
          });
          if (recentBullish) {
            reasons.push('Bullish candle in last 3 bars at zone — partial confirmation (+8)');
            confidence += 8;
          }
        }
      }

      confidence = Math.min(confidence, 100);
      this.logger.log(`SMC LONG ${confidence}% — ${reasons.join(' | ')}`);

      const gatePass = confidence >= threshold && (hasZone || this.skipObFvgGate);
      if (!gatePass) {
        this.logger.log(`SMC LONG blocked: conf=${confidence}% thresh=${threshold} zone=${!!hasZone} skip=${this.skipObFvgGate}`);
        return null;
      }

      // SL below H4 OB low (prefer H4 over M15 for wider, institution-respected stops)
      const slRef  = h4Ob ? h4Ob.low : m15Ob ? m15Ob.low : (h4Fvg ? h4Fvg.low : price - h4ATR * 1.5);
      const sl     = +(slRef - h4ATR * 0.3).toFixed(2);
      const risk   = price - sl;
      const tp     = +(price + risk * Math.max(effectiveMinRR, effectiveMinRR)).toFixed(2);
      const rr     = +((tp - price) / risk).toFixed(2);

      return {
        direction: 'BUY', bias: 'BULLISH', entryPrice: +price.toFixed(2),
        sl, tp, rr, confidence: +confidence.toFixed(1), reasons,
        ob:        h4Ob  ?? m15Ob  ?? null,
        fvg:       h4Fvg ?? m15Fvg ?? null,
        structure: h4BullStructs[h4BullStructs.length - 1] ?? h1BullStructs[h1BullStructs.length - 1] ?? null,
        sweep:     sweptLow[sweptLow.length - 1] ?? null,
      };
    }

    // ════════════════════════════════════════════════════════════════════════
    // SHORT SETUP
    // ════════════════════════════════════════════════════════════════════════
    if (htfBias === 'BEARISH') {
      // Zone gate: H4 premium OR equilibrium zone is valid for shorts.
      // SCALP MODES (htfTf=H1) skip this gate — in trending markets price is often
      // in "discount" of the recent M30 range, permanently blocking SELL signals.
      const isScalpMode = modeConfig?.htfTf === 'H1';
      if (!isScalpMode && h4Pd.zone === 'discount' && !this.skipZoneCheck) {
        this.logger.log(`SMC SHORT skip: H4 in discount (need premium or equilibrium)`);
        return null;
      }

      let confidence = 20;
      const reasons: string[] = [`D1 BEARISH Bias`];

      // H4 zone bonus — full bonus for premium (ideal SELL zone), half for equilibrium
      if (h4Pd.zone === 'premium') {
        reasons.push(`H4 Premium Zone (${h4Pd.pct}%)`);
        confidence += 10;
      } else if (h4Pd.zone === 'equilibrium') {
        reasons.push(`H4 Equilibrium (${h4Pd.pct}%) — fair value SELL`);
        confidence += 5;
      }

      const h4Ob = [...h4OBs].reverse().find(o =>
        o.type === 'BEARISH_OB' &&
        price >= o.low  - h4ATR * 0.5 &&
        price <= o.high + h4ATR * 0.5,
      );
      if (h4Ob) {
        const inside = price >= h4Ob.low && price <= h4Ob.high;
        reasons.push(`H4 Bearish OB ${h4Ob.low.toFixed(2)}–${h4Ob.high.toFixed(2)} str:${h4Ob.strength}${inside ? '' : ' (approaching)'}`);
        confidence += inside ? 25 : 15;
      }

      const h4Fvg = [...h4FVGs].reverse().find(f =>
        f.type === 'BEARISH_FVG' &&
        price >= f.low  - h4ATR * 0.3 &&
        price <= f.high + h4ATR * 0.3,
      );
      if (h4Fvg) {
        reasons.push(`H4 Bearish FVG ${h4Fvg.low.toFixed(2)}–${h4Fvg.high.toFixed(2)}`);
        confidence += 20;
      }

      const h4BearStructs = h4Structs.filter(s => s.bias === 'BEARISH');
      if (h4BearStructs.length) {
        const last = h4BearStructs[h4BearStructs.length - 1];
        reasons.push(`H4 ${last.type} Bearish @ ${last.price.toFixed(2)}`);
        confidence += 15;
      }

      if (h1BearStructs.length) {
        const last = h1BearStructs[h1BearStructs.length - 1];
        reasons.push(`H1 ${last.type} Bearish @ ${last.price.toFixed(2)}`);
        confidence += 12;
      }

      const m15Ob = [...m15OBs].reverse().find(o =>
        o.type === 'BEARISH_OB' &&
        price >= o.low  - m15ATR * 0.5 &&
        price <= o.high + m15ATR * 0.5,
      );
      if (m15Ob) {
        reasons.push(`M15 Bearish OB ${m15Ob.low.toFixed(2)}–${m15Ob.high.toFixed(2)}`);
        confidence += 8;
      }

      const m15Fvg = [...m15FVGs].reverse().find(f =>
        f.type === 'BEARISH_FVG' &&
        price >= f.low  - m15ATR * 0.3 &&
        price <= f.high + m15ATR * 0.3,
      );
      if (m15Fvg) {
        reasons.push(`M15 Bearish FVG ${m15Fvg.low.toFixed(2)}–${m15Fvg.high.toFixed(2)}`);
        confidence += 6;
      }

      const sweptHigh = m5Sweeps.filter(s =>
        (s.type === 'equal_highs' || s.type === 'swing_high') && s.swept,
      );
      if (sweptHigh.length) {
        reasons.push('M5 Stop Hunt: highs swept → reversal imminent');
        confidence += 10;
      }

      // ── Candle body confirmation at zone ─────────────────────────────────
      // SELL equivalent: the setup candle at a bearish OB is often bullish (stop hunt
      // sweeps highs before the drop). Look at last 3 candles, reward confirmation,
      // never penalise the sweep candle.
      const hasZone = h4Ob || h4Fvg || m15Ob || m15Fvg;
      if (hasZone) {
        const last = m5Candles[m5Candles.length - 1];
        const prev = m5Candles[m5Candles.length - 2];
        const isBearishEngulfing = prev &&
          last.close < last.open &&
          last.close < prev.open &&
          last.open  > prev.close;
        if (isBearishEngulfing) {
          reasons.push('Bearish engulfing at SELL zone — institutional rejection confirmed (+15)');
          confidence += 15;
        } else {
          const recentBearish = m5Candles.slice(-3).find(c => {
            const r = (c.high - c.low) || 0.0001;
            return c.close < c.open && (c.open - c.close) / r > 0.5;
          });
          if (recentBearish) {
            reasons.push('Bearish candle in last 3 bars at zone — partial confirmation (+8)');
            confidence += 8;
          }
        }
      }

      confidence = Math.min(confidence, 100);
      this.logger.log(`SMC SHORT ${confidence}% — ${reasons.join(' | ')}`);

      const gatePass = confidence >= threshold && (hasZone || this.skipObFvgGate);
      if (!gatePass) {
        this.logger.log(`SMC SHORT blocked: conf=${confidence}% thresh=${threshold} zone=${!!hasZone} skip=${this.skipObFvgGate}`);
        return null;
      }

      const slRef = h4Ob ? h4Ob.high : m15Ob ? m15Ob.high : (h4Fvg ? h4Fvg.high : price + h4ATR * 1.5);
      const sl    = +(slRef + h4ATR * 0.3).toFixed(2);
      const risk  = sl - price;
      const tp    = +(price - risk * effectiveMinRR).toFixed(2);
      const rr    = +((price - tp) / risk).toFixed(2);

      return {
        direction: 'SELL', bias: 'BEARISH', entryPrice: +price.toFixed(2),
        sl, tp, rr, confidence: +confidence.toFixed(1), reasons,
        ob:        h4Ob  ?? m15Ob  ?? null,
        fvg:       h4Fvg ?? m15Fvg ?? null,
        structure: h4BearStructs[h4BearStructs.length - 1] ?? h1BearStructs[h1BearStructs.length - 1] ?? null,
        sweep:     sweptHigh[sweptHigh.length - 1] ?? null,
      };
    }

    return null;
  }
}
