import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, Repository } from 'typeorm';

import { Signal } from './entities/signal.entity';
import { CreateSignalDto } from './dto/create-signal.dto';
import { TelegramService } from '../telegram.service';

@Injectable()
export class SignalsService {
  constructor(
    @InjectRepository(Signal)
    private readonly signalRepository: Repository<Signal>,

    private readonly telegramService: TelegramService,
  ) {}

  async create(dto: CreateSignalDto): Promise<Signal> {
    const signal = this.signalRepository.create(dto as DeepPartial<Signal>);

    const savedSignal = await this.signalRepository.save(signal as Signal);

    await this.telegramService.sendMessage(
      `🚀 New Signal\n\n` +
      `Symbol: ${savedSignal.symbol}\n` +
      `Signal: ${savedSignal.signal}\n` +
      `Price: ${savedSignal.price}`,
    );

    return savedSignal;
  }

  async findAll(): Promise<Signal[]> {
    return this.signalRepository.find({
      order: {
        createdAt: 'DESC',
      },
    });
  }
}