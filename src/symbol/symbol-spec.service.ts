/**
 * symbol/symbol-spec.service.ts — Broker-Verified Lot Sizing + Market Hours
 * =============================================================================
 * Fetches each symbol's real minLot/maxLot/lotStep AND its real open-for-
 * trading schedule from MetaApi, instead of guessing:
 *
 *   - GET /symbols/:symbol/specification → minVolume/maxVolume/volumeStep
 *     (replaces the hardcoded 0.01 floor that used to live inside
 *     RiskService.calcLotSize() — see ticket #1412058401 position-sizing bug)
 *
 *   - GET /symbols/:symbol/specification → tradeSessions (per day of week,
 *     in BROKER LOCAL time)
 *   - GET /server-time → true UTC vs broker-local clock side by side, used
 *     to derive the broker's current UTC offset (self-corrects through DST
 *     on every resync rather than hardcoding a timezone)
 *
 * Both are synced together and cached in Postgres (symbol_specs table),
 * refreshed lazily: only synced the first time a symbol is actually used,
 * then re-synced if the cached row is older than 24h.
 *
 * IMPORTANT — this is a SEPARATE concept from the killzone (London/NY)
 * hours in common/symbol-registry.ts. tradeSessions tells you when the
 * broker's market is open AT ALL (catches holidays, maintenance windows,
 * and settles whether a given symbol really trades on weekends with this
 * specific broker). Killzone hours are a strategic choice — only trade
 * during peak institutional liquidity — layered ON TOP of this, not
 * replaced by it.
 *
 * Never throws — if MetaApi is unreachable, falls back to the last cached
 * value, or to permissive defaults if nothing is cached yet. This sits in
 * the trade-execution and cycle-gating path, so a transient MetaApi hiccup
 * must never silently block (or silently allow) trading on its own —
 * callers should treat this as one layer alongside the existing hardcoded
 * weekend gate, not the only line of defense.
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SymbolSpec } from './entities/symbol-spec.entity';
import { Mt5Service, WeekSessions } from '../mt5/mt5.service';

export interface LotRules {
  minLot:  number;
  maxLot:  number;
  lotStep: number;
}

const STALE_MS    = 24 * 60 * 60 * 1000; // 24h
const LOT_FALLBACK: LotRules = { minLot: 0.01, maxLot: 100, lotStep: 0.01 };

const DAY_NAMES = [
  'SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY',
] as const;

@Injectable()
export class SymbolSpecService {
  private readonly logger = new Logger(SymbolSpecService.name);

  constructor(
    @InjectRepository(SymbolSpec)
    private readonly repo: Repository<SymbolSpec>,
    private readonly mt5: Mt5Service,
  ) {}

  /** Fetch-or-return-cached SymbolSpec row, syncing from MetaApi if stale. */
  private async syncIfStale(symbol: string): Promise<SymbolSpec | null> {
    const cached  = await this.repo.findOne({ where: { symbol } });
    const isStale = !cached || (Date.now() - new Date(cached.updatedAt).getTime() > STALE_MS);

    if (!isStale) return cached;

    try {
      const [spec, serverTime] = await Promise.all([
        this.mt5.getSymbolSpecification(symbol),
        this.mt5.getServerTime(),
      ]);
      const saved = await this.repo.save({
        id:                  cached?.id,
        symbol,
        minLot:              spec.minVolume,
        maxLot:              spec.maxVolume,
        lotStep:             spec.volumeStep,
        digits:              spec.digits,
        contractSize:        spec.contractSize,
        tradeSessions:       spec.tradeSessions,
        brokerOffsetMinutes: serverTime.offsetMinutes,
      });
      this.logger.log(
        `Synced ${symbol} from broker — minLot=${saved.minLot} step=${saved.lotStep} ` +
        `max=${saved.maxLot} brokerOffset=${serverTime.offsetMinutes >= 0 ? '+' : ''}${serverTime.offsetMinutes}min`,
      );
      return saved;
    } catch (e: any) {
      if (cached) {
        this.logger.warn(`Sync failed for ${symbol} (${e?.message}) — using cached value from ${cached.updatedAt}`);
        return cached;
      }
      this.logger.warn(`Sync failed for ${symbol} (${e?.message}) — no cache yet, using permissive defaults`);
      return null;
    }
  }

  /** Returns lot-sizing rules for a symbol, syncing from the broker if stale. */
  async getLotRules(symbol: string): Promise<LotRules> {
    const row = await this.syncIfStale(symbol);
    if (!row) return LOT_FALLBACK;
    return { minLot: +row.minLot, maxLot: +row.maxLot, lotStep: +row.lotStep };
  }

  /**
   * Is the broker's market genuinely open for this symbol right now?
   * Converts `at` (real UTC) into the broker's local wall-clock using the
   * cached offset, then checks it against that day's tradeSessions ranges.
   *
   * Fails OPEN (returns true) if there's no cached schedule yet and a live
   * sync isn't possible — this check is meant to be layered alongside the
   * existing hardcoded weekend gate (TradingService.isWeekendMarketClosed),
   * never the sole gate, so it's safe to be permissive when uncertain.
   */
  async isMarketOpen(symbol: string, at: Date = new Date()): Promise<boolean> {
    const row = await this.syncIfStale(symbol);
    if (!row || !row.tradeSessions || row.brokerOffsetMinutes == null) {
      return true; // unknown — defer to the hardcoded weekend gate instead
    }

    const brokerLocal = new Date(at.getTime() + row.brokerOffsetMinutes * 60_000);
    const dayName      = DAY_NAMES[brokerLocal.getUTCDay()];
    const sessions     = (row.tradeSessions as unknown as WeekSessions)[dayName] ?? [];
    if (sessions.length === 0) return false; // broker has no trading hours at all today

    const hh = String(brokerLocal.getUTCHours()).padStart(2, '0');
    const mm = String(brokerLocal.getUTCMinutes()).padStart(2, '0');
    const ss = String(brokerLocal.getUTCSeconds()).padStart(2, '0');
    const nowStr = `${hh}:${mm}:${ss}.000`;

    return sessions.some(s => nowStr >= s.from && nowStr <= s.to);
  }
}
