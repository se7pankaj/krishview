import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, UpdateDateColumn,
} from 'typeorm';

/**
 * Approval lifecycle:
 *  PENDING  → waiting for Telegram tap
 *  APPROVED → user tapped [✅ APPROVE]
 *  REJECTED → user tapped [❌ REJECT]
 *  EXPIRED  → timeout reached before any tap
 */
export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';

@Entity('approvals')
export class Approval {
  @PrimaryGeneratedColumn()
  id: number;

  /** Linked Analysis record */
  @Column()
  analysisId: number;

  /** Symbol e.g. XAUUSD */
  @Column()
  symbol: string;

  /** Trade direction: BUY | SELL */
  @Column()
  direction: string;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  entry: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  sl: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  tp: number;

  @Column({ type: 'decimal', precision: 5, scale: 2, nullable: true })
  rr: number;

  @Column({ type: 'decimal', precision: 5, scale: 1, nullable: true })
  confidence: number;

  /** Telegram message_id of the approval message (for editing after decision) */
  @Column({ nullable: true })
  telegramMsgId: number;

  /** Telegram chat_id where the message was sent */
  @Column({ nullable: true })
  telegramChatId: string;

  /** When the approval request expires (default: 15 min — doc §14.4, FR-015) */
  @Column({ type: 'timestamptz', nullable: true })
  expiresAt: Date;

  @Column({ default: 'PENDING' })
  status: ApprovalStatus;

  /** Exact timestamp when human made the approve/reject decision (doc §17.4) */
  @Column({ type: 'timestamptz', nullable: true })
  decisionAt: Date;

  /** Who approved/rejected (always 'telegram' for now) */
  @Column({ nullable: true })
  decidedBy: string;

  /**
   * Optional rejection reason captured after REJECT tap (doc §14.3).
   * Values: TOO_RISKY | WRONG_TIMING | NOT_CONFIDENT | NEWS_RISK | OTHER
   */
  @Column({ length: 100, nullable: true })
  rejectionReason: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
