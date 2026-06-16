import { Module } from '@nestjs/common';
import { TradingService } from './trading.service';
import { SmcModule } from '../smc/smc.module';
import { RiskModule } from '../risk/risk.module';
import { Mt5Module } from '../mt5/mt5.module';
import { JournalModule } from '../journal/journal.module';
import { AnalysisModule } from '../analysis/analysis.module';
import { ApprovalModule } from '../approval/approval.module';
import { MlModule } from '../ml/ml.module';
import { NewsModule } from '../news/news.module';
import { TelegramModule } from '../telegram/telegram.module';

@Module({
  imports: [SmcModule, RiskModule, Mt5Module, JournalModule, AnalysisModule, ApprovalModule, MlModule, NewsModule, TelegramModule],
  providers: [TradingService],
  exports: [TradingService],
})
export class TradingModule {}
