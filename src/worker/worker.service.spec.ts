import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { performance } from 'node:perf_hooks';
import { BulkJobLeaseService } from '../bulk-stage-moves/bulk-job-lease.service.js';
import {
  BulkJobProcessingService,
  RetryableBulkJobProcessingError,
  type ProcessBulkJobBatchResult,
} from '../bulk-stage-moves/bulk-job-processing.service.js';
import { BulkJobStatus } from '../generated/prisma/enums.js';
import type { WorkerConfig } from './worker.config.js';
import { BulkJobWorkerService } from './worker.service.js';

const config: WorkerConfig = {
  workerId: 'worker-test',
  pollIntervalMs: 1_000,
  leaseDurationMs: 120_000,
};
const token = {
  jobId: '8eecb639-dda9-4ad3-b1f6-f91b39db45a0',
  leaseOwner: config.workerId,
  leaseGeneration: 1,
};
const claimed = {
  kind: 'claimed' as const,
  token,
  job: {
    id: token.jobId,
    workspaceId: 'c0f15139-f93f-4c8f-a03f-d56b67bef6c0',
    status: BulkJobStatus.running,
    leaseOwner: token.leaseOwner,
    leaseGeneration: token.leaseGeneration,
    leaseExpiresAt: new Date(),
    heartbeatAt: new Date(),
    startedAt: new Date(),
  },
};

function processed(status: BulkJobStatus): ProcessBulkJobBatchResult {
  return {
    kind: 'processed',
    batchProcessedCount: 1,
    movedCount: 1,
    skippedCount: 0,
    pendingCount: status === BulkJobStatus.running ? 1 : 0,
    status,
  };
}

describe('BulkJobWorkerService', () => {
  let leases: jest.Mocked<BulkJobLeaseService>;
  let processing: jest.Mocked<BulkJobProcessingService>;
  let worker: BulkJobWorkerService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    leases = {
      claimNext: jest.fn(),
      renew: jest.fn(),
    } as unknown as jest.Mocked<BulkJobLeaseService>;
    processing = {
      processBatch: jest.fn(),
    } as unknown as jest.Mocked<BulkJobProcessingService>;
    leases.renew.mockResolvedValue({
      kind: 'renewed',
      leaseExpiresAt: new Date(),
      heartbeatAt: new Date(),
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('polls again after an empty result and stops promptly on shutdown', async () => {
    leases.claimNext
      .mockResolvedValueOnce({ kind: 'empty' })
      .mockImplementationOnce(async () => {
        worker.requestShutdown();
        return { kind: 'empty' };
      });
    worker = new BulkJobWorkerService(leases, processing, config);

    const running = worker.run();
    await jest.advanceTimersByTimeAsync(0);
    expect(leases.claimNext).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(config.pollIntervalMs);
    await running;
    expect(leases.claimNext).toHaveBeenCalledTimes(2);
  });

  it('processes batches sequentially until a persisted terminal status', async () => {
    leases.claimNext.mockResolvedValueOnce(claimed);
    processing.processBatch
      .mockResolvedValueOnce(processed(BulkJobStatus.running))
      .mockImplementationOnce(async () => {
        worker.requestShutdown();
        return processed(BulkJobStatus.completed);
      });
    worker = new BulkJobWorkerService(leases, processing, config);

    await worker.run();

    expect(processing.processBatch).toHaveBeenCalledTimes(2);
    expect(processing.processBatch).toHaveBeenNthCalledWith(1, token);
    expect(processing.processBatch).toHaveBeenNthCalledWith(2, token);
    expect(leases.renew).toHaveBeenCalledTimes(1);
  });

  it.each(['completed', 'completed_with_errors', 'failed'] as const)(
    'stops processing on terminal status %s',
    async (status) => {
      leases.claimNext.mockResolvedValueOnce(claimed);
      processing.processBatch.mockResolvedValueOnce(
        processed(status as BulkJobStatus),
      );
      leases.claimNext.mockImplementationOnce(async () => {
        worker.requestShutdown();
        return { kind: 'empty' };
      });
      worker = new BulkJobWorkerService(leases, processing, config);

      await worker.run();

      expect(processing.processBatch).toHaveBeenCalledTimes(1);
      expect(leases.renew).not.toHaveBeenCalled();
    },
  );

  it('continues after recorded retry metadata only after a successful renewal', async () => {
    leases.claimNext.mockResolvedValueOnce(claimed);
    processing.processBatch
      .mockRejectedValueOnce(
        new RetryableBulkJobProcessingError(
          12n,
          'recorded',
          new Error('transaction conflict'),
        ),
      )
      .mockImplementationOnce(async () => {
        worker.requestShutdown();
        return processed(BulkJobStatus.completed);
      });
    worker = new BulkJobWorkerService(leases, processing, config);

    await worker.run();

    expect(leases.renew).toHaveBeenCalledTimes(1);
    expect(processing.processBatch).toHaveBeenCalledTimes(2);
  });

  it.each(['lease_lost', 'item_not_pending', 'failed'] as const)(
    'does not continue when retry metadata status is %s',
    async (metadataStatus) => {
      leases.claimNext.mockResolvedValueOnce(claimed);
      processing.processBatch.mockRejectedValueOnce(
        new RetryableBulkJobProcessingError(
          12n,
          metadataStatus,
          new Error('transaction conflict'),
          metadataStatus === 'failed'
            ? new Error('metadata write failed')
            : undefined,
        ),
      );
      leases.claimNext.mockImplementationOnce(async () => {
        worker.requestShutdown();
        return { kind: 'empty' };
      });
      worker = new BulkJobWorkerService(leases, processing, config);

      await worker.run();

      expect(processing.processBatch).toHaveBeenCalledTimes(1);
      expect(leases.renew).not.toHaveBeenCalled();
    },
  );

  it('backs off after claim errors and retries without terminating', async () => {
    leases.claimNext
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockImplementationOnce(async () => {
        worker.requestShutdown();
        return { kind: 'empty' };
      });
    worker = new BulkJobWorkerService(leases, processing, config);

    const running = worker.run();
    await jest.advanceTimersByTimeAsync(0);
    expect(leases.claimNext).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1_000);
    await running;
    expect(leases.claimNext).toHaveBeenCalledTimes(2);
  });

  it('stops a job on lease loss without issuing more batches', async () => {
    leases.claimNext.mockResolvedValueOnce(claimed);
    processing.processBatch.mockResolvedValueOnce({ kind: 'lease_lost' });
    leases.claimNext.mockImplementationOnce(async () => {
      worker.requestShutdown();
      return { kind: 'empty' };
    });
    worker = new BulkJobWorkerService(leases, processing, config);

    await worker.run();

    expect(processing.processBatch).toHaveBeenCalledTimes(1);
    expect(leases.renew).not.toHaveBeenCalled();
  });

  it('stops a job when renewal fails', async () => {
    leases.claimNext.mockResolvedValueOnce(claimed);
    processing.processBatch.mockResolvedValueOnce(
      processed(BulkJobStatus.running),
    );
    leases.renew.mockRejectedValueOnce(new Error('database unavailable'));
    leases.claimNext.mockImplementationOnce(async () => {
      worker.requestShutdown();
      return { kind: 'empty' };
    });
    worker = new BulkJobWorkerService(leases, processing, config);

    await worker.run();

    expect(processing.processBatch).toHaveBeenCalledTimes(1);
    expect(leases.renew).toHaveBeenCalledTimes(1);
  });

  it('does not continue batches when renewal reports lease loss', async () => {
    leases.claimNext.mockResolvedValueOnce(claimed);
    processing.processBatch.mockResolvedValueOnce(
      processed(BulkJobStatus.running),
    );
    leases.renew.mockResolvedValueOnce({ kind: 'lease_lost' });
    leases.claimNext.mockImplementationOnce(async () => {
      worker.requestShutdown();
      return { kind: 'empty' };
    });
    worker = new BulkJobWorkerService(leases, processing, config);

    await worker.run();

    expect(processing.processBatch).toHaveBeenCalledTimes(1);
    expect(leases.renew).toHaveBeenCalledTimes(1);
  });

  it('does not renew while a batch is running and stops after it settles on shutdown', async () => {
    let finishBatch!: (result: ProcessBulkJobBatchResult) => void;
    leases.claimNext.mockResolvedValueOnce(claimed);
    processing.processBatch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishBatch = resolve;
        }),
    );
    worker = new BulkJobWorkerService(leases, processing, config);

    const running = worker.run();
    await jest.advanceTimersByTimeAsync(0);
    worker.requestShutdown();
    finishBatch(processed(BulkJobStatus.running));
    await running;

    expect(processing.processBatch).toHaveBeenCalledTimes(1);
    expect(leases.renew).not.toHaveBeenCalled();
  });

  it('renews periodically while waiting for due items', async () => {
    let clockCalls = 0;
    jest.spyOn(performance, 'now').mockImplementation(() => {
      clockCalls += 1;
      return clockCalls < 3 ? 0 : 40_000;
    });
    leases.claimNext.mockResolvedValueOnce(claimed);
    processing.processBatch.mockResolvedValue({
      kind: 'no_due_pending_items',
    });
    leases.renew.mockImplementationOnce(async () => {
      worker.requestShutdown();
      return {
        kind: 'renewed',
        leaseExpiresAt: new Date(),
        heartbeatAt: new Date(),
      };
    });
    worker = new BulkJobWorkerService(leases, processing, {
      ...config,
      pollIntervalMs: 40_000,
    });

    const running = worker.run();
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(40_000);
    await running;

    expect(leases.renew).toHaveBeenCalledTimes(1);
    expect(processing.processBatch).toHaveBeenCalledTimes(1);
  });
});
