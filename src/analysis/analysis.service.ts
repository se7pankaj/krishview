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

export interface AnalysisResult {
  analysisId:   number;
  features:     FeatureSet;
  smcSignal:    SMCSignal | null;
  recommendation: AIRecommendation | null;
  /** AI disabled or returned null → fall back to SMC-only signal */
  fallbackToSmc: boolean;
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
  ) {}

  async run(
    d1Candles:  Candle[],   // D1  — macro direction
    h1Candles:  Candle[],   // H1  — structural confirmation
    m15Candles: Candle[],   // M15 — setup confirmation
    m5Candles:  Candle[],   // M5  — entry timing
    symbol:     string,
  ): Promise<AnalysisResult | null> {
    // 1. SMC analysis — D1 bias, H1 structure, M5 entry
    const smcSignal = this.smc.analyze(d1Candles, h1Candles, m15Candles, m5Candles);
    this.logger.log(`Analysis: SMC signal = ${smcSignal?.direction ?? 'none'}`);

    // 2. Feature engine (always runs, even if no SMC signal)
    const features = this.featureEngine.compute(d1Candles, h1Candles, m15Candles, m5Candles, smcSignal, symbol);

    // 3. AI reasoning
    const recommendation = await this.aiReasoning.analyze(features, smcSignal);

    // 4. Decide if we have something worth showing
    const hasSignal = recommendation
      ? recommendation.decision !== 'WAIT'
      : smcSignal !== null;

    if (!hasSignal) {
      this.logger.log('Analysis: no actionable signal — skip');
      return null;
    }

    // 5. Persist to DB
    const entity = this.repo.create({
      symbol,
      features:         features as any,
      smcSignal:        smcSignal as any,
      aiDecision:       recommendation?.decision ?? smcSignal?.direction,
      aiConfidence:     recommendation?.confidence ?? smcSignal?.confidence,
      aiEntry:          recommendation?.entry ?? String(smcSignal?.entryPrice ?? ''),
      aiStopLoss:       recommendation?.stopLoss ?? smcSignal?.sl,
      aiTakeProfit:     recommendation?.takeProfit ?? smcSignal?.tp,
      aiRR:             recommendation?.rr ?? smcSignal?.rr,
      aiReasons:        recommendation?.reasons ?? smcSignal?.reasons,
      aiRisks:          recommendation?.risks ?? [],
      gptModel:         recommendation?.model,
      promptTokens:     recommendation?.promptTokens,
      completionTokens: recommendation?.completionTokens,
      status: 'PENDING',
    });

    const saved = await this.repo.save(entity);
    this.logger.log(`Analysis #${saved.id} saved — decision: ${saved.aiDecision} confidence: ${saved.aiConfidence}%`);

    return {
      analysisId:      saved.id,
      features,
      smcSignal,
      recommendation,
      fallbackToSmc:   !recommendation,
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
    return this.repo.findOne({ order: { createdAt: 'DESC' } });
  }
}
