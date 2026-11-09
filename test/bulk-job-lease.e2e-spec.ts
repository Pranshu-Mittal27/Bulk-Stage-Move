import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { BulkJobLeaseService } from '../src/bulk-stage-moves/bulk-job-lease.service.js';
import { BulkJobProcessingService } from '../src/bulk-stage-moves/bulk-job-processing.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { Prisma } from '../src/generated/prisma/client.js';
import {
  BulkJobItemStatus,
  BulkJobStatus,
} from '../src/generated/prisma/enums.js';

describe('Bulk job lease service (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let leases: BulkJobLeaseService;
  let processing: BulkJobProcessingService;
  let workspaceId: string;
  let stageId: string;
  const additionalWorkspaceIds: string[] = [];

  async function createJob(
    jobWorkspaceId = workspaceId,
    jobStageId = stageId,
  ): Promise<{ id: string; itemId: bigint }> {
    const opportunity = await prisma.opportunity.create({
      data: {
        workspaceId: jobWorkspaceId,
        stageId: jobStageId,
        name: `Lease e2e ${randomUUID()}`,
        value: '1.0000',
      },
      select: { id: true, stageId: true, stageVersion: true },
    });
    const job = await prisma.bulkJob.create({
      data: {
        workspaceId: jobWorkspaceId,
        idempotencyKey: `lease-e2e-${randomUUID()}`,
        canonicalRequestHash: randomUUID(),
        normalizedRequest: { apiVersion: 1 },
        targetStageId: jobStageId,
        matchedCount: 1,
      },
      select: { id: true },
    });
    const item = await prisma.bulkJobItem.create({
      data: {
        workspaceId: jobWorkspaceId,
        jobId: job.id,
        opportunityId: opportunity.id,
        expectedStageId: opportunity.stageId,
        expectedStageVersion: opportunity.stageVersion,
      },
      select: { itemId: true },
    });
    return { id: job.id, itemId: item.itemId };
  }

  async function createJobInAnotherWorkspace(): Promise<{
    workspaceId: string;
    jobId: string;
  }> {
    const workspace = await prisma.workspace.create({
      data: { name: `Lease e2e ${randomUUID()}` },
    });
    additionalWorkspaceIds.push(workspace.id);
    const stage = await prisma.stage.create({
      data: {
        workspaceId: workspace.id,
        name: 'Lease fixture stage',
        position: 1,
      },
    });
    const job = await createJob(workspace.id, stage.id);
    return { workspaceId: workspace.id, jobId: job.id };
  }

  async function addPendingItem(jobId: string): Promise<bigint> {
    const opportunity = await prisma.opportunity.create({
      data: {
        workspaceId,
        stageId,
        name: `Lease e2e ${randomUUID()}`,
        value: '1.0000',
      },
      select: { id: true, stageId: true, stageVersion: true },
    });
    const item = await prisma.bulkJobItem.create({
      data: {
        workspaceId,
        jobId,
        opportunityId: opportunity.id,
        expectedStageId: opportunity.stageId,
        expectedStageVersion: opportunity.stageVersion,
      },
      select: { itemId: true },
    });
    return item.itemId;
  }

  async function setExpiredLease(
    jobId: string,
    owner: string,
    generation: number,
  ): Promise<void> {
    await prisma.$executeRaw`
      UPDATE "BulkJob"
      SET
        "status" = 'running'::"BulkJobStatus",
        "leaseOwner" = ${owner},
        "leaseExpiresAt" = clock_timestamp() - INTERVAL '1 second',
        "heartbeatAt" = clock_timestamp() - INTERVAL '2 seconds',
        "leaseGeneration" = ${generation},
        "startedAt" = clock_timestamp() - INTERVAL '3 seconds'
      WHERE "id" = ${jobId}::uuid
    `;
  }

  async function setValidLease(
    jobId: string,
    owner: string,
    generation: number,
  ): Promise<void> {
    await prisma.$executeRaw`
      UPDATE "BulkJob"
      SET
        "status" = 'running'::"BulkJobStatus",
        "leaseOwner" = ${owner},
        "leaseExpiresAt" = clock_timestamp() + INTERVAL '1 hour',
        "heartbeatAt" = clock_timestamp(),
        "leaseGeneration" = ${generation},
        "startedAt" = clock_timestamp()
      WHERE "id" = ${jobId}::uuid
    `;
  }

  async function setNullLease(
    jobId: string,
    owner: string,
    generation: number,
  ): Promise<void> {
    await prisma.$executeRaw`
      UPDATE "BulkJob"
      SET
        "status" = 'running'::"BulkJobStatus",
        "leaseOwner" = ${owner},
        "leaseExpiresAt" = NULL,
        "heartbeatAt" = clock_timestamp(),
        "leaseGeneration" = ${generation},
        "startedAt" = clock_timestamp()
      WHERE "id" = ${jobId}::uuid
    `;
  }

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();

    const workspace = await prisma.workspace.create({
      data: { name: `Lease e2e ${randomUUID()}` },
    });
    workspaceId = workspace.id;
    const stage = await prisma.stage.create({
      data: { workspaceId, name: 'Lease fixture stage', position: 1 },
    });
    stageId = stage.id;

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    leases = app.get(BulkJobLeaseService);
    processing = app.get(BulkJobProcessingService);
  });

  afterEach(async () => {
    await prisma.opportunityTransition.deleteMany({ where: { workspaceId } });
    await prisma.bulkJob.updateMany({
      where: { workspaceId },
      data: { cursorItemId: null },
    });
    await prisma.bulkJobItem.deleteMany({ where: { workspaceId } });
    await prisma.bulkJob.deleteMany({ where: { workspaceId } });
    await prisma.opportunity.deleteMany({ where: { workspaceId } });

    for (const additionalWorkspaceId of additionalWorkspaceIds) {
      await prisma.opportunityTransition.deleteMany({
        where: { workspaceId: additionalWorkspaceId },
      });
      await prisma.bulkJob.updateMany({
        where: { workspaceId: additionalWorkspaceId },
        data: { cursorItemId: null },
      });
      await prisma.bulkJobItem.deleteMany({
        where: { workspaceId: additionalWorkspaceId },
      });
      await prisma.bulkJob.deleteMany({
        where: { workspaceId: additionalWorkspaceId },
      });
      await prisma.opportunity.deleteMany({
        where: { workspaceId: additionalWorkspaceId },
      });
      await prisma.stage.deleteMany({
        where: { workspaceId: additionalWorkspaceId },
      });
      await prisma.workspace.delete({ where: { id: additionalWorkspaceId } });
    }
    additionalWorkspaceIds.length = 0;
  });

  afterAll(async () => {
    if (prisma && workspaceId) {
      await prisma.opportunityTransition.deleteMany({ where: { workspaceId } });
      await prisma.bulkJob.updateMany({
        where: { workspaceId },
        data: { cursorItemId: null },
      });
      await prisma.bulkJobItem.deleteMany({ where: { workspaceId } });
      await prisma.bulkJob.deleteMany({ where: { workspaceId } });
      await prisma.opportunity.deleteMany({ where: { workspaceId } });
      await prisma.stage.deleteMany({ where: { workspaceId } });
      await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    }
    await app?.close();
    await prisma?.$disconnect();
  });

  it('claims an eligible queued job and initializes its lease', async () => {
    const created = await createJob();
    const result = await leases.claimNext('worker-a');

    expect(result.kind).toBe('claimed');
    if (result.kind !== 'claimed') {
      throw new Error('Expected a claimed job.');
    }
    expect(result.job).toMatchObject({
      id: created.id,
      workspaceId,
      status: BulkJobStatus.running,
      leaseOwner: 'worker-a',
      leaseGeneration: 1,
    });
    expect(result.job.leaseExpiresAt).toBeInstanceOf(Date);
    expect(result.job.heartbeatAt).toBeInstanceOf(Date);
    expect(result.job.startedAt).toBeInstanceOf(Date);
    expect(result.job.leaseExpiresAt.getTime()).toBeGreaterThan(
      result.job.heartbeatAt.getTime(),
    );
    expect(result.token).toEqual({
      jobId: created.id,
      leaseOwner: 'worker-a',
      leaseGeneration: 1,
    });

    const persisted = await prisma.bulkJob.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(persisted.leaseOwner).toBe('worker-a');
    expect(persisted.leaseGeneration).toBe(1);
    expect(persisted.status).toBe(BulkJobStatus.running);
  });

  it('does not claim a queued job with only future item work', async () => {
    const created = await createJob();
    await prisma.$executeRaw`
      UPDATE "BulkJobItem"
      SET "nextAttemptAt" = clock_timestamp() + INTERVAL '1 hour'
      WHERE "jobId" = ${created.id}::uuid
    `;

    expect(await leases.claimNext('worker-a')).toEqual({ kind: 'empty' });
    const job = await prisma.bulkJob.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(job.status).toBe(BulkJobStatus.queued);
    expect(job.leaseOwner).toBeNull();
    expect(job.leaseGeneration).toBe(0);
  });

  it('uses item scheduling as authority and clears stale job scheduling hints on claims', async () => {
    const futureOnly = await createJob();
    await prisma.$executeRaw`
      UPDATE "BulkJob"
      SET "nextAttemptAt" = clock_timestamp() - INTERVAL '1 hour'
      WHERE "id" = ${futureOnly.id}::uuid
    `;
    await prisma.$executeRaw`
      UPDATE "BulkJobItem"
      SET "nextAttemptAt" = clock_timestamp() + INTERVAL '1 hour'
      WHERE "jobId" = ${futureOnly.id}::uuid
    `;

    expect(await leases.claimNext('worker-future')).toEqual({ kind: 'empty' });
    expect(
      (await prisma.bulkJob.findUniqueOrThrow({ where: { id: futureOnly.id } }))
        .status,
    ).toBe(BulkJobStatus.queued);

    const dueDespiteHint = await createJob();
    await prisma.$executeRaw`
      UPDATE "BulkJob"
      SET "nextAttemptAt" = clock_timestamp() + INTERVAL '1 hour'
      WHERE "id" = ${dueDespiteHint.id}::uuid
    `;

    const result = await leases.claimNext('worker-due');
    expect(result.kind).toBe('claimed');
    if (result.kind !== 'claimed') {
      throw new Error('Expected the due item to make its job claimable.');
    }
    expect(result.job.id).toBe(dueDespiteHint.id);
    expect(
      (
        await prisma.bulkJob.findUniqueOrThrow({
          where: { id: dueDespiteHint.id },
        })
      ).nextAttemptAt,
    ).toBeNull();
  });

  it('does not claim a job with no pending items', async () => {
    const created = await createJob();
    await prisma.bulkJobItem.deleteMany({ where: { jobId: created.id } });

    expect(await leases.claimNext('worker-empty-job')).toEqual({
      kind: 'empty',
    });
  });

  it('does not reclaim a running job with a valid lease', async () => {
    const created = await createJob();
    await setValidLease(created.id, 'worker-existing', 4);

    expect(await leases.claimNext('worker-new')).toEqual({ kind: 'empty' });
    const job = await prisma.bulkJob.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(job.leaseOwner).toBe('worker-existing');
    expect(job.leaseGeneration).toBe(4);
  });

  it('reclaims a running job with a NULL lease expiry', async () => {
    const created = await createJob();
    await setNullLease(created.id, 'worker-old', 6);

    const result = await leases.claimNext('worker-new');

    expect(result.kind).toBe('claimed');
    if (result.kind !== 'claimed') {
      throw new Error('Expected the NULL lease expiry job to be reclaimable.');
    }
    expect(result.job).toMatchObject({
      id: created.id,
      status: BulkJobStatus.running,
      leaseOwner: 'worker-new',
      leaseGeneration: 7,
    });
    expect(result.job.leaseExpiresAt).toBeInstanceOf(Date);
    expect(result.job.leaseExpiresAt.getTime()).toBeGreaterThan(Date.now());

    expect(
      await leases.renew({
        jobId: created.id,
        leaseOwner: 'worker-new',
        leaseGeneration: 7,
      }),
    ).not.toEqual({ kind: 'lease_lost' });
    expect(
      await leases.renew({
        jobId: created.id,
        leaseOwner: 'worker-old',
        leaseGeneration: 6,
      }),
    ).toEqual({ kind: 'lease_lost' });

    const persisted = await prisma.bulkJob.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(persisted.status).toBe(BulkJobStatus.running);
    expect(persisted.leaseOwner).toBe('worker-new');
    expect(persisted.leaseGeneration).toBe(7);
    expect(
      await prisma.bulkJobItem.findFirst({
        where: {
          jobId: created.id,
          status: BulkJobItemStatus.pending,
        },
      }),
    ).not.toBeNull();
  });

  it('reclaims an expired lease with a new fencing generation', async () => {
    const created = await createJob();
    await setExpiredLease(created.id, 'worker-old', 7);
    await prisma.$executeRaw`
      UPDATE "BulkJob"
      SET
        "retryCount" = 3,
        "nextAttemptAt" = clock_timestamp() + INTERVAL '1 hour',
        "cursorItemId" = ${created.itemId}
      WHERE "id" = ${created.id}::uuid
    `;
    const before = await prisma.bulkJob.findUniqueOrThrow({
      where: { id: created.id },
      select: { startedAt: true, lastProgressAt: true },
    });
    const result = await leases.claimNext('worker-new');

    expect(result.kind).toBe('claimed');
    if (result.kind !== 'claimed') {
      throw new Error('Expected the expired lease to be reclaimed.');
    }
    expect(result.job).toMatchObject({
      id: created.id,
      status: BulkJobStatus.running,
      leaseOwner: 'worker-new',
      leaseGeneration: 8,
    });
    expect(result.job.startedAt).toEqual(before.startedAt);
    expect(
      await leases.renew({
        jobId: created.id,
        leaseOwner: 'worker-old',
        leaseGeneration: 7,
      }),
    ).toEqual({ kind: 'lease_lost' });

    const persisted = await prisma.bulkJob.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(persisted.leaseOwner).toBe('worker-new');
    expect(persisted.leaseGeneration).toBe(8);
    expect(persisted.retryCount).toBe(3);
    expect(persisted.nextAttemptAt).toBeNull();
    expect(persisted.cursorItemId).toBe(created.itemId);
    expect(persisted.lastProgressAt).toEqual(before.lastProgressAt);
  });

  it('renews an unexpired lease with the current fencing token', async () => {
    const created = await createJob();
    const claim = await leases.claimNext('worker-current');
    expect(claim.kind).toBe('claimed');
    if (claim.kind !== 'claimed') {
      throw new Error('Expected a claimed job.');
    }

    await prisma.$executeRaw`
      UPDATE "BulkJob"
      SET
        "heartbeatAt" = clock_timestamp() - INTERVAL '2 seconds',
        "leaseExpiresAt" = clock_timestamp() + INTERVAL '1 second'
      WHERE "id" = ${created.id}::uuid
    `;
    const before = await prisma.bulkJob.findUniqueOrThrow({
      where: { id: created.id },
      select: { heartbeatAt: true, leaseExpiresAt: true },
    });

    const renewed = await leases.renew(claim.token);
    expect(renewed.kind).toBe('renewed');
    if (renewed.kind !== 'renewed') {
      throw new Error('Expected the current lease to renew.');
    }
    expect(renewed.heartbeatAt.getTime()).toBeGreaterThan(
      before.heartbeatAt!.getTime(),
    );
    expect(renewed.leaseExpiresAt.getTime()).toBeGreaterThan(
      before.leaseExpiresAt!.getTime(),
    );
    const persisted = await prisma.bulkJob.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(persisted.heartbeatAt).toEqual(renewed.heartbeatAt);
    expect(persisted.leaseExpiresAt).toEqual(renewed.leaseExpiresAt);
  });

  it('yields due work atomically and fences the old token before reclaim', async () => {
    const created = await createJob();
    const claim = await leases.claimNext('worker-yielding');
    expect(claim.kind).toBe('claimed');
    if (claim.kind !== 'claimed') {
      throw new Error('Expected the job to be claimed before yielding.');
    }

    expect(await leases.yieldAfterQuantum(claim.token)).toEqual({
      kind: 'yielded',
    });
    const yielded = await prisma.bulkJob.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(yielded).toMatchObject({
      status: BulkJobStatus.queued,
      leaseOwner: null,
      leaseExpiresAt: null,
      leaseGeneration: claim.token.leaseGeneration,
      processedCount: 0,
      movedCount: 0,
      nextAttemptAt: null,
    });
    expect(await processing.processBatch(claim.token)).toEqual({
      kind: 'lease_lost',
    });

    const reclaimed = await leases.claimNext('worker-reclaimed');
    expect(reclaimed.kind).toBe('claimed');
    if (reclaimed.kind !== 'claimed') {
      throw new Error('Expected the yielded job to be claimable again.');
    }
    expect(reclaimed.token).toEqual({
      jobId: created.id,
      leaseOwner: 'worker-reclaimed',
      leaseGeneration: claim.token.leaseGeneration + 1,
    });
    expect(await processing.processBatch(claim.token)).toEqual({
      kind: 'lease_lost',
    });
  });

  it('preserves future retry schedules when yielding has no due pending items', async () => {
    const created = await createJob();
    const secondItemId = await addPendingItem(created.id);
    await prisma.bulkJobItem.update({
      where: { itemId: created.itemId },
      data: { attemptCount: 1, lastErrorCode: 'transaction_conflict' },
    });
    await prisma.$executeRaw`
      UPDATE "BulkJobItem"
      SET "nextAttemptAt" = CASE
        WHEN "itemId" = ${created.itemId}
          THEN clock_timestamp() + INTERVAL '2 minutes'
        ELSE clock_timestamp() + INTERVAL '1 minute'
      END
      WHERE "jobId" = ${created.id}::uuid
    `;
    const itemsBefore = await prisma.bulkJobItem.findMany({
      where: { jobId: created.id },
      orderBy: { itemId: 'asc' },
      select: {
        itemId: true,
        nextAttemptAt: true,
        attemptCount: true,
        lastErrorCode: true,
      },
    });
    const earliest = itemsBefore[1]!.nextAttemptAt!;
    await setValidLease(created.id, 'worker-yield-deferrer', 9);

    expect(
      await leases.yieldAfterQuantum({
        jobId: created.id,
        leaseOwner: 'worker-yield-deferrer',
        leaseGeneration: 9,
      }),
    ).toEqual({ kind: 'deferred' });

    const job = await prisma.bulkJob.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(job).toMatchObject({
      status: BulkJobStatus.queued,
      leaseOwner: null,
      leaseExpiresAt: null,
      leaseGeneration: 9,
      nextAttemptAt: earliest,
      processedCount: 0,
    });
    const itemsAfter = await prisma.bulkJobItem.findMany({
      where: { jobId: created.id },
      orderBy: { itemId: 'asc' },
      select: {
        itemId: true,
        nextAttemptAt: true,
        attemptCount: true,
        lastErrorCode: true,
      },
    });
    expect(itemsAfter).toEqual(itemsBefore);
    expect(await leases.claimNext('worker-no-spin')).toEqual({ kind: 'empty' });
    expect(itemsAfter.map((item) => item.itemId)).toContain(secondItemId);
  });

  it('defers future-only pending items to the earliest schedule and preserves job/item metadata', async () => {
    const created = await createJob();
    const secondItemId = await addPendingItem(created.id);
    await prisma.bulkJobItem.update({
      where: { itemId: created.itemId },
      data: { attemptCount: 2, lastErrorCode: 'transient_error' },
    });
    await prisma.bulkJobItem.update({
      where: { itemId: secondItemId },
      data: { attemptCount: 1 },
    });
    await prisma.$executeRaw`
      UPDATE "BulkJobItem"
      SET "nextAttemptAt" = CASE
        WHEN "itemId" = ${created.itemId}
          THEN clock_timestamp() + INTERVAL '2 minutes'
        ELSE clock_timestamp() + INTERVAL '1 minute'
      END
      WHERE "jobId" = ${created.id}::uuid
    `;
    const scheduledItems = await prisma.bulkJobItem.findMany({
      where: { jobId: created.id },
      orderBy: { itemId: 'asc' },
      select: { itemId: true, nextAttemptAt: true },
    });
    const later = scheduledItems[0]!.nextAttemptAt!;
    const earliest = scheduledItems[1]!.nextAttemptAt!;
    await setValidLease(created.id, 'worker-deferrer', 9);
    const heartbeatAt = new Date(Date.now() - 10_000);
    const lastProgressAt = new Date(Date.now() - 20_000);
    await prisma.bulkJob.update({
      where: { id: created.id },
      data: {
        retryCount: 4,
        cursorItemId: created.itemId,
        heartbeatAt,
        lastProgressAt,
      },
    });

    const result = await leases.deferIfNoDueItems({
      jobId: created.id,
      leaseOwner: 'worker-deferrer',
      leaseGeneration: 9,
    });
    expect(result).toEqual({ kind: 'deferred' });

    const job = await prisma.bulkJob.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(job.status).toBe(BulkJobStatus.queued);
    expect(job.nextAttemptAt).toEqual(earliest);
    expect(job.leaseOwner).toBeNull();
    expect(job.leaseExpiresAt).toBeNull();
    expect(job.leaseGeneration).toBe(9);
    expect(job.heartbeatAt).toEqual(heartbeatAt);
    expect(job.lastProgressAt).toEqual(lastProgressAt);
    expect(job.retryCount).toBe(4);
    expect(job.cursorItemId).toBe(created.itemId);

    const items = await prisma.bulkJobItem.findMany({
      where: { jobId: created.id },
      orderBy: { itemId: 'asc' },
    });
    expect(items).toHaveLength(2);
    expect(items.map(({ status }) => status)).toEqual(['pending', 'pending']);
    expect(items[0]).toMatchObject({
      attemptCount: 2,
      nextAttemptAt: later,
      lastErrorCode: 'transient_error',
    });
    expect(items[1]).toMatchObject({
      attemptCount: 1,
      nextAttemptAt: earliest,
    });
  });

  it('rolls back the deferral update when its transaction fails before commit', async () => {
    const created = await createJob();
    await prisma.$executeRaw`
      UPDATE "BulkJobItem"
      SET "nextAttemptAt" = clock_timestamp() + INTERVAL '1 hour'
      WHERE "jobId" = ${created.id}::uuid
    `;
    await setValidLease(created.id, 'worker-rollback', 10);
    const underlyingPrisma = prisma;
    const rollbackPrisma = {
      $transaction: (
        callback: (transaction: Prisma.TransactionClient) => Promise<unknown>,
      ) =>
        underlyingPrisma.$transaction(async (transaction) => {
          let queryCount = 0;
          const queryRaw = transaction.$queryRaw.bind(transaction);
          const transactionWithFailure = new Proxy(transaction, {
            get(target, property) {
              if (property === '$queryRaw') {
                return async <T>(
                  query: TemplateStringsArray | Prisma.Sql,
                  ...values: unknown[]
                ): Promise<T> => {
                  const rows = await queryRaw<T>(query, ...values);
                  queryCount += 1;
                  if (queryCount === 4) {
                    throw new Error(
                      'injected failure before transaction commit',
                    );
                  }
                  return rows;
                };
              }
              const value = Reflect.get(target, property, target) as unknown;
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
          return callback(transactionWithFailure);
        }),
    };
    const rollbackLeases = new BulkJobLeaseService(
      rollbackPrisma as unknown as PrismaService,
    );

    await expect(
      rollbackLeases.deferIfNoDueItems({
        jobId: created.id,
        leaseOwner: 'worker-rollback',
        leaseGeneration: 10,
      }),
    ).rejects.toThrow('injected failure before transaction commit');

    const job = await prisma.bulkJob.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(job.status).toBe(BulkJobStatus.running);
    expect(job.leaseOwner).toBe('worker-rollback');
    expect(job.leaseGeneration).toBe(10);
    expect(job.leaseExpiresAt).not.toBeNull();
    expect(job.nextAttemptAt).toBeNull();
  });

  it('does not defer when a pending item is due or has no schedule', async () => {
    const created = await createJob();
    await setValidLease(created.id, 'worker-due', 4);
    const token = {
      jobId: created.id,
      leaseOwner: 'worker-due',
      leaseGeneration: 4,
    };

    expect(await leases.deferIfNoDueItems(token)).toEqual({
      kind: 'due_items_remain',
    });
    await prisma.$executeRaw`
        UPDATE "BulkJobItem"
        SET "nextAttemptAt" = clock_timestamp() - INTERVAL '1 second'
        WHERE "jobId" = ${created.id}::uuid
      `;
    expect(await leases.deferIfNoDueItems(token)).toEqual({
      kind: 'due_items_remain',
    });
    expect(
      (await prisma.bulkJob.findUniqueOrThrow({ where: { id: created.id } }))
        .status,
    ).toBe(BulkJobStatus.running);
  });

  it('fences stale, mismatched, and expired tokens from deferring', async () => {
    const created = await createJob();
    await prisma.$executeRaw`
        UPDATE "BulkJobItem"
        SET "nextAttemptAt" = clock_timestamp() + INTERVAL '1 hour'
        WHERE "jobId" = ${created.id}::uuid
      `;
    await setValidLease(created.id, 'worker-current', 5);

    expect(
      await leases.deferIfNoDueItems({
        jobId: created.id,
        leaseOwner: 'worker-stale',
        leaseGeneration: 4,
      }),
    ).toEqual({ kind: 'lease_lost' });
    expect(
      await leases.deferIfNoDueItems({
        jobId: created.id,
        leaseOwner: 'worker-current',
        leaseGeneration: 4,
      }),
    ).toEqual({ kind: 'lease_lost' });

    await prisma.$executeRaw`
        UPDATE "BulkJob"
        SET "leaseExpiresAt" = clock_timestamp() - INTERVAL '1 second'
        WHERE "id" = ${created.id}::uuid
      `;
    expect(
      await leases.deferIfNoDueItems({
        jobId: created.id,
        leaseOwner: 'worker-current',
        leaseGeneration: 5,
      }),
    ).toEqual({ kind: 'lease_lost' });
    const job = await prisma.bulkJob.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(job.status).toBe(BulkJobStatus.running);
    expect(job.leaseOwner).toBe('worker-current');
    expect(job.leaseGeneration).toBe(5);
  });

  it('reports zero-pending running jobs without completing or requeueing them', async () => {
    const created = await createJob();
    await prisma.bulkJobItem.deleteMany({ where: { jobId: created.id } });
    expect(await leases.findJobsWithoutPendingItems()).toContainEqual({
      id: created.id,
      status: BulkJobStatus.queued,
    });
    await setValidLease(created.id, 'worker-anomaly', 6);

    expect(
      await leases.deferIfNoDueItems({
        jobId: created.id,
        leaseOwner: 'worker-anomaly',
        leaseGeneration: 6,
      }),
    ).toEqual({ kind: 'no_pending_items' });
    expect(await leases.findJobsWithoutPendingItems()).toContainEqual({
      id: created.id,
      status: BulkJobStatus.running,
    });
    const job = await prisma.bulkJob.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(job.status).toBe(BulkJobStatus.running);
    expect(job.leaseOwner).toBe('worker-anomaly');
  });

  it('rejects invalid, expired, missing, and terminal heartbeat tokens without mutation', async () => {
    const active = await createJob();
    await setValidLease(active.id, 'worker-owner', 5);
    const activeBefore = await prisma.bulkJob.findUniqueOrThrow({
      where: { id: active.id },
      select: {
        status: true,
        leaseOwner: true,
        leaseGeneration: true,
        leaseExpiresAt: true,
        heartbeatAt: true,
      },
    });

    expect(
      await leases.renew({
        jobId: active.id,
        leaseOwner: 'wrong-owner',
        leaseGeneration: 5,
      }),
    ).toEqual({ kind: 'lease_lost' });
    expect(
      await leases.renew({
        jobId: active.id,
        leaseOwner: 'worker-owner',
        leaseGeneration: 4,
      }),
    ).toEqual({ kind: 'lease_lost' });
    expect(
      await prisma.bulkJob.findUniqueOrThrow({
        where: { id: active.id },
        select: {
          status: true,
          leaseOwner: true,
          leaseGeneration: true,
          leaseExpiresAt: true,
          heartbeatAt: true,
        },
      }),
    ).toEqual(activeBefore);

    await prisma.$executeRaw`
      UPDATE "BulkJob"
      SET "leaseExpiresAt" = clock_timestamp() - INTERVAL '1 second'
      WHERE "id" = ${active.id}::uuid
    `;
    const expiredBefore = await prisma.bulkJob.findUniqueOrThrow({
      where: { id: active.id },
      select: { leaseExpiresAt: true, heartbeatAt: true },
    });
    expect(
      await leases.renew({
        jobId: active.id,
        leaseOwner: 'worker-owner',
        leaseGeneration: 5,
      }),
    ).toEqual({ kind: 'lease_lost' });
    expect(
      await prisma.bulkJob.findUniqueOrThrow({
        where: { id: active.id },
        select: { leaseExpiresAt: true, heartbeatAt: true },
      }),
    ).toEqual(expiredBefore);

    expect(
      await leases.renew({
        jobId: randomUUID(),
        leaseOwner: 'worker-owner',
        leaseGeneration: 1,
      }),
    ).toEqual({ kind: 'lease_lost' });

    const terminal = await createJob();
    await setValidLease(terminal.id, 'worker-terminal', 2);
    await prisma.bulkJob.update({
      where: { id: terminal.id },
      data: { status: BulkJobStatus.failed },
    });
    const terminalBefore = await prisma.bulkJob.findUniqueOrThrow({
      where: { id: terminal.id },
      select: {
        status: true,
        leaseOwner: true,
        leaseGeneration: true,
        leaseExpiresAt: true,
        heartbeatAt: true,
      },
    });
    expect(
      await leases.renew({
        jobId: terminal.id,
        leaseOwner: 'worker-terminal',
        leaseGeneration: 2,
      }),
    ).toEqual({ kind: 'lease_lost' });
    expect(
      await prisma.bulkJob.findUniqueOrThrow({
        where: { id: terminal.id },
        select: {
          status: true,
          leaseOwner: true,
          leaseGeneration: true,
          leaseExpiresAt: true,
          heartbeatAt: true,
        },
      }),
    ).toEqual(terminalBefore);
  });

  it('allows only one concurrent claimant to own an eligible job', async () => {
    const created = await createJob();
    const results = await Promise.all([
      leases.claimNext('worker-one'),
      leases.claimNext('worker-two'),
    ]);

    const claims = results.filter((result) => result.kind === 'claimed');
    const empty = results.filter((result) => result.kind === 'empty');
    expect(claims).toHaveLength(1);
    expect(empty).toHaveLength(1);

    const claim = claims[0]!;
    if (claim.kind !== 'claimed') {
      throw new Error('Expected one claimant.');
    }
    expect(claim.job.id).toBe(created.id);
    const persisted = await prisma.bulkJob.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(persisted.leaseOwner).toBe(claim.token.leaseOwner);
    expect(persisted.leaseGeneration).toBe(claim.token.leaseGeneration);
    expect(persisted.leaseGeneration).toBe(1);
  });

  it('allows only one concurrent claimant to claim jobs in a workspace', async () => {
    const first = await createJob();
    const second = await createJob();

    const results = await Promise.all([
      leases.claimNext('worker-one'),
      leases.claimNext('worker-two'),
    ]);

    const claims = results.filter((result) => result.kind === 'claimed');
    const empty = results.filter((result) => result.kind === 'empty');
    expect(claims).toHaveLength(1);
    expect(empty).toHaveLength(1);
    if (claims[0]?.kind !== 'claimed') {
      throw new Error('Expected exactly one job to be claimed.');
    }
    expect([first.id, second.id]).toContain(claims[0].job.id);

    const jobs = await prisma.bulkJob.findMany({
      where: { id: { in: [first.id, second.id] } },
      orderBy: { id: 'asc' },
    });
    expect(
      jobs.filter((job) => job.status === BulkJobStatus.running),
    ).toHaveLength(1);
    expect(
      jobs.filter((job) => job.status === BulkJobStatus.queued),
    ).toHaveLength(1);
  });

  it('claims a job in another workspace while the first workspace is active', async () => {
    const firstWorkspaceJob = await createJob();
    const otherWorkspace = await createJobInAnotherWorkspace();

    const firstClaim = await leases.claimNext('worker-workspace-one');
    expect(firstClaim.kind).toBe('claimed');
    if (firstClaim.kind !== 'claimed') {
      throw new Error('Expected the first workspace job to be claimed.');
    }
    expect(firstClaim.job.id).toBe(firstWorkspaceJob.id);

    const otherWorkspaceClaim = await leases.claimNext('worker-workspace-two');
    expect(otherWorkspaceClaim.kind).toBe('claimed');
    if (otherWorkspaceClaim.kind !== 'claimed') {
      throw new Error('Expected the other workspace job to be claimable.');
    }
    expect(otherWorkspaceClaim.job.id).toBe(otherWorkspace.jobId);
    expect(otherWorkspaceClaim.job.workspaceId).toBe(
      otherWorkspace.workspaceId,
    );
  });

  it('does not bypass an expired running job locked by an in-flight batch', async () => {
    const expired = await createJob();
    await setExpiredLease(expired.id, 'worker-expired', 7);
    const queued = await createJob();
    const queuedJob = await prisma.bulkJob.findUniqueOrThrow({
      where: { id: queued.id },
      select: { createdAt: true },
    });
    await prisma.bulkJob.update({
      where: { id: expired.id },
      data: {
        lastProgressAt: new Date(queuedJob.createdAt.getTime() - 1_000),
      },
    });

    let releaseOtherWorkspaceLocks!: () => void;
    let signalOtherWorkspaceLocksAcquired!: () => void;
    let signalOtherWorkspaceLocksFailed!: (error: unknown) => void;
    const otherWorkspaceLocksReleased = new Promise<void>((resolve) => {
      releaseOtherWorkspaceLocks = resolve;
    });
    const otherWorkspaceLocksAcquired = new Promise<void>((resolve, reject) => {
      signalOtherWorkspaceLocksAcquired = resolve;
      signalOtherWorkspaceLocksFailed = reject;
    });
    const holdingOtherWorkspaceLocks = prisma
      .$transaction(async (transaction) => {
        await transaction.$queryRaw`
          SELECT "id"
          FROM "Workspace"
          WHERE "id" <> ${workspaceId}::uuid
          FOR NO KEY UPDATE
        `;
        signalOtherWorkspaceLocksAcquired();
        await otherWorkspaceLocksReleased;
      })
      .catch((error: unknown) => {
        signalOtherWorkspaceLocksFailed(error);
        throw error;
      });

    let releaseExpiredJobLock!: () => void;
    let signalExpiredJobLockAcquired!: () => void;
    let signalExpiredJobLockFailed!: (error: unknown) => void;
    const expiredJobLockReleased = new Promise<void>((resolve) => {
      releaseExpiredJobLock = resolve;
    });
    const expiredJobLockAcquired = new Promise<void>((resolve, reject) => {
      signalExpiredJobLockAcquired = resolve;
      signalExpiredJobLockFailed = reject;
    });
    let holdingExpiredJobLock: Promise<void> | undefined;
    let expiredJobLockSettled = false;
    let primaryError: unknown;
    let hasPrimaryError = false;
    const cleanupErrors: unknown[] = [];

    try {
      await otherWorkspaceLocksAcquired;
      holdingExpiredJobLock = prisma
        .$transaction(async (transaction) => {
          await transaction.$queryRaw`
            SELECT "id"
            FROM "BulkJob"
            WHERE "id" = ${expired.id}::uuid
            FOR UPDATE
          `;
          signalExpiredJobLockAcquired();
          await expiredJobLockReleased;
        })
        .catch((error: unknown) => {
          signalExpiredJobLockFailed(error);
          throw error;
        });
      try {
        await expiredJobLockAcquired;
        expect(await leases.claimNext('worker-contender')).toEqual({
          kind: 'empty',
        });
        expect(
          await prisma.bulkJob.findUniqueOrThrow({ where: { id: queued.id } }),
        ).toMatchObject({
          status: BulkJobStatus.queued,
          leaseOwner: null,
          leaseGeneration: 0,
        });
      } finally {
        releaseExpiredJobLock();
        if (holdingExpiredJobLock) {
          const [holderResult] = await Promise.allSettled([
            holdingExpiredJobLock,
          ]);
          expiredJobLockSettled = true;
          if (holderResult.status === 'rejected') {
            cleanupErrors.push(holderResult.reason);
          }
        }
      }

      if (cleanupErrors.length === 0) {
        const reclaimed = await leases.claimNext('worker-reclaimer');
        expect(reclaimed.kind).toBe('claimed');
        if (reclaimed.kind !== 'claimed') {
          throw new Error('Expected the expired job to be reclaimed.');
        }
        expect(reclaimed.job).toMatchObject({
          id: expired.id,
          status: BulkJobStatus.running,
          leaseOwner: 'worker-reclaimer',
          leaseGeneration: 8,
        });
      }
    } catch (error) {
      primaryError = error;
      hasPrimaryError = true;
    } finally {
      releaseExpiredJobLock();
      releaseOtherWorkspaceLocks();
      const holderResults = await Promise.allSettled([
        holdingOtherWorkspaceLocks,
        ...(holdingExpiredJobLock && !expiredJobLockSettled
          ? [holdingExpiredJobLock]
          : []),
      ]);
      for (const result of holderResults) {
        if (result.status === 'rejected') {
          cleanupErrors.push(result.reason);
        }
      }
    }

    const distinctCleanupErrors = cleanupErrors.filter(
      (error) => error !== primaryError,
    );
    if (hasPrimaryError && distinctCleanupErrors.length > 0) {
      throw new AggregateError(
        [primaryError, ...distinctCleanupErrors],
        'The test failed and transaction cleanup also failed.',
      );
    }
    if (hasPrimaryError) {
      throw primaryError;
    }
    if (distinctCleanupErrors.length > 0) {
      throw new AggregateError(
        distinctCleanupErrors,
        'Transaction cleanup failed.',
      );
    }
  });

  it('skips a locked eligible job and claims another eligible job', async () => {
    const locked = await createJob();
    const available = await createJob();
    let releaseLock!: () => void;
    let markLocked!: () => void;
    const lockReleased = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const lockAcquired = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    const holdingTransaction = prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`
        SELECT "id"
        FROM "BulkJob"
        WHERE "id" = ${locked.id}::uuid
        FOR UPDATE
      `;
      markLocked();
      await lockReleased;
    });

    await lockAcquired;
    let result:
      Awaited<ReturnType<BulkJobLeaseService['claimNext']>> | undefined;
    try {
      result = await leases.claimNext('worker-skip-locked');
    } finally {
      releaseLock();
      await holdingTransaction;
    }

    expect(result?.kind).toBe('claimed');
    if (!result || result.kind !== 'claimed') {
      throw new Error('Expected the unlocked eligible job to be claimed.');
    }
    expect(result.job.id).toBe(available.id);
  });

  it('returns an explicit empty result when no work is eligible', async () => {
    expect(await leases.claimNext('worker-idle')).toEqual({ kind: 'empty' });
  });

  it('requires an explicit non-empty worker identity', async () => {
    await expect(leases.claimNext('')).rejects.toThrow('Worker ID');
    await expect(leases.claimNext('   ')).rejects.toThrow('Worker ID');
  });
});
