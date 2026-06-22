/**
 * symbol/entities/symbol-spec.entity.ts — Broker-Verified Lot Sizing Rules
 * ===========================================================================
 * Cached copy of MetaApi's per-symbol specification (minVolume/maxVolume/
 * volumeStep), so RiskService doesn't have to hit MetaApi on every single
 * trade. Synced lazily by SymbolSpecService — refreshed if older than 24h.
 *
 * Replaces the hardcoded 0.01 lot floor that used to live directly inside
 * RiskService.calcLotSize() — that hardcoded value is exactly what allowed
 * the position-sizing bug on ticket #1412058401 (a 328pt SL silently risked
 * 9.3% of balance because nothing checked the broker's real minimum/step).
 */

import { Entity, PrimaryGeneratedColumn, Column, UpdateDateColumn } from 'typeorm';

@Entity('symbol_specs')
export class SymbolSpec {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true })
  symbol: string;

  /** Smallest order size the broker accepts for this symbol */
  @Column({ type: 'decimal', precision: 10, scale: 5 })
  minLot: number;

  /** Largest order size the broker accepts in a single order */
  @Column({ type: 'decimal', precision: 10, scale: 5 })
  maxLot: number;

  /** Increment between valid lot sizes (e.g. 0.01, 0.1, 1.0) */
  @Column({ type: 'decimal', precision: 10, scale: 5 })
  lotStep: number;

  @Column({ type: 'int', nullable: true })
  digits: number;

  @Column({ type: 'decimal', precision: 14, scale: 2, nullable: true })
  contractSize: number;

  /**
   * Broker's real open-for-trading hours per day of week, straight from
   * MetaApi (in broker-local time — see brokerOffsetMinutes to convert).
   * Replaces guessing "is the market open" from a hardcoded UTC heuristic.
   */
  @Column({ type: 'jsonb', nullable: true })
  tradeSessions: Record<string, { from: string; to: string }[]>;

  /**
   * Broker's current UTC offset in minutes, captured at the same time as
   * tradeSessions so the two stay consistent. Account-wide, not really
   * per-symbol, but stored alongside each row for simplicity — refreshed
   * together every sync, so it self-corrects through DST changes.
   */
  @Column({ type: 'int', nullable: true })
  brokerOffsetMinutes: number;

  @UpdateDateColumn()
  updatedAt: Date;
}
