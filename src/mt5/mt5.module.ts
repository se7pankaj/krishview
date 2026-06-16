import { Module } from '@nestjs/common';
import { Mt5Service } from './mt5.service';

@Module({
  providers: [Mt5Service],
  exports: [Mt5Service],
})
export class Mt5Module {}
