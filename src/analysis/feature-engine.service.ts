/**
 * analysis/feature-engine.service.ts — Technical Feature Engine
 * ==============================================================
 * Computes structured market features from raw OHLCV candles.
 * Output feeds directly into the GPT-4 structured prompt.
 *
 * Features computed:
 *   • EMA 20 / 50 / 200 + alignment
 *   • RSI(14) + zone + divergence flag
 *   • ATR(14)
 *   • Fibonacci retracement levels + current zone
 *   • Multi-timeframe trend summary
 */

import { Injectable } from '@nestjs/common';
import { Candle, SmcService, SMCSignal } from '../smc/smc.service';

// ─── Output Types ─────────────────────────────────────────────────────────────

export interface TrendFeatures {
  ema20: number;
  ema50: number;
  ema200: number;
  /** All three EMAs stacked in same direction */
  aligned: boolean;
  /** 'bullish' | 'bearish' | 'neutral' */
  direction: 'bullish' | 'bearish' | 'neutral';
  /** Current price vs EMA200 in ATR units */
  ema200Distance: number;
}

export interface MomentumFeatures {
  rsi: number;
  /** 'overbought' >70 | 'oversold' <30 | 'neutral' */
  rsiZone: 'overbought' | 'oversold' | 'neutral';
  /** Bullish divergence: price lower low, RSI higher low */
  bullishDivergence: boolean;
  /** Bearish divergence: price higher high, RSI lower high */
  bearishDivergence: boolean;
  atr: number;
}

export interface FibonacciFeatures {
  swingHigh: number;
  swingLow: number;
  level0:    number;   // 0%
  level236:  number;   // 23.6%
  level382:  number;   // 38.2%
  level500:  number;   // 50%
  level618:  number;   // 61.8%
  level786:  number;   // 78.6%
  level100:  number;   // 100%
  /** Which Fib zone current price is in */
  currentZone: string;
}

export interface FeatureSet {
  symbol:    string;
  timestamp: string;
  price:     number;
  htfTrend:  TrendFeatures;
  ltfTrend:  TrendFeatures;
  momentum:  MomentumFeatures;
  fibonacci: FibonacciFeatures;
  smc: {
    bias:         string;
    bos:          boolean;
    choch:        boolean;
    obPresent:    boolean;
    obHigh:       number | null;
    obLow:        number | null;
    fvgPresent:   boolean;
    fvgHigh:      number | null;
    fvgLow:       number | null;
    liquiditySwept: boolean;
    zone:         string;
    zonePct:      number;
  };
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class FeatureEngineService {
  constructor(private readonly smcService: SmcService) {}

  // ─── EMA ──────────────────────────────────────────────────────────────────

  computeEMA(candles: Candle[], period: number): number {
    if (candles.length < period) return candles[candles.length - 1].close;
    const k = 2 / (period + 1);
    let ema = candles.slice(0, period).reduce((s, c) => s + c.close, 0) / period;
    for (let i = period; i < candles.length; i++) {
      ema = candles[i].close * k + ema * (1 - k);
    }
    return +ema.toFixed(4);
  }

  computeTrend(candles: Candle[], atr: number): TrendFeatures {
    const price = candles[candles.length - 1].close;
    const ema20  = this.computeEMA(candles, 20);
    const ema50  = this.computeEMA(candles, 50);
    const ema200 = this.computeEMA(candles, 200);

    const bullAligned = ema20 > ema50 && ema50 > ema200;
    const bearAligned = ema20 < ema50 && ema50 < ema200;
    const aligned     = bullAligned || bearAligned;

    let direction: 'bullish' | 'bearish' | 'neutral' = 'neutral';
    if (price > ema20 && bullAligned) direction = 'bullish';
    else if (price < ema20 && bearAligned) direction = 'bearish';

    return {
      ema20, ema50, ema200, aligned, direction,
      ema200Distance: atr > 0 ? +((price - ema200) / atr).toFixed(2) : 0,
    };
  }

  // ─── RSI ──────────────────────────────────────────────────────────────────

  computeRSI(candles: Candle[], period = 14): number {
    if (candles.length < period + 1) return 50;

    const changes = candles.map((c, i) =>
      i === 0 ? 0 : c.close - candles[i - 1].close,
    );

    let avgGain = changes.slice(1, period + 1).filter(c => c > 0).reduce((s, c) => s + c, 0) / period;
    let avgLoss = changes.slice(1, period + 1).filter(c => c < 0).reduce((s, c) => s + Math.abs(c), 0) / period;

    for (let i = period + 1; i < changes.length; i++) {
      const gain = Math.max(0, changes[i]);
      const loss = Math.abs(Math.min(0, changes[i]));
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }

    if (avgLoss === 0) return 100;
    const rs  = avgGain / avgLoss;
    return +(100 - 100 / (1 + rs)).toFixed(2);
  }

  computeMomentum(candles: Candle[]): MomentumFeatures {
    const rsi = this.computeRSI(candles, 14);
    const atr = this.computeATR(candles, 14);

    const rsiZone: MomentumFeatures['rsiZone'] =
      rsi > 70 ? 'overbought' : rsi < 30 ? 'oversold' : 'neutral';

    // Divergence: compare last 10 candles
    const recent    = candles.slice(-10);
    const rsiValues = this.computeRSISeries(recent, 5);

    const priceLL  = recent[recent.length - 1].low < Math.min(...recent.slice(0, -1).map(c => c.low));
    const rsiHL    = rsiValues[rsiValues.length - 1] > Math.max(...rsiValues.slice(0, -1));
    const bullishDivergence = priceLL && rsiHL;

    const priceHH  = recent[recent.length - 1].high > Math.max(...recent.slice(0, -1).map(c => c.high));
    const rsiLH    = rsiValues[rsiValues.length - 1] < Math.min(...rsiValues.slice(0, -1));
    const bearishDivergence = priceHH && rsiLH;

    return { rsi, rsiZone, bullishDivergence, bearishDivergence, atr };
  }

  private computeRSISeries(candles: Candle[], period: number): number[] {
    return candles.map((_, i) => {
      if (i < period) return 50;
      return this.computeRSI(candles.slice(0, i + 1), period);
    });
  }

  // ─── ATR ──────────────────────────────────────────────────────────────────

  computeATR(candles: Candle[], period = 14): number {
    const trs = candles.map((c, i) => {
      if (i === 0) return c.high - c.low;
      const prev = candles[i - 1].close;
      return Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
    });
    const recent = trs.slice(-period);
    return +(recent.reduce((a, b) => a + b, 0) / recent.length).toFixed(4);
  }

  // ─── Fibonacci ────────────────────────────────────────────────────────────

  computeFibonacci(candles: Candle[]): FibonacciFeatures {
    const swingHigh = Math.max(...candles.map(c => c.high));
    const swingLow  = Math.min(...candles.map(c => c.low));
    const range     = swingHigh - swingLow;
    const price     = candles[candles.length - 1].close;

    const level = (r: number) => +(swingLow + range * r).toFixed(4);
    const pct   = range > 0 ? (price - swingLow) / range : 0.5;

    const currentZone =
      pct < 0      ? 'below-range'  :
      pct < 0.236  ? '0-23.6%'      :
      pct < 0.382  ? '23.6-38.2%'   :
      pct < 0.500  ? '38.2-50%'     :
      pct < 0.618  ? '50-61.8%'     :
      pct < 0.786  ? '61.8-78.6%'   :
      pct <= 1.000 ? '78.6-100%'    : 'above-range';

    return {
      swingHigh, swingLow,
      level0:   level(0),
      level236: level(0.236),
      level382: level(0.382),
      level500: level(0.5),
      level618: level(0.618),
      level786: level(0.786),
      level100: level(1),
      currentZone,
    };
  }

  // ─── Full Feature Set ─────────────────────────────────────────────────────

  compute(
    htfCandles: Candle[],
    ltfCandles: Candle[],
    signal: SMCSignal | null,
    symbol: string,
  ): FeatureSet {
    const ltfATR  = this.computeATR(ltfCandles);
    const htfATR  = this.computeATR(htfCandles);
    const price   = ltfCandles[ltfCandles.length - 1].close;

    const htfBias = this.smcService.getHTFBias(htfCandles);
    const pd      = this.smcService.premiumDiscount(ltfCandles);
    const ltfStructs = this.smcService.detectStructure(ltfCandles);
    const hasBOS  = ltfStructs.some(s => s.type === 'BOS');
    const hasCHoCH = ltfStructs.some(s => s.type === 'CHoCH');
    const sweeps  = this.smcService.detectLiquiditySweeps(ltfCandles);
    const liquiditySwept = sweeps.some(s => s.swept);

    return {
      symbol,
      timestamp: new Date().toISOString(),
      price,
      htfTrend:  this.computeTrend(htfCandles, htfATR),
      ltfTrend:  this.computeTrend(ltfCandles, ltfATR),
      momentum:  this.computeMomentum(ltfCandles),
      fibonacci: this.computeFibonacci(ltfCandles),
      smc: {
        bias:           htfBias,
        bos:            hasBOS,
        choch:          hasCHoCH,
        obPresent:      !!signal?.ob,
        obHigh:         signal?.ob?.high ?? null,
        obLow:          signal?.ob?.low ?? null,
        fvgPresent:     !!signal?.fvg,
        fvgHigh:        signal?.fvg?.high ?? null,
        fvgLow:         signal?.fvg?.low ?? null,
        liquiditySwept,
        zone:           pd.zone,
        zonePct:        pd.pct,
      },
    };
  }
}
