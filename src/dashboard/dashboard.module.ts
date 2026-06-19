import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { JournalModule } from '../journal/journal.module';
import { Mt5Module } from '../mt5/mt5.module';
import { SmcModule } from '../smc/smc.module';
import { ApprovalModule } from '../approval/approval.module';
import { NewsModule } from '../news/news.module';
import { AnalysisModule } from '../analysis/analysis.module';
import { TradingModule } from '../trading/trading.module';

@Module({
  imports: [JournalModule, Mt5Module, SmcModule, ApprovalModule, NewsModule, AnalysisModule, TradingModule],
  controllers: [DashboardController],
})
export class DashboardModule {}
