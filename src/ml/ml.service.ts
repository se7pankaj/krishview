/**
 * ml/ml.service.ts — LightGBM Learning Engine Client
 * =====================================================
 * Calls the /ml/predict endpoint on the Windows MT5 bridge (alongside bridge.py).
 * After 300+ trades the model is trained offline with train.py and loaded by the bridge.
 *
 * Falls back gracefully if the ML endpoint is not yet available (model not trained yet).
 * Combined confidence = 0.5 × ai_confidence + 0.5 × ml_win_probability × 100
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { FeatureSet } from '../analysis/feature-engine.service';

export interface MLPrediction {
  winProbability: number;   // 0–1
  mlConfidence:   number;   // 0–100 (= winProbability × 100)
  modelVersion:   string;
  tradeCount:     number;   // how many trades the model was trained on
}

@Injectable()
export class MlService {
  private readonly logger = new Logger(MlService.name);
  private readonly MIN_TRADES_FOR_ML = 300;

  constructor(private readonly config: ConfigService) {}

  private get bridgeUrl(): string {
    return this.config.get<string>('MT5_BRIDGE_URL', 'http://localhost:7654');
  }

  /**
   * Predict win probability for a given FeatureSet.
   * Returns null if model not ready or bridge unavailable.
   */
  async predict(features: FeatureSet, direction: 'BUY' | 'SELL'): Promise<MLPrediction | null> {
    try {
      const payload = this.flattenFeatures(features, direction);
      const resp = await axios.post<{
        win_probability: number;
        model_version:   string;
        trade_count:     number;
      }>(
        `${this.bridgeUrl}/ml/predict`,
        payload,
        { timeout: 5_000 },
      );

      const prob = Math.min(1, Math.max(0, resp.data.win_probability));
      this.logger.log(
        `ML: ${direction} win_probability=${(prob * 100).toFixed(1)}% ` +
        `(model trained on ${resp.data.trade_count} trades)`,
      );

      return {
        winProbability: prob,
        mlConfidence:   +(prob * 100).toFixed(1),
        modelVersion:   resp.data.model_version,
        tradeCount:     resp.data.trade_count,
      };
    } catch (e: any) {
      // Model not trained yet or bridge offline — fail gracefully
      if (e?.response?.status === 503) {
        this.logger.log(`ML: Model not ready yet (need ${this.MIN_TRADES_FOR_ML}+ trades)`);
      } else {
        this.logger.debug(`ML: predict unavailable — ${e?.message}`);
      }
      return null;
    }
  }

  /**
   * Blend AI confidence with ML win probability.
   * If ML unavailable, returns aiConfidence unchanged.
   */
  blendConfidence(aiConfidence: number, ml: MLPrediction | null): number {
    if (!ml) return aiConfidence;
    const blended = 0.5 * aiConfidence + 0.5 * ml.mlConfidence;
    return +blended.toFixed(1);
  }

  /** Flatten FeatureSet to a flat numeric dict for the ML model */
  private flattenFeatures(f: FeatureSet, direction: 'BUY' | 'SELL'): Record<string, number> {
    const dirBias = direction === 'BUY' ? 1 : -1;
    const htfBias = f.smc.bias === 'BULLISH' ? 1 : f.smc.bias === 'BEARISH' ? -1 : 0;

    return {
      direction_bias:       dirBias,
      htf_bias:             htfBias,
      d1_ema_aligned:       f.d1Trend.aligned ? 1 : 0,
      d1_ema200_dist:       f.d1Trend.ema200Distance,
      h1_ema_aligned:       f.h1Trend.aligned ? 1 : 0,
      h1_ema200_dist:       f.h1Trend.ema200Distance,
      m15_ema_aligned:      f.m15Trend.aligned ? 1 : 0,
      m5_ema_aligned:       f.m5Trend.aligned ? 1 : 0,
      rsi:                  f.momentum.rsi,
      rsi_zone:             f.momentum.rsiZone === 'oversold' ? -1 : f.momentum.rsiZone === 'overbought' ? 1 : 0,
      bull_divergence:      f.momentum.bullishDivergence ? 1 : 0,
      bear_divergence:      f.momentum.bearishDivergence ? 1 : 0,
      atr:                  f.momentum.atr,
      fib_zone:             this.fibZoneIndex(f.fibonacci.currentZone),
      ob_present:           f.smc.obPresent ? 1 : 0,
      fvg_present:          f.smc.fvgPresent ? 1 : 0,
      liquidity_swept:      f.smc.liquiditySwept ? 1 : 0,
      bos:                  f.smc.bos ? 1 : 0,
      choch:                f.smc.choch ? 1 : 0,
      zone_pct:             f.smc.zonePct,
      hour_utc:             new Date().getUTCHours(),
      day_of_week:          new Date().getUTCDay(),
    };
  }

  private fibZoneIndex(zone: string): number {
    const map: Record<string, number> = {
      'below-range': 0, '0-23.6%': 1, '23.6-38.2%': 2,
      '38.2-50%': 3, '50-61.8%': 4, '61.8-78.6%': 5,
      '78.6-100%': 6, 'above-range': 7,
    };
    return map[zone] ?? 3;
  }
}
