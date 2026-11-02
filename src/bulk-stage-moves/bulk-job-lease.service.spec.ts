import { jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service.js';
import {
  BulkJobLeaseService,
  parseLeaseDurationMs,
  type BulkJobLeaseToken,
} from './bulk-job-lease.service.js';

describe('parseLeaseDurationMs', () => {
  it('uses the bounded development default when unset', () => {
    expect(parseLeaseDurationMs(undefined)).toBe(30_000);
  });

  it.each([
    ['1000', 1_000],
    ['300000', 300_000],
  ])('accepts a supported duration of %s milliseconds', (value, expected) => {
    expect(parseLeaseDurationMs(value)).toBe(expected);
  });

  it.each(['', ' 30000', '30000 ', '1.5', '999', '300001', 'Infinity'])(
    'rejects invalid lease duration %s',
    (value) => {
      expect(() => parseLeaseDurationMs(value)).toThrow(
        'BULK_JOB_LEASE_DURATION_MS',
      );
    },
  );
});

describe('BulkJobLeaseService', () => {
  const token: BulkJobLeaseToken = {
    jobId: randomUUID(),
    leaseOwner: 'worker-test',
    leaseGeneration: 3,
  };

  function createService() {
    const transaction = {
      $queryRaw: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
    };
    const prisma = {
      $queryRaw: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
      $transaction: jest.fn(
        async (
          callback: (tx: typeof transaction) => Promise<unknown>,
        ): Promise<unknown> => callback(transaction),
      ),
    };
    const service = new BulkJobLeaseService(prisma as unknown as PrismaService);
    return { service, prisma, transaction };
  }

  function validLeaseResponses(transaction: {
    $queryRaw: jest.Mock<(...args: unknown[]) => Promise<unknown>>;
  }): void {
    transaction.$queryRaw
      .mockResolvedValueOnce([
        {
          status: 'running',
          leaseOwner: token.leaseOwner,
          leaseGeneration: token.leaseGeneration,
        },
      ])
      .mockResolvedValueOnce([{ valid: true }]);
  }

  it('defers future-only pending items with the database-selected earliest time', async () => {
    const { service, transaction } = createService();
    const earliestPendingAt = new Date(Date.now() + 60_000);
    validLeaseResponses(transaction);
    transaction.$queryRaw
      .mockResolvedValueOnce([
        {
          pendingCount: 2,
          dueCount: 0,
          earliestPendingAt,
        },
      ])
      .mockResolvedValueOnce([{ id: token.jobId }]);

    await expect(service.deferIfNoDueItems(token)).resolves.toEqual({
      kind: 'deferred',
    });
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(4);
  });

  it('does not defer when due pending items remain', async () => {
    const { service, transaction } = createService();
    validLeaseResponses(transaction);
    transaction.$queryRaw.mockResolvedValueOnce([
      { pendingCount: 2, dueCount: 1, earliestPendingAt: null },
    ]);

    await expect(service.deferIfNoDueItems(token)).resolves.toEqual({
      kind: 'due_items_remain',
    });
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(3);
  });

  it('reports jobs with no pending items without changing their state', async () => {
    const { service, transaction } = createService();
    validLeaseResponses(transaction);
    transaction.$queryRaw.mockResolvedValueOnce([
      { pendingCount: 0, dueCount: 0, earliestPendingAt: null },
    ]);

    await expect(service.deferIfNoDueItems(token)).resolves.toEqual({
      kind: 'no_pending_items',
    });
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(3);
  });

  it.each([
    { description: 'the job is missing', job: null },
    {
      description: 'the job is not running',
      job: {
        status: 'queued',
        leaseOwner: token.leaseOwner,
        leaseGeneration: 3,
      },
    },
    {
      description: 'the owner does not match',
      job: {
        status: 'running',
        leaseOwner: 'other-worker',
        leaseGeneration: 3,
      },
    },
    {
      description: 'the generation does not match',
      job: {
        status: 'running',
        leaseOwner: token.leaseOwner,
        leaseGeneration: 2,
      },
    },
  ])('returns lease_lost when $description', async ({ job }) => {
    const { service, transaction } = createService();
    transaction.$queryRaw.mockResolvedValueOnce(job === null ? [] : [job]);

    await expect(service.deferIfNoDueItems(token)).resolves.toEqual({
      kind: 'lease_lost',
    });
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('returns lease_lost when the matching lease has expired', async () => {
    const { service, transaction } = createService();
    transaction.$queryRaw
      .mockResolvedValueOnce([
        {
          status: 'running',
          leaseOwner: token.leaseOwner,
          leaseGeneration: token.leaseGeneration,
        },
      ])
      .mockResolvedValueOnce([{ valid: false }]);

    await expect(service.deferIfNoDueItems(token)).resolves.toEqual({
      kind: 'lease_lost',
    });
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('returns lease_lost when the fenced final update affects no job', async () => {
    const { service, transaction } = createService();
    validLeaseResponses(transaction);
    transaction.$queryRaw
      .mockResolvedValueOnce([
        {
          pendingCount: 1,
          dueCount: 0,
          earliestPendingAt: new Date(Date.now() + 60_000),
        },
      ])
      .mockResolvedValueOnce([]);

    await expect(service.deferIfNoDueItems(token)).resolves.toEqual({
      kind: 'lease_lost',
    });
  });

  it('requeues due pending work and releases only the matching lease', async () => {
    const { service, transaction } = createService();
    validLeaseResponses(transaction);
    transaction.$queryRaw
      .mockResolvedValueOnce([
        { pendingCount: 2, dueCount: 1, earliestPendingAt: null },
      ])
      .mockResolvedValueOnce([{ id: token.jobId }]);

    await expect(service.yieldAfterQuantum(token)).resolves.toEqual({
      kind: 'yielded',
    });
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(4);
  });

  it('defers future-only pending work to its earliest item schedule', async () => {
    const { service, transaction } = createService();
    const earliestPendingAt = new Date(Date.now() + 60_000);
    validLeaseResponses(transaction);
    transaction.$queryRaw
      .mockResolvedValueOnce([
        { pendingCount: 2, dueCount: 0, earliestPendingAt },
      ])
      .mockResolvedValueOnce([{ id: token.jobId }]);

    await expect(service.yieldAfterQuantum(token)).resolves.toEqual({
      kind: 'deferred',
    });
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(4);
  });

  it('does not release a lease with no pending items', async () => {
    const { service, transaction } = createService();
    validLeaseResponses(transaction);
    transaction.$queryRaw.mockResolvedValueOnce([
      { pendingCount: 0, dueCount: 0, earliestPendingAt: null },
    ]);

    await expect(service.yieldAfterQuantum(token)).resolves.toEqual({
      kind: 'no_pending_items',
    });
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(3);
  });

  it('does not yield with a stale lease token', async () => {
    const { service, transaction } = createService();
    transaction.$queryRaw.mockResolvedValueOnce([
      {
        status: 'running',
        leaseOwner: token.leaseOwner,
        leaseGeneration: token.leaseGeneration + 1,
      },
    ]);

    await expect(service.yieldAfterQuantum(token)).resolves.toEqual({
      kind: 'lease_lost',
    });
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('propagates a failure during the final update', async () => {
    const { service, transaction } = createService();
    validLeaseResponses(transaction);
    transaction.$queryRaw
      .mockResolvedValueOnce([
        {
          pendingCount: 1,
          dueCount: 0,
          earliestPendingAt: new Date(Date.now() + 60_000),
        },
      ])
      .mockRejectedValueOnce(new Error('database constraint failure'));

    await expect(service.deferIfNoDueItems(token)).rejects.toThrow(
      'database constraint failure',
    );
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(4);
  });

  it('propagates an error reported after the transaction callback returns', async () => {
    const { service, prisma, transaction } = createService();
    const commitError = new Error('connection lost during commit response');
    validLeaseResponses(transaction);
    transaction.$queryRaw
      .mockResolvedValueOnce([
        {
          pendingCount: 1,
          dueCount: 0,
          earliestPendingAt: new Date(Date.now() + 60_000),
        },
      ])
      .mockResolvedValueOnce([{ id: token.jobId }]);
    prisma.$transaction.mockImplementationOnce(async (callback) => {
      await callback(transaction);
      throw commitError;
    });

    await expect(service.deferIfNoDueItems(token)).rejects.toBe(commitError);
  });

  it('rejects malformed fencing tokens before opening a transaction', async () => {
    const { service, prisma } = createService();

    await expect(
      service.deferIfNoDueItems({
        ...token,
        leaseGeneration: 0,
      }),
    ).rejects.toThrow('generation');
    await expect(
      service.deferIfNoDueItems({
        ...token,
        jobId: 'not-a-uuid',
      }),
    ).rejects.toThrow('UUID');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('runs the zero-pending diagnostic as a read-only query', async () => {
    const { service, prisma } = createService();
    prisma.$queryRaw.mockResolvedValueOnce([
      { id: token.jobId, status: 'queued' },
    ]);

    await expect(service.findJobsWithoutPendingItems()).resolves.toEqual([
      { id: token.jobId, status: 'queued' },
    ]);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });
});
