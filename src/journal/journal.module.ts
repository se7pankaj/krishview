import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Trade } from './entities/trade.entity';
import { JournalService } from './journal.service';

@Module({
  imports: [TypeOrmModule.forFeature([Trade])],
  providers: [JournalService],
  exports: [JournalService],
})
export class JournalModule {}
