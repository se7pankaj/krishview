import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Approval } from './entities/approval.entity';
import { ApprovalService } from './approval.service';

@Module({
  imports: [TypeOrmModule.forFeature([Approval])],
  providers: [ApprovalService],
  exports: [ApprovalService],
})
export class ApprovalModule {}
