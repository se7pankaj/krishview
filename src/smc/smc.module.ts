import { Module } from '@nestjs/common';
import { SmcService } from './smc.service';

@Module({
  providers: [SmcService],
  exports: [SmcService],
})
export class SmcModule {}
