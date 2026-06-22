/**
 * telegram.service.ts — Telegram Notification + Approval Service
 * ================================================================
 * Sends trade alerts, daily summaries, and error notifications.
 * Sprint 2: Adds inline keyboard approval buttons and getUpdates polling.
 */

import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { SMCSignal } from './smc/smc.service';
import { DailyStats } from './journal/journal.service';
import { ApprovalService } from './approval/approval.service';
import { ConfidenceBreakdown, ConfidenceExplainerService } from './analysis/confidence-explainer.service';

// ─── Types ────────────────────────────────────────────────────────────────────

interface SendResult {
  message_id: number;
  chat: { id: number | string };
}

export interface ApprovalSignal {
  approvalId:  number;
  analysisId:  number;
  symbol:      string;
  direction:   string;
  entry:       number;
  sl:          number;
  tp:          number;
  rr:          number;
  confidence:  number;
  reasons:     string[];
  aiUsed:      boolean;
  breakdown?:  ConfidenceBreakdown;
  /** The real gate that decided this trade (ConfluenceResult), shown
   *  separately from the breakdown so the two are never confused. */
  tradingTier?:   number;
  tierThreshold?: number;
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class TelegramService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TelegramService.name);
  private readonly token:  string;
  private readonly chatId: string;
  private readonly base:   string;

  /** Last update_id seen from getUpdates — avoids re-processing same callbacks */
  private lastUpdateId = 0;

  constructor(
    private readonly config:    ConfigService,
    private readonly approval:  ApprovalService,
    private readonly explainer: ConfidenceExplainerService,
  ) {
    this.token  = this.config.get<string>('TELEGRAM_BOT_TOKEN', '');
    this.chatId = this.config.get<string>('TELEGRAM_CHAT_ID', '');
    this.base   = `https://api.telegram.org/bot${this.token}`;
  }

  /** Start polling for callback_query updates after app boots */
  onApplicationBootstrap(): void {
    if (!this.token) return;
    // Expire any stale approvals from a previous run
    this.approval.expireStale().then(n => {
      if (n > 0) this.logger.warn(`Expired ${n} stale approvals from previous session`);
    });
    // Start polling loop (every 3 seconds)
    setInterval(() => this.pollUpdates(), 3_000);
    this.logger.log('Telegram getUpdates polling started');
  }

  // ─── Core send ─────────────────────────────────────────────────────────────

  /** Send a plain text message (HTML parse mode). Returns message_id. */
  async sendMessage(text: string, replyMarkup?: object): Promise<SendResult | null> {
    if (!this.token || !this.chatId) {
      this.logger.warn('Telegram not configured — skipping notification');
      return null;
    }
    try {
      const payload: any = {
        chat_id:    this.chatId,
        text,
        parse_mode: 'HTML',
      };
      if (replyMarkup) payload.reply_markup = replyMarkup;

      const resp = await axios.post<{ ok: boolean; result: SendResult }>(
        `${this.base}/sendMessage`, payload,
      );
      return resp.data.result;
    } catch (e: any) {
      this.logger.error(`Telegram send failed: ${e?.message}`);
      return null;
    }
  }

  /** Edit an existing message (used to update buttons after decision) */
  async editMessage(msgId: number, text: string): Promise<void> {
    if (!this.token || !this.chatId) return;
    try {
      await axios.post(`${this.base}/editMessageText`, {
        chat_id:    this.chatId,
        message_id: msgId,
        text,
        parse_mode: 'HTML',
        // Remove inline keyboard
        reply_markup: { inline_keyboard: [] },
      });
    } catch (e: any) {
      // "message is not modified" is harmless
      if (!e?.response?.data?.description?.includes('not modified')) {
        this.logger.error(`Telegram editMessage failed: ${e?.message}`);
      }
    }
  }

  /** Answer a callback_query to remove the loading spinner on the button */
  private async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    try {
      await axios.post(`${this.base}/answerCallbackQuery`, {
        callback_query_id: callbackQueryId,
        text: text ?? '',
      });
    } catch { /* ignore */ }
  }

  // ─── Approval message ──────────────────────────────────────────────────────

  /**
   * Send trade approval message with [✅ APPROVE] [❌ REJECT] inline keyboard.
   * Returns the Telegram message_id.
   */
  async sendApprovalMessage(signal: ApprovalSignal): Promise<number | null> {
    const dirEmoji = signal.direction === 'BUY' ? '📈' : '📉';
    const risk     = Math.abs(signal.entry - signal.sl).toFixed(2);
    const reward   = Math.abs(signal.tp    - signal.entry).toFixed(2);
    const badge    = signal.aiUsed ? '🤖 AI' : '📊 SMC';

    // This is the REAL number that decided this trade reached approval —
    // always shown, regardless of whether an explainability breakdown exists.
    const tierLine = signal.tierThreshold
      ? `Approval Score: <b>${signal.confidence}%</b>  (Tier ${signal.tradingTier ?? '?'} ≥ ${signal.tierThreshold}% required) ✅\n`
      : `Approval Score: <b>${signal.confidence}%</b>\n`;

    // Informational-only breakdown — uses a different scoring formula than
    // the approval gate above, so it's explicitly labelled to avoid the two
    // numbers being mistaken for each other.
    const breakdownBlock = signal.breakdown
      ? this.explainer.formatTelegram(signal.breakdown)
      : '';

    const text =
      `${dirEmoji} <b>Trade Approval Required</b> ${badge}\n\n` +
      `Pair:      <b>${signal.symbol}</b>  |  Direction: <b>${signal.direction}</b>\n` +
      `Entry:  <code>${signal.entry}</code>\n` +
      `SL:     <code>${signal.sl}</code>  (-${risk} pts)\n` +
      `TP:     <code>${signal.tp}</code>  (+${reward} pts)\n` +
      `RR:     <b>1:${signal.rr}</b>\n` +
      tierLine +
      breakdownBlock + '\n\n' +
      `<b>Key Reasons:</b>\n${signal.reasons.slice(0, 4).map(r => `  • ${r}`).join('\n')}\n\n` +
      `⏳ Expires in ${this.config.get('APPROVAL_TIMEOUT_MINUTES', '5')} min  |  ` +
      `<i>#${signal.approvalId}</i>`;

    const replyMarkup = {
      inline_keyboard: [[
        {
          text:          '✅ APPROVE',
          callback_data: `approve:${signal.approvalId}`,
        },
        {
          text:          '❌ REJECT',
          callback_data: `reject:${signal.approvalId}`,
        },
      ]],
    };

    const result = await this.sendMessage(text, replyMarkup);
    return result?.message_id ?? null;
  }

  // ─── getUpdates polling ───────────────────────────────────────────────────

  private async pollUpdates(): Promise<void> {
    if (!this.token) return;
    try {
      const resp = await axios.get<{ ok: boolean; result: any[] }>(
        `${this.base}/getUpdates`,
        {
          params: {
            offset:  this.lastUpdateId + 1,
            timeout: 0,
            allowed_updates: ['callback_query'],
          },
          timeout: 5_000,
        },
      );

      const updates: any[] = resp.data?.result ?? [];
      for (const update of updates) {
        this.lastUpdateId = update.update_id;

        if (update.callback_query) {
          await this.handleCallback(update.callback_query);
        }
      }
    } catch (e: any) {
      // Log only unexpected errors (timeout / network blips are normal in dev)
      if (!e?.code?.includes('TIMEOUT') && !e?.message?.includes('timeout')) {
        this.logger.warn(`getUpdates error: ${e?.message}`);
      }
    }
  }

  private async handleCallback(cb: any): Promise<void> {
    const data: string = cb.data ?? '';
    const cbId: string = cb.id;
    const msgId: number = cb.message?.message_id;

    this.logger.log(`Telegram callback: ${data}`);

    if (data.startsWith('approve:') || data.startsWith('reject:')) {
      const [action, idStr] = data.split(':');
      const approvalId = parseInt(idStr, 10);

      if (isNaN(approvalId)) {
        await this.answerCallback(cbId, '❌ Invalid approval ID');
        return;
      }

      let updated: any;
      if (action === 'approve') {
        updated = await this.approval.approve(approvalId);
      } else {
        updated = await this.approval.reject(approvalId);
      }

      if (!updated) {
        await this.answerCallback(cbId, '⚠️ Approval already resolved or not found');
        return;
      }

      // Acknowledge the button tap
      await this.answerCallback(
        cbId,
        action === 'approve' ? '✅ Trade approved!' : '❌ Trade rejected',
      );

      // Edit the original message to show the decision
      const decisionText = action === 'approve'
        ? `✅ <b>APPROVED</b> — Executing trade...`
        : `❌ <b>REJECTED</b> — Signal discarded`;

      if (msgId) {
        const originalText = cb.message?.text ?? '';
        await this.editMessage(msgId, `${originalText}\n\n${decisionText}`);
      }
    }
  }

  // ─── Existing notifications ────────────────────────────────────────────────

  async notifyStartup(account: { login: number; balance: number; server: string }): Promise<void> {
    await this.sendMessage(
      `🚀 <b>KrishView Online</b>\n\n` +
      `Account: <code>#${account.login}</code>\n` +
      `Balance: <b>$${account.balance.toFixed(2)}</b>\n` +
      `Server:  ${account.server}\n\n` +
      `SMC analysis active. Awaiting setups...\n` +
      `<i>For Krishiv ❤️</i>`,
    );
  }

  async notifySignal(signal: SMCSignal, symbol: string): Promise<void> {
    const dirEmoji = signal.direction === 'BUY' ? '📈' : '📉';
    const reasons  = signal.reasons.map(r => `  • ${r}`).join('\n');
    const risk     = Math.abs(signal.entryPrice - signal.sl).toFixed(2);
    const reward   = Math.abs(signal.tp - signal.entryPrice).toFixed(2);

    await this.sendMessage(
      `${dirEmoji} <b>KrishView SMC Signal</b>\n\n` +
      `Instrument: <b>${symbol}</b>\n` +
      `Direction:  <b>${signal.direction}</b>\n` +
      `Confidence: <b>${signal.confidence}%</b>\n\n` +
      `Entry:  <code>${signal.entryPrice}</code>\n` +
      `SL:     <code>${signal.sl}</code>  (-$${risk})\n` +
      `TP:     <code>${signal.tp}</code>  (+$${reward})\n` +
      `RR:     <b>1:${signal.rr}</b>\n\n` +
      `<b>Reasons:</b>\n${reasons}`,
    );
  }

  async notifyEntry(signal: SMCSignal, ticket: number, lots: number, symbol: string): Promise<void> {
    const dirEmoji = signal.direction === 'BUY' ? '📈' : '📉';
    await this.sendMessage(
      `✅ <b>Trade Executed</b> ${dirEmoji}\n\n` +
      `Ticket: <code>#${ticket}</code>\n` +
      `Pair:   <b>${symbol}</b>\n` +
      `Side:   <b>${signal.direction}</b>\n` +
      `Entry:  <code>${signal.entryPrice}</code>\n` +
      `Lots:   <code>${lots}</code>\n` +
      `SL:     <code>${signal.sl}</code>\n` +
      `TP:     <code>${signal.tp}</code>`,
    );
  }

  async notifyExit(ticket: number, direction: string, exitPrice: number, pnl: number, closeReason: string): Promise<void> {
    const emoji = pnl >= 0 ? '💰' : '🔴';
    const sign  = pnl >= 0 ? '+' : '';
    await this.sendMessage(
      `${emoji} <b>Trade Closed</b>\n\n` +
      `Ticket: <code>#${ticket}</code>\n` +
      `Side:   ${direction}\n` +
      `Exit:   <code>${exitPrice}</code>\n` +
      `PnL:    <b>${sign}$${pnl.toFixed(2)}</b>\n` +
      `Reason: ${closeReason}`,
    );
  }

  async notifySignalSkipped(reason: string): Promise<void> {
    await this.sendMessage(`⏭️ <b>Signal Skipped</b>\n\n${reason}`);
  }

  async notifyDailyReport(stats: DailyStats, balance: number): Promise<void> {
    const pnlSign = stats.totalPnL >= 0 ? '+' : '';
    const emoji   = stats.totalPnL >= 0 ? '📊' : '📉';
    await this.sendMessage(
      `${emoji} <b>Daily Report</b>\n\n` +
      `Balance:   <b>$${balance.toFixed(2)}</b>\n` +
      `Daily PnL: <b>${pnlSign}$${stats.totalPnL.toFixed(2)}</b>\n` +
      `Trades:    ${stats.total} (${stats.wins}W / ${stats.losses}L)\n` +
      `Win Rate:  <b>${stats.winRate}%</b>`,
    );
  }

  async notifyError(err: Error | string): Promise<void> {
    const msg = typeof err === 'string' ? err : err.message;
    await this.sendMessage(`🚨 <b>KrishView Error</b>\n\n<code>${msg}</code>`);
  }

  async notifyDailyLossLimit(lossPct: number): Promise<void> {
    await this.sendMessage(
      `🛑 <b>Daily Loss Limit Hit</b>\n\n` +
      `Loss: <b>${lossPct.toFixed(2)}%</b> of account\n` +
      `Trading suspended until next session.`,
    );
  }
}
