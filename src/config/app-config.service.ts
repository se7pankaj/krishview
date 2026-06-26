/**
 * config/app-config.service.ts — Runtime App Settings
 * ======================================================
 * Persists key-value settings to Postgres so they survive restarts and
 * can be changed from the dashboard without touching .env.
 *
 * Currently used for:
 *   TRADING_MODE — 'INSTITUTIONAL' | 'PRECISION'
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AppConfig } from './entities/app-config.entity';

// ─── Trading Mode ─────────────────────────────────────────────────────────────

export type TradingMode = 'INSTITUTIONAL' | 'PRECISION' | 'QUICK_SCALP' | 'MICRO_SCALP';

export interface ModeConfig {
  label:        string;
  description:  string;
  /** 5 timeframes passed positionally to analysis.run() as d1→h4→h1→m15→m5 */
  htfTf:        string;
  h4Tf:         string;
  confirmTf:    string;
  setupTf:      string;
  entryTf:      string;
  /** Minimum confluence-adjusted confidence required to proceed */
  minConfidence: number;
  /** True = allow trading from 06:00–20:00 UTC weekdays; false = London+NY only */
  extendedHours: boolean;
}

export const TRADING_MODES: Record<TradingMode, ModeConfig> = {
  INSTITUTIONAL: {
    label:         'Institutional',
    description:   'D1→H4→H1→M15→M5 · T2 ≥74% · London + NY killzones only',
    htfTf:         'D1',
    h4Tf:          'H4',
    confirmTf:     'H1',
    setupTf:       'M15',
    entryTf:       'M5',
    minConfidence: 74,
    extendedHours: false,
  },
  PRECISION: {
    label:         'Precision Scalp',
    description:   'H4→H1→M15→M5→M1 · T1 ≥62% · Extended hours 06:00–20:00 UTC',
    htfTf:         'H4',
    h4Tf:          'H1',
    confirmTf:     'M15',
    setupTf:       'M5',
    entryTf:       'M1',
    minConfidence: 62,
    extendedHours: true,
  },
  QUICK_SCALP: {
    label:         'Quick Scalp',
    description:   'H1→M30→M15→M5→M1 · ≥58% · All-day 00:00–23:59 UTC weekdays',
    htfTf:         'H1',
    h4Tf:          'M30',
    confirmTf:     'M15',
    setupTf:       'M5',
    entryTf:       'M1',
    minConfidence: 58,
    extendedHours: true,  // uses extended-hours path; all-day handled in TradingService
  },
  MICRO_SCALP: {
    label:         'Micro Scalp',
    description:   'H1→M15→M5→M3→M1 · ≥55% · All-day 00:00–23:59 UTC weekdays — ultra-short pyramid',
    htfTf:         'H1',   // H1 = direction bias (htfTf=H1 → all-day session detection)
    h4Tf:          'M15',  // M15 = money layer / primary OBs
    confirmTf:     'M5',   // M5  = BOS / CHoCH structure confirmation
    setupTf:       'M3',   // M3  = OB/FVG setup zone (distinct refinement between M5 and M1)
    entryTf:       'M1',   // M1  = precise entry trigger
    minConfidence: 55,
    extendedHours: true,  // all-day handled by htfTf=H1 check in TradingService
  },
};

const MODE_KEY = 'TRADING_MODE';

// ─── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class AppConfigService {
  private readonly logger = new Logger(AppConfigService.name);

  constructor(
    @InjectRepository(AppConfig)
    private readonly repo: Repository<AppConfig>,
  ) {}

  async get(key: string, defaultValue = ''): Promise<string> {
    const row = await this.repo.findOne({ where: { key } });
    return row?.value ?? defaultValue;
  }

  async set(key: string, value: string): Promise<void> {
    await this.repo.save({ key, value });
  }

  /** Returns the active trading mode, defaulting to INSTITUTIONAL. */
  async getTradingMode(): Promise<TradingMode> {
    const raw = await this.get(MODE_KEY, 'INSTITUTIONAL');
    if (raw === 'PRECISION' || raw === 'QUICK_SCALP' || raw === 'MICRO_SCALP') return raw;
    return 'INSTITUTIONAL';
  }

  /** Persists the trading mode and returns the full config for the new mode. */
  async setTradingMode(mode: TradingMode): Promise<ModeConfig> {
    await this.set(MODE_KEY, mode);
    this.logger.log(`Trading mode switched to ${mode}`);
    return TRADING_MODES[mode];
  }

  /** Convenience — returns the full ModeConfig for the currently active mode. */
  async getActiveModeConfig(): Promise<ModeConfig> {
    const mode = await this.getTradingMode();
    return TRADING_MODES[mode];
  }
}
