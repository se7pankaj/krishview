import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { TelegramService } from './telegram.service';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly telegramService: TelegramService,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
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