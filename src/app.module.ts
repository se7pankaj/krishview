import path from 'node:path';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { TelegramModule } from './telegram/telegram.module';

// Entities
import { Signal } from './signals/entities/signal.entity';
import { Trade } from './journal/entities/trade.entity';
import { Analysis } from './analysis/entities/analysis.entity';
import { Approval } from './approval/entities/approval.entity';
import { SymbolSpec } from './symbol/entities/symbol-spec.entity';
import { AppConfig } from './config/entities/app-config.entity';

// Feature modules
import { AppConfigModule } from './config/app-config.module';
import { SymbolModule } from './symbol/symbol.module';
import { SignalsModule } from './signals/signals.module';
import { SmcModule } from './smc/smc.module';
import { Mt5Module } from './mt5/mt5.module';
import { JournalModule } from './journal/journal.module';
import { RiskModule } from './risk/risk.module';
import { TradingModule } from './trading/trading.module';
import { WebhookModule } from './webhook/webhook.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { AnalysisModule } from './analysis/analysis.module';
import { ApprovalModule } from './approval/approval.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { MlModule } from './ml/ml.module';

@Module({
  imports: [
    // Global config from .env
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: path.resolve(__dirname, '../.env'),
    }),

    // PostgreSQL via TypeORM
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host:     config.get<string>('DB_HOST'),
        port:     Number(config.get<string>('DB_PORT')),
        username: config.get<string>('DB_USERNAME'),
        password: config.get<string>('DB_PASSWORD'),
        database: config.get<string>('DB_DATABASE'),
        entities: [Signal, Trade, Analysis, Approval, SymbolSpec, AppConfig],
        synchronize: true, // auto-creates tables in dev; use migrations in prod
      }),
    }),

    // App config — global key-value store, must come before trading modules
    AppConfigModule,

    // Symbol registry — global singleton, must come before trading modules
    SymbolModule,

    // Domain modules
    SignalsModule,
    SmcModule,
    Mt5Module,
    JournalModule,
    RiskModule,
    AnalysisModule,
    ApprovalModule,
    AnalyticsModule,
    MlModule,
    TelegramModule,
    TradingModule,
    WebhookModule,
    DashboardModule,
  ],

  controllers: [AppController],

  providers: [
    AppService,
  ],
})
export class AppModule {}
