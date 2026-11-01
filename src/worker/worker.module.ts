import { Module } from '@nestjs/common';
import { BulkJobLeaseService } from '../bulk-stage-moves/bulk-job-lease.service.js';
import { BulkJobProcessingService } from '../bulk-stage-moves/bulk-job-processing.service.js';
import { BulkStageMovesModule } from '../bulk-stage-moves/bulk-stage-moves.module.js';
import { BulkJobWorkerService } from './worker.service.js';
import { parseWorkerConfig } from './worker.config.js';

@Module({
  imports: [BulkStageMovesModule],
  providers: [
    {
      provide: 'WORKER_CONFIG',
      useFactory: () => parseWorkerConfig(process.env),
    },
    {
      provide: BulkJobWorkerService,
      useFactory: (
        leases: BulkJobLeaseService,
        processing: BulkJobProcessingService,
        config: ReturnType<typeof parseWorkerConfig>,
      ) => new BulkJobWorkerService(leases, processing, config),
      inject: [BulkJobLeaseService, BulkJobProcessingService, 'WORKER_CONFIG'],
    },
  ],
})
export class WorkerModule {}
