/**
 * approval/approval.service.ts — Human-in-the-Loop Approval Gate
 * ================================================================
 * Manages the lifecycle of trade approvals:
 *   create → send Telegram message → wait for tap → approve/reject/expire
 *
 * Resolution is done via a Promise that callers await.
 * When the Telegram polling loop (in TelegramService) receives a callback_query,
 * it calls approve() or reject() which resolves the waiting Promise.
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Approval, ApprovalStatus } from './entities/approval.entity';

export interface ApprovalRequest {
  analysisId: number;
  symbol:     string;
  direction:  string;
  entry:      number;
  sl:         number;
  tp:         number;
  rr:         number;
  confidence: number;
}

export type ApprovalDecision = 'APPROVED' | 'REJECTED' | 'EXPIRED';

@Injectable()
export class ApprovalService {
  private readonly logger = new Logger(ApprovalService.name);

  /** pending resolvers: approvalId → resolve function */
  private readonly resolvers = new Map<number, (decision: ApprovalDecision) => void>();

  constructor(
    @InjectRepository(Approval)
    private readonly repo: Repository<Approval>,
    private readonly config: ConfigService,
  ) {}

  private get timeoutMinutes(): number {
    return parseInt(this.config.get<string>('APPROVAL_TIMEOUT_MINUTES', '5'), 10);
  }

  /**
   * Create a new approval record and return it.
   * The Telegram message ID is stored after sending via setTelegramMsgId().
   */
  async create(req: ApprovalRequest): Promise<Approval> {
    const expiresAt = new Date(Date.now() + this.timeoutMinutes * 60_000);
    const approval = this.repo.create({ ...req, status: 'PENDING', expiresAt });
    return this.repo.save(approval);
  }

  /** Store the Telegram message reference after sending */
  async setTelegramMsgId(id: number, msgId: number, chatId: string): Promise<void> {
    await this.repo.update(id, { telegramMsgId: msgId, telegramChatId: chatId });
  }

  /**
   * Wait for a human decision on this approval.
   * Returns 'APPROVED', 'REJECTED', or 'EXPIRED' when resolved.
   */
  waitForDecision(approvalId: number): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve) => {
      this.resolvers.set(approvalId, resolve);

      // Auto-expire after timeout
      const ms = this.timeoutMinutes * 60_000;
      setTimeout(async () => {
        if (this.resolvers.has(approvalId)) {
          this.resolvers.delete(approvalId);
          await this.repo.update(approvalId, { status: 'EXPIRED' });
          this.logger.warn(`Approval #${approvalId} expired after ${this.timeoutMinutes}m`);
          resolve('EXPIRED');
        }
      }, ms);
    });
  }

  /** Called by Telegram polling when user taps [✅ APPROVE] */
  async approve(approvalId: number): Promise<Approval | null> {
    return this.resolve(approvalId, 'APPROVED');
  }

  /** Called by Telegram polling when user taps [❌ REJECT] */
  async reject(approvalId: number): Promise<Approval | null> {
    return this.resolve(approvalId, 'REJECTED');
  }

  private async resolve(
    approvalId: number,
    decision: 'APPROVED' | 'REJECTED',
  ): Promise<Approval | null> {
    const approval = await this.repo.findOne({ where: { id: approvalId } });
    if (!approval || approval.status !== 'PENDING') {
      this.logger.warn(`Approval #${approvalId} not found or not PENDING`);
      return null;
    }

    await this.repo.update(approvalId, { status: decision, decidedBy: 'telegram', decisionAt: new Date() });

    const resolver = this.resolvers.get(approvalId);
    if (resolver) {
      this.resolvers.delete(approvalId);
      resolver(decision);
    }

    this.logger.log(`Approval #${approvalId} → ${decision}`);
    return { ...approval, status: decision };
  }

  /** Find approval by Telegram message ID (used by polling callback handler) */
  async findByMsgId(msgId: number): Promise<Approval | null> {
    return this.repo.findOne({ where: { telegramMsgId: msgId, status: 'PENDING' } });
  }

  /** Expire any stale PENDING approvals on startup / periodic cleanup */
  async expireStale(): Promise<number> {
    const result = await this.repo.update(
      { status: 'PENDING', expiresAt: LessThan(new Date()) },
      { status: 'EXPIRED' },
    );
    return result.affected ?? 0;
  }

  async getAll(limit = 50): Promise<Approval[]> {
    return this.repo.find({ order: { createdAt: 'DESC' }, take: limit });
  }
}
