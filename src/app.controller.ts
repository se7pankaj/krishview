import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { TelegramService } from './telegram.service';

@Controller()
export class AppController {
  private readonly startedAt = new Date();

  constructor(
    private readonly appService: AppService,
    private readonly telegramService: TelegramService,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  /** GET /health — System health check (doc §5.4, §25.1) */
  @Get('health')
  health() {
    const uptimeSec = Math.floor((Date.now() - this.startedAt.getTime()) / 1000);
    const h = Math.floor(uptimeSec / 3600);
    const m = Math.floor((uptimeSec % 3600) / 60);
    const s = uptimeSec % 60;

    return {
      status:    'ok',
      version:   '1.0.0',
      name:      'KrishView',
      startedAt: this.startedAt.toISOString(),
      uptime:    `${h}h ${m}m ${s}s`,
      timestamp: new Date().toISOString(),
    };
  }

  @Get('telegram/test')
  async telegramTest() {
    await this.telegramService.sendMessage(
      '🚀 KrishView is alive!\n\nFounder: Pankaj\nInspired by: Krishiv ❤️',
    );

    return {
      success: true,
      message: 'Telegram message sent',
    };
  }
}
