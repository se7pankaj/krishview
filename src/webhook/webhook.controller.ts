/**
 * webhook/webhook.controller.ts — TradingView Alert Receiver
 * ============================================================
 * POST /webhook  — receives JSON alerts from TradingView Pine Script.
 * Validates the shared secret then delegates to TradingService.
 *
 * TradingView alert JSON format:
 *   { "symbol": "XAUUSD", "action": "BUY", "timeframe": "M15",
 *     "price": 2351.20, "reason": "SMC BOS", "secret": "..." }
 */

import {
  Controller, Post, Body, Headers, HttpCode,
  UnauthorizedException, Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TradingService } from '../trading/trading.service';

interface WebhookPayload {
  symbol:    string;
  action:    'BUY' | 'SELL' | 'CLOSE_ALL' | 'CLOSE_BUY' | 'CLOSE_SELL';
  timeframe?: string;
  price?:    number;
  reason?:   string;
  secret?:   string;
}

@Controller('webhook')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);
  private readonly secret: string;

  constructor(
    private readonly config:  ConfigService,
    private readonly trading: TradingService,
  ) {
    this.secret = this.config.get<string>('WEBHOOK_SECRET', '');
  }

  @Post()
  @HttpCode(200)
  async handleAlert(
    @Body() body: WebhookPayload,
    @Headers('x-webhook-token') headerToken?: string,
  ): Promise<{ ok: boolean }> {
    // Token from header OR from body
    const token = headerToken ?? body.secret ?? '';

    if (this.secret && token !== this.secret) {
      this.logger.warn('Webhook: invalid token rejected');
      throw new UnauthorizedException('Invalid webhook token');
    }

    const action = (body.action ?? '').toUpperCase() as WebhookPayload['action'];
    const validActions = ['BUY', 'SELL', 'CLOSE_ALL', 'CLOSE_BUY', 'CLOSE_SELL'];

    if (!validActions.includes(action)) {
      this.logger.warn(`Webhook: unknown action "${action}"`);
      return { ok: false };
    }

    this.logger.log(`Webhook received: ${action} ${body.symbol} @ ${body.price}`);

    // Fire and forget — don't block the HTTP response
    this.trading.handleWebhookAlert({
      symbol:    body.symbol ?? 'XAUUSD',
      action:    action as 'BUY' | 'SELL' | 'CLOSE_ALL',
      timeframe: body.timeframe ?? 'M15',
      price:     body.price ?? 0,
      reason:    body.reason,
    }).catch(e => this.logger.error(`Webhook handler error: ${e.message}`));

    return { ok: true };
  }
}
