/**
 * trading/active-symbol.service.ts — Runtime Symbol Switcher
 * ===========================================================
 * Holds the currently selected symbol in memory.
 * Dashboard dropdown calls setSymbol(); TradingService reads getSymbol().
 * Falls back to SYMBOL env var if nothing is set.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SYMBOL_REGISTRY, SymbolConfig } from '../common/symbol-registry';

@Injectable()
export class ActiveSymbolService {
  private readonly logger = new Logger(ActiveSymbolService.name);
  private activeSymbol: string;

  constructor(private readonly config: ConfigService) {
    this.activeSymbol = this.config.get<string>('SYMBOL', 'XAUUSD');
    this.logger.log(`Active symbol initialised → ${this.activeSymbol}`);
  }

  getSymbol(): string {
    return this.activeSymbol;
  }

  getConfig(): SymbolConfig | null {
    return SYMBOL_REGISTRY[this.activeSymbol] ?? null;
  }

  setSymbol(symbol: string): { ok: boolean; error?: string; config?: SymbolConfig } {
    const cfg = SYMBOL_REGISTRY[symbol];
    if (!cfg) {
      return { ok: false, error: `Symbol "${symbol}" is not in the registry` };
    }
    const prev = this.activeSymbol;
    this.activeSymbol = symbol;
    this.logger.log(`Symbol switched: ${prev} → ${symbol} (${cfg.label})`);
    return { ok: true, config: cfg };
  }
}
