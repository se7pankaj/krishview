import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, UpdateDateColumn,
} from 'typeorm';

@Entity('trades')
export class Trade {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'bigint', nullable: true })
  ticket: number;

  @Column({ default: 'XAUUSD' })
  symbol: string;

  @Column({ length: 4 })
  direction: string; // 'BUY' | 'SELL'

  @Column({ type: 'decimal', precision: 8, scale: 2, nullable: true })
  lots: number;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  entryPrice: number;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  sl: number;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  tp: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  exitPrice: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  pnl: number;

  @Column({ type: 'decimal', precision: 5, scale: 2, nullable: true })
  rrPlanned: number;

  @Column({ type: 'decimal', precision: 5, scale: 2, nullable: true })
  rrActual: number;

  @Column({ type: 'decimal', precision: 5, scale: 1, default: 0 })
  confidence: number;

  /** OPEN | CLOSED */
  @Column({ default: 'OPEN' })
  status: string;

  /** JSON array of SMC reason strings */
  @Column({ type: 'jsonb', nullable: true })
  smcReasons: string[];

  @Column({ type: 'timestamp', nullable: true })
  openTime: Date;

  @Column({ type: 'timestamp', nullable: true })
  closeTime: Date;

  /** SL_HIT | TP_HIT | PARTIAL_TP | MANUAL */
  @Column({ nullable: true })
  closeReason: string;

  /** london | london_ny_overlap | newyork | asian */
  @Column({ nullable: true })
  session: string;

  @Column({ type: 'text', nullable: true })
  notes: string;

  // ── Sprint 3.2 — Active SL Management ────────────────────────────────────

  /** ATR value at trade entry — used for trailing stop distance */
  @Column({ type: 'decimal', precision: 8, scale: 4, nullable: true })
  lastAtr: number;

  /** How many times SL was trailed (0 = never moved) */
  @Column({ type: 'int', default: 0 })
  trailCount: number;

  /** Whether Partial TP1 has been taken (50% closed at 1:1 RR) */
  @Column({ default: false })
  partialTpHit: boolean;

  /** Current SL after trailing (updated each move) */
  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  currentSl: number;

  /** Linked analysis record (Sprint 2) */
  @Column({ nullable: true })
  analysisId: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
