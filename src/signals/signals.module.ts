import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SignalsController } from './signals.controller';
import { SignalsService } from './signals.service';

import { Signal } from './entities/signal.entity';
import { TelegramModule } from '../telegram/telegram.module';

import { ApprovalModule } from '../approval/approval.module';
import { AnalysisModule } from '../analysis/analysis.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Signal]),
    ApprovalModule,
    AnalysisModule,
    // Use centralized TelegramModule which exports the TelegramService provider
    // so dependent modules can import it instead of redeclaring the provider.
    TelegramModule,
  ],
  controllers: [SignalsController],
  providers: [SignalsService],
})
export class SignalsModule {}