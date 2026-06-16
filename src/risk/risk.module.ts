import { Module } from '@nestjs/common';
import { RiskService } from './risk.service';
import { JournalModule } from '../journal/journal.module';
import { NewsModule } from '../news/news.module';
import { TelegramModule } from '../telegram/telegram.module';

@Module({
  imports:   [JournalModule, NewsModule, TelegramModule],
  providers: [RiskService],
  exports:   [RiskService],
})
export class RiskModule {}
