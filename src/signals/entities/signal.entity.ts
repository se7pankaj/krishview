import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

@Entity('signals')
export class Signal {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  symbol!: string;

  @Column()
  signal!: string;

  @Column('decimal', {
    precision: 10,
    scale: 2,
  })
  price!: number;

  @CreateDateColumn()
  createdAt!: Date;
}