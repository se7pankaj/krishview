import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Analysis } from './entities/analysis.entity';
import { AnalysisService } from './analysis.service';
import { FeatureEngineService } from './feature-engine.service';
import { AiReasoningService } from './ai-reasoning.service';
import { ConfidenceExplainerService } from './confidence-explainer.service';
import { SmcModule } from '../smc/smc.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Analysis]),
    SmcModule,
  ],
  providers: [AnalysisService, FeatureEngineService, AiReasoningService, ConfidenceExplainerService],
  exports: [AnalysisService, ConfidenceExplainerService],
})
export class AnalysisModule {}
