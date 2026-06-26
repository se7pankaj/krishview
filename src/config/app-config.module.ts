import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppConfig } from './entities/app-config.entity';
import { AppConfigService } from './app-config.service';

@Global()
@Module({
  imports:   [TypeOrmModule.forFeature([AppConfig])],
  providers: [AppConfigService],
  exports:   [AppConfigService],
})
export class AppConfigModule {}
