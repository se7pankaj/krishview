import { Module } from '@nestjs/common';
import { WebhookController } from './webhook.controller';
import { TradingModule } from '../trading/trading.module';

@Module({
  imports: [TradingModule],
  controllers: [WebhookController],
})
export class WebhookModule {}
