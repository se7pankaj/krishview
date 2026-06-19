/**
 * symbol/symbol.module.ts — Global Symbol Module
 * ================================================
 * Provides ActiveSymbolService as a @Global singleton so any module can
 * inject it without creating circular dependencies. Import once in AppModule.
 *
 * ActiveSymbolService holds the currently selected trading symbol in memory.
 * Switching via the dashboard dropdown calls setSymbol() here; TradingService,
 * RiskService, and AiReasoningService all read getSymbol() on each cycle,
 * so the change takes effect on the very next analysis tick.
 */

import { Global, Module } from '@nestjs/common';
import { ActiveSymbolService } from '../trading/active-symbol.service';

@Global()
@Module({
  providers: [ActiveSymbolService],
  exports:   [ActiveSymbolService],
})
export class SymbolModule {}
