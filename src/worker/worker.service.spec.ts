import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import type { Logger } from '@nestjs/common';
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
      deferIfNoDueItems: jest.fn(),
      yieldAfterQuantum: jest.fn(),
      findJobsWithoutPendingItems: jest.fn(),
    } as unknown as jest.Mocked<BulkJobLeaseService>;
    processing = {
      processBatch: jest.fn(),
    } as unknown as jest.Mocked<BulkJobProcessingService>;
    leases.renew.mockResolvedValue({
      kind: 'renewed',
      leaseExpiresAt: new Date(),
      heartbeatAt: new Date(),
    });
    leases.findJobsWithoutPendingItems.mockResolvedValue([]);
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

  it('yields after the fixed batch quantum and returns to claim polling', async () => {
    leases.claimNext
      .mockResolvedValueOnce(claimed)
      .mockImplementationOnce(async () => {
        worker.requestShutdown();
        return { kind: 'empty' };
      });
    processing.processBatch.mockResolvedValue(processed(BulkJobStatus.running));
    leases.yieldAfterQuantum.mockResolvedValueOnce({ kind: 'yielded' });
    worker = new BulkJobWorkerService(leases, processing, config);

    await worker.run();

    expect(processing.processBatch).toHaveBeenCalledTimes(5);
    expect(leases.yieldAfterQuantum).toHaveBeenCalledWith(token);
    expect(leases.renew).toHaveBeenCalledTimes(4);
    expect(leases.claimNext).toHaveBeenCalledTimes(2);
  });

  it.each([{ kind: 'deferred' as const }, { kind: 'lease_lost' as const }])(
    'does not reuse the token when quantum yield returns $kind',
    async (result) => {
      leases.claimNext
        .mockResolvedValueOnce(claimed)
        .mockImplementationOnce(async () => {
          worker.requestShutdown();
          return { kind: 'empty' };
        });
      processing.processBatch.mockResolvedValue(
        processed(BulkJobStatus.running),
      );
      leases.yieldAfterQuantum.mockResolvedValueOnce(result);
      worker = new BulkJobWorkerService(leases, processing, config);

      await worker.run();

      expect(processing.processBatch).toHaveBeenCalledTimes(5);
      expect(leases.yieldAfterQuantum).toHaveBeenCalledTimes(1);
      expect(leases.renew).toHaveBeenCalledTimes(4);
    },
  );

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

  it('discards a deferred token and returns to claim polling', async () => {
    leases.claimNext
      .mockResolvedValueOnce(claimed)
      .mockImplementationOnce(async () => {
        worker.requestShutdown();
        return { kind: 'empty' };
      });
    processing.processBatch.mockResolvedValueOnce({
      kind: 'no_due_pending_items',
    });
    leases.deferIfNoDueItems.mockResolvedValueOnce({ kind: 'deferred' });
    worker = new BulkJobWorkerService(leases, processing, config);

    await worker.run();

    expect(leases.deferIfNoDueItems).toHaveBeenCalledWith(token);
    expect(leases.claimNext).toHaveBeenCalledTimes(2);
    expect(processing.processBatch).toHaveBeenCalledTimes(1);
    expect(leases.renew).not.toHaveBeenCalled();
  });

  it('waits after due items remain instead of immediately retrying batches', async () => {
    leases.claimNext.mockResolvedValueOnce(claimed);
    processing.processBatch
      .mockResolvedValueOnce({ kind: 'no_due_pending_items' })
      .mockImplementationOnce(async () => {
        worker.requestShutdown();
        return processed(BulkJobStatus.completed);
      });
    leases.deferIfNoDueItems.mockResolvedValueOnce({
      kind: 'due_items_remain',
    });
    worker = new BulkJobWorkerService(leases, processing, config);

    const running = worker.run();
    await jest.advanceTimersByTimeAsync(0);
    expect(processing.processBatch).toHaveBeenCalledTimes(1);
    expect(leases.renew).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(config.pollIntervalMs - 1);
    expect(processing.processBatch).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await running;

    expect(processing.processBatch).toHaveBeenCalledTimes(2);
    expect(leases.deferIfNoDueItems).toHaveBeenCalledTimes(1);
  });

  it.each(['lease_lost', 'no_pending_items'] as const)(
    'does not reuse the token when deferral returns %s',
    async (kind) => {
      leases.claimNext
        .mockResolvedValueOnce(claimed)
        .mockImplementationOnce(async () => {
          worker.requestShutdown();
          return { kind: 'empty' };
        });
      processing.processBatch.mockResolvedValueOnce({
        kind: 'no_due_pending_items',
      });
      leases.deferIfNoDueItems.mockResolvedValueOnce({ kind });
      worker = new BulkJobWorkerService(leases, processing, config);
      const warning = jest.spyOn(
        (worker as unknown as { logger: Logger }).logger,
        'warn',
      );

      await worker.run();

      expect(processing.processBatch).toHaveBeenCalledTimes(1);
      expect(leases.renew).not.toHaveBeenCalled();
      expect(leases.claimNext).toHaveBeenCalledTimes(2);
      if (kind === 'no_pending_items') {
        expect(warning).toHaveBeenCalledWith(
          expect.stringContaining('job_has_no_pending_items'),
        );
      }
    },
  );

  it('backs off and discards the token after an ambiguous deferral error', async () => {
    leases.claimNext
      .mockResolvedValueOnce(claimed)
      .mockImplementationOnce(async () => {
        worker.requestShutdown();
        return { kind: 'empty' };
      });
    processing.processBatch.mockResolvedValueOnce({
      kind: 'no_due_pending_items',
    });
    leases.deferIfNoDueItems.mockRejectedValueOnce(
      new Error('connection lost during commit'),
    );
    worker = new BulkJobWorkerService(leases, processing, config);

    const running = worker.run();
    await jest.advanceTimersByTimeAsync(0);
    expect(leases.claimNext).toHaveBeenCalledTimes(1);
    expect(processing.processBatch).toHaveBeenCalledTimes(1);
    expect(leases.renew).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(config.pollIntervalMs);
    await running;

    expect(leases.deferIfNoDueItems).toHaveBeenCalledTimes(1);
    expect(leases.claimNext).toHaveBeenCalledTimes(2);
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
    leases.deferIfNoDueItems.mockResolvedValue({ kind: 'due_items_remain' });
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

  it('throttles the read-only anomaly diagnostic to once per minute', async () => {
    jest.spyOn(performance, 'now').mockImplementation(() => jest.now());
    leases.claimNext
      .mockResolvedValueOnce({ kind: 'empty' })
      .mockImplementationOnce(async () => {
        worker.requestShutdown();
        return { kind: 'empty' };
      });
    leases.findJobsWithoutPendingItems.mockResolvedValueOnce([
      { id: token.jobId, status: BulkJobStatus.queued },
    ]);
    worker = new BulkJobWorkerService(leases, processing, {
      ...config,
      pollIntervalMs: 60_000,
    });
    const warning = jest.spyOn(
      (worker as unknown as { logger: Logger }).logger,
      'warn',
    );

    const running = worker.run();
    await jest.advanceTimersByTimeAsync(0);
    expect(leases.findJobsWithoutPendingItems).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(60_000);
    await running;
    expect(leases.findJobsWithoutPendingItems).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining(token.jobId));
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('"status":"queued"'),
    );
  });

  it('logs diagnostic query failures without stopping claim polling', async () => {
    leases.findJobsWithoutPendingItems.mockRejectedValueOnce(
      new Error('diagnostic database error'),
    );
    leases.claimNext.mockImplementationOnce(async () => {
      worker.requestShutdown();
      return { kind: 'empty' };
    });
    worker = new BulkJobWorkerService(leases, processing, config);
    const errorLog = jest.spyOn(
      (worker as unknown as { logger: Logger }).logger,
      'error',
    );

    await worker.run();

    expect(leases.claimNext).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining('job_anomaly_diagnostic_failed'),
    );
  });
});
