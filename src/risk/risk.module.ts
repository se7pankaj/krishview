import { Module } from '@nestjs/common';
import { RiskService } from './risk.service';
import { JournalModule } from '../journal/journal.module';
import { NewsModule } from '../news/news.module';

@Module({
  imports:   [JournalModule, NewsModule],
  providers: [RiskService],
  exports:   [RiskService],
})
export class RiskModule {}
