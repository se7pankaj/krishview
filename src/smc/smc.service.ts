/**
 * smc/smc.service.ts — Smart Money Concepts Analysis Engine
 * ==========================================================
 * NestJS port of the standalone smc.js bot module.
 * Uses ConfigService for tuning parameters.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

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
    return 'NEUTRAL';
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
   * 4-layer top-down SMC analysis:
   *   d1Candles  — macro direction / bias
   *   h1Candles  — structural confirmation (BOS / CHoCH) — PRIORITY
   *   m15Candles — setup confirmation (FVG / OB zone identification)
   *   m5Candles  — entry timing (precise trigger)
   */
  analyze(
    d1Candles:  Candle[],
    h1Candles:  Candle[],
    m15Candles: Candle[],
    m5Candles:  Candle[],
  ): SMCSignal | null {
    // Layer 1: D1 macro bias
    const htfBias = this.getHTFBias(d1Candles);
    this.logger.log(`SMC | D1 Bias: ${htfBias}`);
    if (htfBias === 'NEUTRAL') return null;

    // Layer 2: H1 structural confirmation — must agree with D1 bias
    const h1Structs = this.detectStructure(h1Candles, htfBias);
    const h1BullStructs = h1Structs.filter(s => s.bias === 'BULLISH');
    const h1BearStructs = h1Structs.filter(s => s.bias === 'BEARISH');

    // Layer 3: M15 setup — OB / FVG identification + premium/discount
    const m15OBs   = this.detectOrderBlocks(m15Candles);
    const m15FVGs  = this.detectFVGs(m15Candles);
    const m15Pd    = this.premiumDiscount(m15Candles);
    const m15ATR   = this.atr(m15Candles);

    // Layer 4: M5 entry trigger — price, sweeps
    const m5Sweeps = this.detectLiquiditySweeps(m5Candles);
    const price    = m5Candles[m5Candles.length - 1].close;

    this.logger.log(`SMC | M15 PD Zone: ${m15Pd.zone} (${m15Pd.pct}%) | ATR: ${m15ATR.toFixed(2)}`);
    this.logger.log(`SMC | H1 BullStructs: ${h1BullStructs.length} | H1 BearStructs: ${h1BearStructs.length}`);
    this.logger.log(`SMC | M15 OBs: ${m15OBs.length} | M15 FVGs: ${m15FVGs.length} | M5 Sweeps: ${m5Sweeps.length}`);

    let confidence = 30;
    const reasons: string[] = [`D1 ${htfBias} Bias`];
    const minRR    = this.minRR;
    const threshold = this.confidenceThreshold;

    // ── LONG ────────────────────────────────────────────────────────────────
    if (htfBias === 'BULLISH') {
      if (m15Pd.zone !== 'discount') {
        this.logger.log(`SMC LONG skip: M15 price in ${m15Pd.zone} zone`);
        return null;
      }
      reasons.push(`M15 Discount Zone (${m15Pd.pct}%)`);
      confidence += 15;

      // H1 BOS / CHoCH confirmation (PRIORITY layer)
      if (h1BullStructs.length) {
        const last = h1BullStructs[h1BullStructs.length - 1];
        reasons.push(`H1 ${last.type} Bullish confirmed @ ${last.price}`);
        confidence += 25;  // H1 confirmation carries extra weight
      } else {
        this.logger.log('SMC LONG: no H1 bullish structure — lower confidence');
        confidence -= 10;
      }

      // M15 Order Block touch
      const ob = [...m15OBs].reverse().find(o =>
        o.type === 'BULLISH_OB' && price >= o.low && price <= o.high * 1.003,
      );
      if (ob) {
        reasons.push(`M15 Bullish OB ${ob.low.toFixed(2)}–${ob.high.toFixed(2)} str:${ob.strength}`);
        confidence += 15 * ob.strength;
      }

      // M15 FVG fill
      const fvg = [...m15FVGs].reverse().find(f =>
        f.type === 'BULLISH_FVG' && price >= f.low && price <= f.high,
      );
      if (fvg) {
        reasons.push(`M15 Bullish FVG ${fvg.low.toFixed(2)}–${fvg.high.toFixed(2)}`);
        confidence += 10;
      }

      // M5 liquidity sweep trigger
      const swept = m5Sweeps.filter(s =>
        (s.type === 'equal_lows' || s.type === 'swing_low') && s.swept,
      );
      if (swept.length) {
        reasons.push('M5 Liquidity swept below (stop hunt complete)');
        confidence += 10;
      }

      confidence = Math.min(confidence, 100);
      this.logger.log(`SMC LONG confidence: ${confidence}% — ${reasons.join(' | ')}`);

      if (confidence >= threshold && (ob || fvg)) {
        const slBase = ob ? ob.low : (fvg ? fvg.low : price - m15ATR * 2);
        const sl     = +(slBase - m15ATR * 0.5).toFixed(2);
        const risk   = price - sl;
        const tp     = +(price + risk * Math.max(minRR, 2)).toFixed(2);
        const rr     = +((tp - price) / (price - sl)).toFixed(2);
        return {
          direction: 'BUY', bias: 'BULLISH', entryPrice: +price.toFixed(2),
          sl, tp, rr, confidence: +confidence.toFixed(1), reasons,
          ob: ob ?? null, fvg: fvg ?? null,
          structure: h1BullStructs[h1BullStructs.length - 1] ?? null,
          sweep: swept[swept.length - 1] ?? null,
        };
      }
    }

    // ── SHORT ───────────────────────────────────────────────────────────────
    if (htfBias === 'BEARISH') {
      if (m15Pd.zone !== 'premium') {
        this.logger.log(`SMC SHORT skip: M15 price in ${m15Pd.zone} zone`);
        return null;
      }
      reasons.push(`M15 Premium Zone (${m15Pd.pct}%)`);
      confidence += 15;

      // H1 BOS / CHoCH confirmation (PRIORITY layer)
      if (h1BearStructs.length) {
        const last = h1BearStructs[h1BearStructs.length - 1];
        reasons.push(`H1 ${last.type} Bearish confirmed @ ${last.price}`);
        confidence += 25;
      } else {
        this.logger.log('SMC SHORT: no H1 bearish structure — lower confidence');
        confidence -= 10;
      }

      // M15 Order Block touch
      const ob = [...m15OBs].reverse().find(o =>
        o.type === 'BEARISH_OB' && price >= o.low && price <= o.high * 1.003,
      );
      if (ob) {
        reasons.push(`M15 Bearish OB ${ob.low.toFixed(2)}–${ob.high.toFixed(2)} str:${ob.strength}`);
        confidence += 15 * ob.strength;
      }

      // M15 FVG fill
      const fvg = [...m15FVGs].reverse().find(f =>
        f.type === 'BEARISH_FVG' && price >= f.low && price <= f.high,
      );
      if (fvg) {
        reasons.push(`M15 Bearish FVG ${fvg.low.toFixed(2)}–${fvg.high.toFixed(2)}`);
        confidence += 10;
      }

      // M5 liquidity sweep trigger
      const swept = m5Sweeps.filter(s =>
        (s.type === 'equal_highs' || s.type === 'swing_high') && s.swept,
      );
      if (swept.length) {
        reasons.push('M5 Liquidity swept above (stop hunt complete)');
        confidence += 10;
      }

      confidence = Math.min(confidence, 100);
      this.logger.log(`SMC SHORT confidence: ${confidence}% — ${reasons.join(' | ')}`);

      if (confidence >= threshold && (ob || fvg)) {
        const slBase = ob ? ob.high : (fvg ? fvg.high : price + m15ATR * 2);
        const sl     = +(slBase + m15ATR * 0.5).toFixed(2);
        const risk   = sl - price;
        const tp     = +(price - risk * Math.max(minRR, 2)).toFixed(2);
        const rr     = +((price - tp) / (sl - price)).toFixed(2);
        return {
          direction: 'SELL', bias: 'BEARISH', entryPrice: +price.toFixed(2),
          sl, tp, rr, confidence: +confidence.toFixed(1), reasons,
          ob: ob ?? null, fvg: fvg ?? null,
          structure: h1BearStructs[h1BearStructs.length - 1] ?? null,
          sweep: swept[swept.length - 1] ?? null,
        };
      }
    }

    return null;
  }
}
