import { Controller, Get } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';

@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get()
  async summary() { return this.analytics.summary(); }

  @Get('confidence')
  async confidence() { return this.analytics.confidenceBrackets(); }

  @Get('approvals')
  async approvals() { return this.analytics.approvalStats(); }

  @Get('smc-reasons')
  async smcReasons() { return this.analytics.smcReasonStats(); }

  @Get('sessions')
  async sessions() { return this.analytics.sessionStats(); }

  @Get('equity')
  async equity() { return this.analytics.equityCurve(); }
}
