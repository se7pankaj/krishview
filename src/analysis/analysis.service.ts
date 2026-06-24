/**
 * analysis/analysis.service.ts — Analysis Orchestrator
 * ======================================================
 * Ties together: SMC engine → Feature Engine → AI Reasoning.
 * Persists the full analysis record (feature snapshot + AI response)
 * to PostgreSQL via the Analysis entity.
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Analysis } from './entities/analysis.entity';
import { FeatureEngineService, FeatureSet } from './feature-engine.service';
import { AiReasoningService, AIRecommendation } from './ai-reasoning.service';
import { SmcService, Candle, SMCSignal } from '../smc/smc.service';
import { ConfluenceService, ConfluenceResult } from '../confluence/confluence.service';

export interface AnalysisResult {
  analysisId:      number;
  features:        FeatureSet;
  smcSignal:       SMCSignal | null;
  confluence:      ConfluenceResult | null;
  recommendation:  AIRecommendation | null;
  /** AI disabled or returned null → fall back to SMC-only signal */
  fallbackToSmc:   boolean;
}

@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);

  constructor(
    @InjectRepository(Analysis)
    private readonly repo: Repository<Analysis>,
    private readonly featureEngine: FeatureEngineService,
    private readonly aiReasoning:   AiReasoningService,
    private readonly smc:           SmcService,
    private readonly confluence:    ConfluenceService,
  ) {}

  async run(
    d1Candles:  Candle[],   // Layer 1 — macro bias (D1 in Institutional, H4 in Precision)
    h4Candles:  Candle[],   // Layer 2 — money layer / OBs (H4 in Institutional, H1 in Precision)
    h1Candles:  Candle[],   // Layer 3 — structural confirmation (H1 in Institutional, M15 in Precision)
    m15Candles: Candle[],   // Layer 4 — setup refinement (M15 in Institutional, M5 in Precision)
    m5Candles:  Candle[],   // Layer 5 — entry trigger (M5 in Institutional, M1 in Precision)
    symbol:     string,
    options?: {
      /** Override the tier threshold gate — used by Precision mode (T1 ≥62%) vs default T2 ≥74% */
      minConfidence?: number;
      /** Label shown in logs so it's clear which mode ran */
      modeLabel?: string;
    },
  ): Promise<AnalysisResult | null> {
    const modeLabel = options?.modeLabel ?? 'Institutional';
    // 1. SMC analysis — 5-layer top-down
    const smcSignal = this.smc.analyze(d1Candles, h4Candles, h1Candles, m15Candles, m5Candles);
    this.logger.log(`Analysis [${modeLabel}]: SMC signal = ${smcSignal?.direction ?? 'none'}`);
    this.logger.log(`Analysis: SMC signal = ${smcSignal?.direction ?? 'none'}`);

    if (!smcSignal) {
      this.logger.log(`Analysis [${modeLabel}]: SMC returned null — skip`);
      await this.logNoSignal(symbol, 'NO_SETUP', ['No valid SMC setup this cycle']);
      return null;
    }

    // 2. Feature engine — computes EMA, RSI, ATR, Fib, PDH/PDL, killzone, H4 OBs
    const features = this.featureEngine.compute(d1Candles, h4Candles, h1Candles, m15Candles, m5Candles, smcSignal, symbol);

    // 3. 360° Confluence filter — EMA stack, RSI, Fibonacci, Volume
    //    Hard blocks fire here; adjustedConfidence forwarded to AI
    const confluenceResult = this.confluence.check(smcSignal, features, h1Candles, m5Candles);
    if (!confluenceResult.pass) {
      this.logger.warn(
        `Analysis: Confluence BLOCKED [${smcSignal.direction}] — ${confluenceResult.hardBlocks.join(' | ')}`,
      );
      await this.logNoSignal(symbol, 'BLOCKED', confluenceResult.hardBlocks, smcSignal.direction, smcSignal.confidence);
      return null;
    }
    this.logger.log(
      `Analysis: Confluence PASSED — base=${smcSignal.confidence}% → adjusted=${confluenceResult.adjustedConfidence}% ` +
      `boosts=[${confluenceResult.boostReasons.map(r => r.split(' (')[0]).join(', ')}]`,
    );

    // Step 6: Tier threshold gate — Tier 1 ≥62 | Tier 2 ≥74 | Tier 3 ≥86
    // If the trading mode supplies a minConfidence override (e.g. Precision uses T1 ≥62%)
    // that takes priority over the confluence service's own tier calculation.
    const tierThreshold = options?.minConfidence ?? confluenceResult.tierThreshold;
    if (confluenceResult.adjustedConfidence < tierThreshold) {
      this.logger.log(
        `Analysis [${modeLabel}]: Below threshold ` +
        `(${confluenceResult.adjustedConfidence}% < ${tierThreshold}%) — skip`,
      );
      await this.logNoSignal(
        symbol, 'BELOW_TIER',
        [`Adjusted ${confluenceResult.adjustedConfidence}% < threshold ${tierThreshold}% (${modeLabel} mode)`],
        smcSignal.direction, confluenceResult.adjustedConfidence,
      );
      return null;
    }
    this.logger.log(
      `Analysis: Tier${confluenceResult.tradingTier} gate PASSED ` +
      `(${confluenceResult.adjustedConfidence}% ≥ ${confluenceResult.tierThreshold}%)`,
    );

    // Upgrade the signal confidence with confluence-adjusted value
    const adjustedSignal: SMCSignal = {
      ...smcSignal,
      confidence: confluenceResult.adjustedConfidence,
      reasons: [
        ...smcSignal.reasons,
        ...confluenceResult.boostReasons,
      ],
    };

    // 4. AI reasoning — receives all 5-layer data + confluence context
    const recommendation = await this.aiReasoning.analyze(features, adjustedSignal);

    // 5. Decide if we have something worth showing
    const hasSignal = recommendation
      ? recommendation.decision !== 'WAIT'
      : true; // SMC + confluence passed → always actionable even without AI

    if (!hasSignal) {
      this.logger.log('Analysis: AI said WAIT — skip');
      await this.logNoSignal(
        symbol, 'WAIT',
        recommendation?.reasons ?? ['AI reviewed full context and said WAIT'],
        adjustedSignal.direction, recommendation?.confidence ?? adjustedSignal.confidence,
      );
      return null;
    }

    // 6. Persist to DB
    const entity = this.repo.create({
      symbol,
      features:         features as any,
      smcSignal:        adjustedSignal as any,
      aiDecision:       recommendation?.decision ?? adjustedSignal.direction,
      aiConfidence:     recommendation?.confidence ?? adjustedSignal.confidence,
      aiEntry:          recommendation?.entry ?? String(adjustedSignal.entryPrice ?? ''),
      aiStopLoss:       recommendation?.stopLoss ?? adjustedSignal.sl,
      aiTakeProfit:     recommendation?.takeProfit ?? adjustedSignal.tp,
      aiRR:             recommendation?.rr ?? adjustedSignal.rr,
      aiReasons:        recommendation?.reasons ?? adjustedSignal.reasons,
      aiRisks:          recommendation?.risks ?? [],
      gptModel:         recommendation?.model,
      promptTokens:     recommendation?.promptTokens,
      completionTokens: recommendation?.completionTokens,
      status: 'PENDING',
    });

    const saved = await this.repo.save(entity);
    this.logger.log(
      `Analysis #${saved.id} saved — decision: ${saved.aiDecision} ` +
      `confidence: ${saved.aiConfidence}% (SMC=${smcSignal.confidence}% + confluence boost=${confluenceResult.confluenceBoost > 0 ? '+' : ''}${confluenceResult.confluenceBoost})`,
    );

    return {
      analysisId:     saved.id,
      features,
      smcSignal:      adjustedSignal,
      confluence:     confluenceResult,
      recommendation,
      fallbackToSmc:  !recommendation,
    };
  }

  async updateStatus(id: number, status: string): Promise<void> {
    await this.repo.update(id, { status });
  }

  /**
   * Records a no-trade cycle (NO_SETUP / BLOCKED / BELOW_TIER / WAIT) so the
   * dashboard's "Latest AI Analysis" card reflects what actually just
   * happened, instead of silently leaving the last real trade idea on
   * screen indefinitely. Best-effort only — never throws, since a logging
   * failure here must not interrupt the calling cycle.
   */
  private async logNoSignal(
    symbol: string,
    status: 'NO_SETUP' | 'BLOCKED' | 'BELOW_TIER' | 'WAIT',
    reasons: string[],
    direction?: string,
    confidence?: number,
  ): Promise<void> {
    try {
      await this.repo.save(this.repo.create({
        symbol,
        status,
        aiDecision:   direction ?? 'WAIT',
        aiConfidence: confidence ?? 0,
        aiReasons:    reasons,
      }));
    } catch (e: any) {
      this.logger.warn(`logNoSignal failed (non-fatal): ${e?.message}`);
    }
  }

  async saveBreakdown(id: number, breakdown: Record<string, any>): Promise<void> {
    await this.repo.update(id, { breakdown });
  }

  async findById(id: number): Promise<Analysis | null> {
    return this.repo.findOne({ where: { id } });
  }

  async getLatest(): Promise<Analysis | null> {
    const results = await this.repo.find({
      order: { createdAt: 'DESC' },
      take: 1,
    });
    return results[0] ?? null;
  }
}
