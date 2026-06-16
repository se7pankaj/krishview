import { Module } from '@nestjs/common';

import { TelegramService } from '../telegram.service';
import { ApprovalModule } from '../approval/approval.module';
import { AnalysisModule } from '../analysis/analysis.module';

@Module({
  imports: [ApprovalModule, AnalysisModule],
  providers: [TelegramService],
  exports: [TelegramService],
})
export class TelegramModule {}
