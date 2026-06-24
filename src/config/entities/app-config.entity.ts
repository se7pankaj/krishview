import { Entity, PrimaryColumn, Column, UpdateDateColumn } from 'typeorm';

/**
 * Generic key-value store for runtime application settings.
 * Used to persist things like TRADING_MODE that must survive a restart
 * and be switchable from the dashboard without touching .env.
 */
@Entity('app_config')
export class AppConfig {
  @PrimaryColumn({ type: 'varchar', length: 100 })
  key: string;

  @Column({ type: 'text' })
  value: string;

  @UpdateDateColumn()
  updatedAt: Date;
}
