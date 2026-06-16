import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, ManyToOne, JoinColumn,
} from 'typeorm';
import { Signal } from '../../signals/entities/signal.entity';

@Entity('analyses')
export class Analysis {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ nullable: true })
  signalId: number;

  @Column({ nullable: true })
  symbol: string;

  /** Full computed feature snapshot — stored as JSONB for flexible querying */
  @Column({ type: 'jsonb', nullable: true })
  features: Record<string, any>;

  /** Raw SMC engine output */
  @Column({ type: 'jsonb', nullable: true })
  smcSignal: Record<string, any>;

  /** GPT-4 recommendation */
  @Column({ nullable: true })
  aiDecision: string;   // BUY | SELL | WAIT

  @Column({ type: 'decimal', precision: 5, scale: 1, nullable: true })
  aiConfidence: number;

  @Column({ nullable: true })
  aiEntry: string;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  aiStopLoss: number;

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  aiTakeProfit: number;

  @Column({ type: 'decimal', precision: 5, scale: 2, nullable: true })
  aiRR: number;

  @Column({ type: 'jsonb', nullable: true })
  aiReasons: string[];

  @Column({ type: 'jsonb', nullable: true })
  aiRisks: string[];

  @Column({ nullable: true })
  gptModel: string;

  @Column({ nullable: true })
  promptTokens: number;

  @Column({ nullable: true })
  completionTokens: number;

  /**
   * Explainability Engine breakdown — stored alongside features so dashboard
   * and Telegram can show WHY the confidence is what it is.
   * Shape matches ConfidenceBreakdown from confidence-explainer.service.ts
   */
  @Column({ type: 'jsonb', nullable: true })
  breakdown: Record<string, any>;

  /**
   * Lifecycle: PENDING → AWAITING_APPROVAL → APPROVED | REJECTED | EXPIRED | SKIPPED
   */
  @Column({ default: 'PENDING' })
  status: string;

  @CreateDateColumn()
  createdAt: Date;
}
