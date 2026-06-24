/**
 * analysis/feature-engine.service.ts — Technical Feature Engine
 * ==============================================================
 * Computes structured market features from raw OHLCV candles.
 * Output feeds directly into the Claude Sonnet structured prompt.
 *
 * 5-layer top-down analysis:
 *   D1  → Macro Direction (HTF bias) + PDH/PDL
 *   H4  → Intermediate Bias + Primary OBs/FVGs (money layer)
 *   H1  → Structural Confirmation (BOS / CHoCH)
 *   M15 → Setup Refinement (FVG / OB within H4 zone)
 *   M5  → Entry Timing (liquidity sweep + MSS trigger)
 *
 * Features computed:
 *   • EMA 20 / 50 / 200 + alignment + EMA200 distance (ATR units)
 *   • RSI(14) + zone + slope + divergence
 *   • ATR(14), Fibonacci retracement
 *   • PDH / PDL / PDC (Previous Day High/Low/Close)
 *   • Killzone detection (London / New York)
 *   • H4 OBs + FVGs as primary entry zones
 */

import { Injectable } from '@nestjs/common';
import { Candle, SmcService, SMCSignal, StructureEvent } from '../smc/smc.service';

// ─── Output Types ─────────────────────────────────────────────────────────────

export interface TrendFeatures {
  ema20:  number;
  ema50:  number;
  ema200: number;
  /** All three EMAs stacked in same direction */
  aligned: boolean;
  /** 'bullish' | 'bearish' | 'neutral' */
  direction: 'bullish' | 'bearish' | 'neutral';
  /** Current price vs EMA200 in ATR units */
  ema200Distance: number;
}

export interface MomentumFeatures {
  rsi:     number;
  /** 'overbought' >70 | 'oversold' <30 | 'neutral' */
  rsiZone: 'overbought' | 'oversold' | 'neutral';
  /** RSI slope over last 5 periods — momentum acceleration / deceleration */
  rsiTrend: 'rising' | 'falling' | 'flat';
  /** Bullish divergence: price lower low, RSI higher low */
  bullishDivergence: boolean;
  /** Bearish divergence: price higher high, RSI lower high */
  bearishDivergence: boolean;
  atr: number;
}

export interface FibonacciFeatures {
  swingHigh: number;
  swingLow:  number;
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

  // ── 5-layer trend ──────────────────────────────────────────────────────────
  /** D1 — Macro Direction */
  d1Trend:  TrendFeatures;
  /** H4 — Intermediate Bias (money layer) */
  h4Trend:  TrendFeatures;
  /** H1 — Structural Confirmation */
  h1Trend:  TrendFeatures;
  /** M15 — Setup Refinement */
  m15Trend: TrendFeatures;
  /** M5 — Entry Timing */
  m5Trend:  TrendFeatures;

  // ── Previous Day Levels ────────────────────────────────────────────────────
  pdh: number;   // Previous Day High
  pdl: number;   // Previous Day Low
  pdc: number;   // Previous Day Close

  // ── Killzone ───────────────────────────────────────────────────────────────
  inKillzone:   boolean;
  killzoneName: 'London' | 'New York' | 'None';

  momentum:  MomentumFeatures;
  fibonacci: FibonacciFeatures;

  smc: {
    bias:             string;
    // H4 primary entry zones
    h4ObPresent:      boolean;
    h4ObHigh:         number | null;
    h4ObLow:          number | null;
    h4FvgPresent:     boolean;
    h4FvgHigh:        number | null;
    h4FvgLow:         number | null;
    h4Zone:           string;
    h4ZonePct:        number;
    // H1 structural confirmation
    bos:              boolean;
    choch:            boolean;
    lastBosDirection: 'bullish' | 'bearish' | null;
    lastSwingHigh:    number | null;
    lastSwingLow:     number | null;
    // M15 setup refinement
    obPresent:        boolean;
    obHigh:           number | null;
    obLow:            number | null;
    fvgPresent:       boolean;
    fvgHigh:          number | null;
    fvgLow:           number | null;
    liquiditySwept:   boolean;
    zone:             string;
    zonePct:          number;
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
    const price  = candles[candles.length - 1].close;
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
    const rs = avgGain / avgLoss;
    return +(100 - 100 / (1 + rs)).toFixed(2);
  }

  private computeRSISeries(candles: Candle[], period: number): number[] {
    return candles.map((_, i) => {
      if (i < period) return 50;
      return this.computeRSI(candles.slice(0, i + 1), period);
    });
  }

  computeMomentum(candles: Candle[]): MomentumFeatures {
    const rsi = this.computeRSI(candles, 14);
    const atr = this.computeATR(candles, 14);

    const rsiZone: MomentumFeatures['rsiZone'] =
      rsi > 70 ? 'overbought' : rsi < 30 ? 'oversold' : 'neutral';

    // RSI slope over last 5 periods (doc §10.2)
    const rsiSeries = this.computeRSISeries(candles.slice(-10), 5);
    const rsiFirst  = rsiSeries[rsiSeries.length - 5] ?? rsiSeries[0];
    const rsiLast   = rsiSeries[rsiSeries.length - 1];
    const rsiDelta  = rsiLast - rsiFirst;
    const rsiTrend: MomentumFeatures['rsiTrend'] =
      rsiDelta > 2 ? 'rising' : rsiDelta < -2 ? 'falling' : 'flat';

    // Divergence: compare last 10 candles
    const recent    = candles.slice(-10);
    const rsiValues = this.computeRSISeries(recent, 5);

    const priceLL = recent[recent.length - 1].low < Math.min(...recent.slice(0, -1).map(c => c.low));
    const rsiHL   = rsiValues[rsiValues.length - 1] > Math.max(...rsiValues.slice(0, -1));
    const bullishDivergence = priceLL && rsiHL;

    const priceHH = recent[recent.length - 1].high > Math.max(...recent.slice(0, -1).map(c => c.high));
    const rsiLH   = rsiValues[rsiValues.length - 1] < Math.min(...rsiValues.slice(0, -1));
    const bearishDivergence = priceHH && rsiLH;

    return { rsi, rsiZone, rsiTrend, bullishDivergence, bearishDivergence, atr };
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

  // ─── BOS / Swing Level Extraction ─────────────────────────────────────────

  private extractBosDetails(structs: StructureEvent[], candles: Candle[]): {
    lastBosDirection: 'bullish' | 'bearish' | null;
    lastSwingHigh:    number | null;
    lastSwingLow:     number | null;
  } {
    const bosEvents = structs.filter(s => s.type === 'BOS');
    const lastBos   = bosEvents[bosEvents.length - 1] ?? null;

    // Derive swing high/low from candle range near BOS
    const swingHighs = candles.slice(-50).map(c => c.high);
    const swingLows  = candles.slice(-50).map(c => c.low);

    return {
      lastBosDirection: lastBos ? (lastBos.bias === 'BULLISH' ? 'bullish' : 'bearish') : null,
      lastSwingHigh:    swingHighs.length ? +Math.max(...swingHighs).toFixed(2) : null,
      lastSwingLow:     swingLows.length  ? +Math.min(...swingLows).toFixed(2)  : null,
    };
  }

  // ─── Killzone Detection ───────────────────────────────────────────────────

  detectKillzone(): { inKillzone: boolean; killzoneName: 'London' | 'New York' | 'None' } {
    const utcHour = new Date().getUTCHours();
    // London Open: 07:00–10:00 UTC
    if (utcHour >= 7 && utcHour < 10)  return { inKillzone: true,  killzoneName: 'London'   };
    // New York Open: 13:00–16:00 UTC
    if (utcHour >= 13 && utcHour < 16) return { inKillzone: true,  killzoneName: 'New York' };
    return { inKillzone: false, killzoneName: 'None' };
  }

  // ─── Previous Day High / Low / Close ──────────────────────────────────────

  computePDLevels(d1Candles: Candle[]): { pdh: number; pdl: number; pdc: number } {
    // Use second-to-last candle (last fully closed D1 candle)
    const prev = d1Candles.length >= 2
      ? d1Candles[d1Candles.length - 2]
      : d1Candles[d1Candles.length - 1];
    return { pdh: prev.high, pdl: prev.low, pdc: prev.close };
  }

  // ─── Full Feature Set (5-layer) ───────────────────────────────────────────

  compute(
    d1Candles:  Candle[],   // D1  — macro direction + PDH/PDL (or HTF in non-institutional modes)
    h4Candles:  Candle[],   // H4  — intermediate bias + primary OBs
    h1Candles:  Candle[],   // H1  — structural confirmation
    m15Candles: Candle[],   // M15 — setup refinement
    m5Candles:  Candle[],   // M5  — entry timing
    signal:     SMCSignal | null,
    symbol:     string,
    /**
     * Real D1 candles for EMA200 hard block and PDH/PDL when running in
     * Precision or Quick Scalp mode (where d1Candles is actually H4 or H1).
     * When provided, macro bias and previous-day levels always use true D1 data.
     */
    macroCandles?: Candle[],
  ): FeatureSet {
    // Use real D1 as macro anchor when available (Precision / Quick Scalp modes).
    // Falls back to d1Candles when mode is Institutional (d1Candles IS D1 data).
    const actualD1 = macroCandles && macroCandles.length >= 10 ? macroCandles : d1Candles;

    const d1ATR  = this.computeATR(actualD1);
    const h4ATR  = this.computeATR(h4Candles);
    const h1ATR  = this.computeATR(h1Candles);
    const m15ATR = this.computeATR(m15Candles);
    const m5ATR  = this.computeATR(m5Candles);

    const price = m5Candles[m5Candles.length - 1].close;

    // D1 macro bias + PDH/PDL — always computed from real D1 candles
    const htfBias  = this.smcService.getHTFBias(actualD1);
    const pdLevels = this.computePDLevels(actualD1);

    // H4 intermediate — OBs, FVGs, zone (primary entry zones)
    const h4OBs  = this.smcService.detectOrderBlocks(h4Candles);
    const h4FVGs = this.smcService.detectFVGs(h4Candles);
    const h4Pd   = this.smcService.premiumDiscount(h4Candles);

    // Best unmitigated H4 OB near price
    const h4BullOb = [...h4OBs].reverse().find(o =>
      o.type === 'BULLISH_OB' && price >= o.low * 0.998 && price <= o.high * 1.005,
    ) ?? null;
    const h4BearOb = [...h4OBs].reverse().find(o =>
      o.type === 'BEARISH_OB' && price >= o.low * 0.998 && price <= o.high * 1.005,
    ) ?? null;
    const h4ActiveOb = h4BullOb ?? h4BearOb ?? null;

    const h4BullFvg = [...h4FVGs].reverse().find(f =>
      f.type === 'BULLISH_FVG' && price >= f.low && price <= f.high,
    ) ?? null;
    const h4BearFvg = [...h4FVGs].reverse().find(f =>
      f.type === 'BEARISH_FVG' && price >= f.low && price <= f.high,
    ) ?? null;
    const h4ActiveFvg = h4BullFvg ?? h4BearFvg ?? null;

    // H1 structural confirmation — BOS / CHoCH
    const h1Structs  = this.smcService.detectStructure(h1Candles);
    const hasBOS     = h1Structs.some(s => s.type === 'BOS');
    const hasCHoCH   = h1Structs.some(s => s.type === 'CHoCH');
    const bosDetails = this.extractBosDetails(h1Structs, h1Candles);

    // M15 — refinement OBs/FVGs
    const m15Sweeps      = this.smcService.detectLiquiditySweeps(m15Candles);
    const liquiditySwept = m15Sweeps.some(s => s.swept);
    const m15Pd          = this.smcService.premiumDiscount(m15Candles);

    // Momentum on H1
    const momentum = this.computeMomentum(h1Candles);

    // Fibonacci from M15 swing
    const fibonacci = this.computeFibonacci(m15Candles);

    // Killzone
    const { inKillzone, killzoneName } = this.detectKillzone();

    return {
      symbol,
      timestamp: new Date().toISOString(),
      price,

      d1Trend:  this.computeTrend(actualD1,   d1ATR),
      h4Trend:  this.computeTrend(h4Candles,  h4ATR),
      h1Trend:  this.computeTrend(h1Candles,  h1ATR),
      m15Trend: this.computeTrend(m15Candles, m15ATR),
      m5Trend:  this.computeTrend(m5Candles,  m5ATR),

      pdh: pdLevels.pdh,
      pdl: pdLevels.pdl,
      pdc: pdLevels.pdc,

      inKillzone,
      killzoneName,

      momentum,
      fibonacci,

      smc: {
        bias: htfBias,

        // H4 primary entry zones
        h4ObPresent:  !!h4ActiveOb,
        h4ObHigh:     h4ActiveOb?.high ?? null,
        h4ObLow:      h4ActiveOb?.low  ?? null,
        h4FvgPresent: !!h4ActiveFvg,
        h4FvgHigh:    h4ActiveFvg?.high ?? null,
        h4FvgLow:     h4ActiveFvg?.low  ?? null,
        h4Zone:       h4Pd.zone,
        h4ZonePct:    h4Pd.pct,

        // H1 structural confirmation
        bos:              hasBOS,
        choch:            hasCHoCH,
        lastBosDirection: bosDetails.lastBosDirection,
        lastSwingHigh:    bosDetails.lastSwingHigh,
        lastSwingLow:     bosDetails.lastSwingLow,

        // M15 setup refinement
        obPresent:      !!signal?.ob,
        obHigh:         signal?.ob?.high  ?? null,
        obLow:          signal?.ob?.low   ?? null,
        fvgPresent:     !!signal?.fvg,
        fvgHigh:        signal?.fvg?.high ?? null,
        fvgLow:         signal?.fvg?.low  ?? null,
        liquiditySwept,
        zone:           m15Pd.zone,
        zonePct:        m15Pd.pct,
      },
    };
  }
}
