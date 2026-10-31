import { ApiProperty } from '@nestjs/swagger';
import {
  BulkJobHealthStatus,
  BulkJobStatus,
} from '../../generated/prisma/enums.js';

export class BulkStageMoveResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: BulkJobStatus })
  status!: BulkJobStatus;

  @ApiProperty({ enum: BulkJobHealthStatus })
  health!: BulkJobHealthStatus;

  @ApiProperty({ format: 'uuid' })
  targetStageId!: string;

  @ApiProperty({ minimum: 0 })
  matchedCount!: number;

  @ApiProperty({ minimum: 0 })
  processedCount!: number;

  @ApiProperty({ minimum: 0 })
  movedCount!: number;

  @ApiProperty({ minimum: 0 })
  skippedCount!: number;

  @ApiProperty({ minimum: 0 })
  failedCount!: number;

  @ApiProperty({ minimum: 0 })
  pendingCount!: number;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time', nullable: true })
  startedAt!: string | null;

  @ApiProperty({ format: 'date-time', nullable: true })
  completedAt!: string | null;

  @ApiProperty({ format: 'date-time', nullable: true })
  heartbeatAt!: string | null;

  @ApiProperty({ format: 'date-time', nullable: true })
  lastProgressAt!: string | null;

  @ApiProperty({ nullable: true })
  failureCode!: string | null;

  @ApiProperty({ nullable: true })
  failureMessage!: string | null;

  @ApiProperty({ nullable: true })
  waitingReason!: string | null;
}
