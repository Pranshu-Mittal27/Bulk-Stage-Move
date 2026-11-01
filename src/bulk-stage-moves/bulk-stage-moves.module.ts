import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { BulkJobLeaseService } from './bulk-job-lease.service.js';
import { BulkJobProcessingService } from './bulk-job-processing.service.js';
import { BulkStageMovesController } from './bulk-stage-moves.controller.js';
import { BulkStageMovesService } from './bulk-stage-moves.service.js';

@Module({
  imports: [DatabaseModule],
  controllers: [BulkStageMovesController],
  providers: [
    BulkJobLeaseService,
    BulkJobProcessingService,
    BulkStageMovesService,
  ],
  exports: [BulkJobLeaseService, BulkJobProcessingService],
})
export class BulkStageMovesModule {}
