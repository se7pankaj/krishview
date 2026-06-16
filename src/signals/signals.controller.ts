import { Body, Controller, Get, Post } from '@nestjs/common';

import { SignalsService } from './signals.service';
import { CreateSignalDto } from './dto/create-signal.dto';

@Controller('signals')
export class SignalsController {
  constructor(
    private readonly signalsService: SignalsService,
  ) {}

  @Post()
  create(
    @Body() dto: CreateSignalDto,
  ) {
    return this.signalsService.create(dto);
  }

  @Get()
  findAll() {
    return this.signalsService.findAll();
  }
}