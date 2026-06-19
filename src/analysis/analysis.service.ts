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
    d1Candles:  Candle[],   // D1  — macro direction / bias
    h4Candles:  Candle[],   // H4  — intermediate bias + primary OBs (money layer)
    h1Candles:  Candle[],   // H1  — structural confirmation (BOS / CHoCH)
    m15Candles: Candle[],   // M15 — setup refinement (OB / FVG within H4 zone)
    m5Candles:  Candle[],   // M5  — entry timing (liquidity sweep trigger)
    symbol:     string,
  ): Promise<AnalysisResult | null> {
    // 1. SMC analysis — 5-layer: D1→H4→H1→M15→M5
    const smcSignal = this.smc.analyze(d1Candles, h4Candles, h1Candles, m15Candles, m5Candles);
    this.logger.log(`Analysis: SMC signal = ${smcSignal?.direction ?? 'none'}`);

    if (!smcSignal) {
      this.logger.log('Analysis: SMC returned null — skip');
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
      return null;
    }
    this.logger.log(
      `Analysis: Confluence PASSED — base=${smcSignal.confidence}% → adjusted=${confluenceResult.adjustedConfidence}% ` +
      `boosts=[${confluenceResult.boostReasons.map(r => r.split(' (')[0]).join(', ')}]`,
    );

    // Step 6: Tier threshold gate — Tier 1 ≥62 | Tier 2 ≥74 | Tier 3 ≥86
    if (confluenceResult.adjustedConfidence < confluenceResult.tierThreshold) {
      this.logger.log(
        `Analysis: Below Tier${confluenceResult.tradingTier} threshold ` +
        `(${confluenceResult.adjustedConfidence}% < ${confluenceResult.tierThreshold}%) — skip`,
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
