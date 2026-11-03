import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApplication } from '../src/common/configure-application.js';
import { BulkJobLeaseService } from '../src/bulk-stage-moves/bulk-job-lease.service.js';
import {
  BulkJobProcessingService,
  RetryableBulkJobProcessingError,
  type RetryMetadataStatus,
} from '../src/bulk-stage-moves/bulk-job-processing.service.js';
import { BulkJobWorkerService } from '../src/worker/worker.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  BulkJobItemStatus,
  BulkJobStatus,
  TransitionSource,
} from '../src/generated/prisma/enums.js';

interface ItemFixture {
  opportunityStageId?: string;
  opportunityStageVersion?: number;
  expectedStageId?: string;
  expectedStageVersion?: number;
  scheduledForFuture?: boolean;
}

interface ProcessingFixture {
  jobId: string;
  token: { jobId: string; leaseOwner: string; leaseGeneration: number };
  opportunityIds: string[];
  itemIds: bigint[];
}

class TestMetadataFailureProcessingService extends BulkJobProcessingService {
  constructor(
    prisma: PrismaService,
    private readonly beforeMetadataFailure: () => Promise<void>,
  ) {
    super(prisma);
  }

  protected override async recordRetryableAttempt(): Promise<RetryMetadataStatus> {
    await this.beforeMetadataFailure();
    throw new Error('simulated retry metadata write failure');
  }
}

describe('Bulk job batch processing (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let leases: BulkJobLeaseService;
  let processing: BulkJobProcessingService;
  let workspaceId: string;
  let sourceStageId: string;
  let targetStageId: string;
  let otherStageId: string;
  let previousBatchSize: string | undefined;

  async function createOpportunity(stageId = sourceStageId): Promise<string> {
    const opportunity = await prisma.opportunity.create({
      data: {
        workspaceId,
        stageId,
        name: `Processing e2e ${randomUUID()}`,
        value: '10.0000',
      },
      select: { id: true },
    });
    return opportunity.id;
  }

  async function createFixture(
    itemSpecs: ItemFixture[],
    options: { insertGap?: boolean } = {},
  ): Promise<ProcessingFixture> {
    const job = await prisma.bulkJob.create({
      data: {
        workspaceId,
        idempotencyKey: `processing-e2e-${randomUUID()}`,
        canonicalRequestHash: randomUUID(),
        normalizedRequest: { apiVersion: 1 },
        targetStageId,
        status: BulkJobStatus.running,
        matchedCount: itemSpecs.length,
        leaseOwner: 'processing-worker',
        leaseGeneration: 3,
        heartbeatAt: new Date(),
        startedAt: new Date(),
      },
      select: { id: true },
    });
    await prisma.$executeRaw`
      UPDATE "BulkJob"
      SET "leaseExpiresAt" = clock_timestamp() + INTERVAL '1 hour'
      WHERE "id" = ${job.id}::uuid
    `;
    const opportunityIds: string[] = [];
    const itemIds: bigint[] = [];

    for (const [index, spec] of itemSpecs.entries()) {
      if (options.insertGap && index === 1) {
        const gapJob = await prisma.bulkJob.create({
          data: {
            workspaceId,
            idempotencyKey: `processing-gap-${randomUUID()}`,
            canonicalRequestHash: randomUUID(),
            normalizedRequest: { apiVersion: 1 },
            targetStageId,
            matchedCount: 1,
          },
          select: { id: true },
        });
        const gapOpportunityId = await createOpportunity();
        await prisma.bulkJobItem.create({
          data: {
            workspaceId,
            jobId: gapJob.id,
            opportunityId: gapOpportunityId,
            expectedStageId: sourceStageId,
            expectedStageVersion: 1,
          },
        });
      }

      const opportunityId = await createOpportunity(
        spec.opportunityStageId ?? sourceStageId,
      );
      opportunityIds.push(opportunityId);
      const item = await prisma.bulkJobItem.create({
        data: {
          workspaceId,
          jobId: job.id,
          opportunityId,
          expectedStageId: spec.expectedStageId ?? sourceStageId,
          expectedStageVersion: spec.expectedStageVersion ?? 1,
          nextAttemptAt: null,
        },
        select: { itemId: true },
      });
      itemIds.push(item.itemId);
      if (spec.scheduledForFuture) {
        await prisma.$executeRaw`
          UPDATE "BulkJobItem"
          SET "nextAttemptAt" = clock_timestamp() + INTERVAL '1 hour'
          WHERE "itemId" = ${item.itemId}
        `;
      }
    }

    return {
      jobId: job.id,
      token: {
        jobId: job.id,
        leaseOwner: 'processing-worker',
        leaseGeneration: 3,
      },
      opportunityIds,
      itemIds,
    };
  }

  async function expectCounterInvariant(jobId: string): Promise<void> {
    const job = await prisma.bulkJob.findUniqueOrThrow({
      where: { id: jobId },
    });
    expect(job.processedCount).toBe(
      job.movedCount + job.skippedCount + job.failedCount,
    );
    expect(job.matchedCount).toBeGreaterThanOrEqual(job.processedCount);
  }

  async function waitForDatabaseCondition<T>(
    read: () => Promise<T | undefined>,
    description: string,
  ): Promise<T> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const result = await read();
      if (result !== undefined) {
        return result;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${description}.`);
  }

  async function installConflictTrigger(): Promise<void> {
    await prisma.$executeRaw`
      DROP TRIGGER IF EXISTS "bulk_processing_retry_test" ON "OpportunityTransition"
    `;
    await prisma.$executeRaw`
      CREATE OR REPLACE FUNCTION "bulk_processing_retry_test"()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW."source" = 'bulk'::"TransitionSource" THEN
          RAISE EXCEPTION 'simulated transient processing failure'
            USING ERRCODE = '40001';
        END IF;
        RETURN NEW;
      END;
      $$
    `;
    await prisma.$executeRaw`
      CREATE TRIGGER "bulk_processing_retry_test"
      BEFORE INSERT ON "OpportunityTransition"
      FOR EACH ROW
      EXECUTE FUNCTION "bulk_processing_retry_test"()
    `;
  }

  async function removeConflictTrigger(): Promise<void> {
    await prisma.$executeRaw`
      DROP TRIGGER IF EXISTS "bulk_processing_retry_test" ON "OpportunityTransition"
    `;
    await prisma.$executeRaw`
      DROP FUNCTION IF EXISTS "bulk_processing_retry_test"()
    `;
    await prisma.$executeRaw`
      DROP TRIGGER IF EXISTS "bulk_processing_item_update_test" ON "BulkJobItem"
    `;
    await prisma.$executeRaw`
      DROP FUNCTION IF EXISTS "bulk_processing_item_update_test"()
    `;
  }

  beforeAll(async () => {
    previousBatchSize = process.env.BULK_JOB_BATCH_SIZE;
    process.env.BULK_JOB_BATCH_SIZE = '2';
    prisma = new PrismaService();
    await prisma.$connect();

    const workspace = await prisma.workspace.create({
      data: { name: `Processing e2e ${randomUUID()}` },
    });
    workspaceId = workspace.id;
    const stages = await prisma.stage.createManyAndReturn({
      data: [
        { workspaceId, name: 'Source', position: 1 },
        { workspaceId, name: 'Target', position: 2 },
        { workspaceId, name: 'Other', position: 3 },
      ],
      select: { id: true, position: true },
    });
    sourceStageId = stages.find((stage) => stage.position === 1)!.id;
    targetStageId = stages.find((stage) => stage.position === 2)!.id;
    otherStageId = stages.find((stage) => stage.position === 3)!.id;

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApplication(app);
    await app.init();
    leases = app.get(BulkJobLeaseService);
    processing = app.get(BulkJobProcessingService);
    if (previousBatchSize === undefined) {
      delete process.env.BULK_JOB_BATCH_SIZE;
    } else {
      process.env.BULK_JOB_BATCH_SIZE = previousBatchSize;
    }
  });

  afterEach(async () => {
    await prisma.$executeRaw`
      DROP TRIGGER IF EXISTS "bulk_processing_reclaim_test" ON "BulkJobItem"
    `;
    await prisma.$executeRaw`
      DROP FUNCTION IF EXISTS "bulk_processing_reclaim_test"()
    `;
    await prisma.$executeRaw`
      DROP TRIGGER IF EXISTS "bulk_processing_job_failure_test" ON "BulkJob"
    `;
    await prisma.$executeRaw`
      DROP FUNCTION IF EXISTS "bulk_processing_job_failure_test"()
    `;
    await prisma.$executeRaw`
      DROP TRIGGER IF EXISTS "bulk_processing_retry_test" ON "OpportunityTransition"
    `;
    await prisma.$executeRaw`
      DROP FUNCTION IF EXISTS "bulk_processing_retry_test"()
    `;
    await prisma.$executeRaw`
      DROP TRIGGER IF EXISTS "bulk_processing_lock_test" ON "Opportunity"
    `;
    await prisma.$executeRaw`
      DROP FUNCTION IF EXISTS "bulk_processing_lock_test"()
    `;
    await prisma.$executeRaw`
      DROP TRIGGER IF EXISTS "bulk_processing_heartbeat_wait_test" ON "Opportunity"
    `;
    await prisma.$executeRaw`
      DROP FUNCTION IF EXISTS "bulk_processing_heartbeat_wait_test"()
    `;
    await prisma.$executeRaw`
      DROP TRIGGER IF EXISTS "bulk_manual_race_test" ON "Opportunity"
    `;
    await prisma.$executeRaw`
      DROP FUNCTION IF EXISTS "bulk_manual_race_test"()
    `;
    const jobs = await prisma.bulkJob.findMany({
      where: { workspaceId },
      select: { id: true },
    });
    const jobIds = jobs.map((job) => job.id);
    await prisma.opportunityTransition.deleteMany({ where: { workspaceId } });
    await prisma.bulkJob.updateMany({
      where: { workspaceId },
      data: { cursorItemId: null },
    });
    await prisma.bulkJobItem.deleteMany({ where: { workspaceId } });
    await prisma.bulkJob.deleteMany({ where: { id: { in: jobIds } } });
    await prisma.opportunity.deleteMany({ where: { workspaceId } });
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
      await prisma.workspace.delete({ where: { id: workspaceId } });
    }
    if (previousBatchSize === undefined) {
      delete process.env.BULK_JOB_BATCH_SIZE;
    } else {
      process.env.BULK_JOB_BATCH_SIZE = previousBatchSize;
    }
    await app?.close();
    await prisma?.$disconnect();
  });

  it('processes no more than the configured batch size', async () => {
    const fixture = await createFixture([{}, {}, {}]);

    const result = await processing.processBatch(fixture.token);

    expect(result).toMatchObject({
      kind: 'processed',
      batchProcessedCount: 2,
      movedCount: 2,
      skippedCount: 0,
      pendingCount: 1,
      status: BulkJobStatus.running,
    });
    const items = await prisma.bulkJobItem.findMany({
      where: { jobId: fixture.jobId },
      orderBy: { itemId: 'asc' },
    });
    expect(items.map((item) => item.status)).toEqual([
      BulkJobItemStatus.moved,
      BulkJobItemStatus.moved,
      BulkJobItemStatus.pending,
    ]);
    expect(
      await prisma.opportunityTransition.count({
        where: { workspaceId, operationId: fixture.jobId },
      }),
    ).toBe(2);
    await expectCounterInvariant(fixture.jobId);
  });

  it('yields a large job so another eligible job runs before it completes', async () => {
    const largeJob = await createFixture(
      Array.from({ length: 11 }, () => ({})),
    );
    const otherJob = await createFixture([{}]);
    await prisma.bulkJob.updateMany({
      where: { id: { in: [largeJob.jobId, otherJob.jobId] } },
      data: {
        status: BulkJobStatus.queued,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });

    const processingOrder: string[] = [];
    let persistedAtYield:
      | {
          status: BulkJobStatus;
          processedCount: number;
          movedCount: number;
          skippedCount: number;
          failedCount: number;
        }
      | undefined;
    let requestWorkerShutdown = (): void => {};
    const workerProcessing = {
      processBatch: async (leaseToken: ProcessingFixture['token']) => {
        processingOrder.push(leaseToken.jobId);
        const result = await processing.processBatch(leaseToken);
        if (
          leaseToken.jobId === largeJob.jobId &&
          processingOrder.filter((jobId) => jobId === largeJob.jobId).length ===
            5
        ) {
          const job = await prisma.bulkJob.findUniqueOrThrow({
            where: { id: largeJob.jobId },
          });
          persistedAtYield = {
            status: job.status,
            processedCount: job.processedCount,
            movedCount: job.movedCount,
            skippedCount: job.skippedCount,
            failedCount: job.failedCount,
          };
        }
        if (
          leaseToken.jobId === largeJob.jobId &&
          result.kind === 'processed' &&
          result.status === BulkJobStatus.completed
        ) {
          requestWorkerShutdown();
        }
        return result;
      },
    };
    const worker = new BulkJobWorkerService(
      leases,
      workerProcessing as unknown as BulkJobProcessingService,
      {
        workerId: 'worker-quantum-e2e',
        pollIntervalMs: 100,
        leaseDurationMs: 120_000,
      },
    );
    requestWorkerShutdown = () => worker.requestShutdown();

    await worker.run();

    expect(processingOrder).toEqual([
      largeJob.jobId,
      largeJob.jobId,
      largeJob.jobId,
      largeJob.jobId,
      largeJob.jobId,
      otherJob.jobId,
      largeJob.jobId,
    ]);
    expect(persistedAtYield).toEqual({
      status: BulkJobStatus.running,
      processedCount: 10,
      movedCount: 10,
      skippedCount: 0,
      failedCount: 0,
    });

    const largeJobRecord = await prisma.bulkJob.findUniqueOrThrow({
      where: { id: largeJob.jobId },
    });
    expect(largeJobRecord).toMatchObject({
      status: BulkJobStatus.completed,
      matchedCount: 11,
      processedCount: 11,
      movedCount: 11,
      skippedCount: 0,
      failedCount: 0,
    });
    const largeItems = await prisma.bulkJobItem.findMany({
      where: { jobId: largeJob.jobId },
    });
    expect(largeItems).toHaveLength(11);
    expect(
      largeItems.every((item) => item.status === BulkJobItemStatus.moved),
    ).toBe(true);
    const largeTransitions = await prisma.opportunityTransition.findMany({
      where: { workspaceId, operationId: largeJob.jobId },
    });
    expect(largeTransitions).toHaveLength(11);
    expect(
      largeTransitions.every(
        (transition) => transition.source === TransitionSource.bulk,
      ),
    ).toBe(true);
    await expectCounterInvariant(largeJob.jobId);

    const otherJobRecord = await prisma.bulkJob.findUniqueOrThrow({
      where: { id: otherJob.jobId },
    });
    expect(otherJobRecord).toMatchObject({
      status: BulkJobStatus.completed,
      matchedCount: 1,
      processedCount: 1,
      movedCount: 1,
    });
    expect(
      await prisma.opportunityTransition.count({
        where: { workspaceId, operationId: otherJob.jobId },
      }),
    ).toBe(1);
    await expectCounterInvariant(otherJob.jobId);
  }, 30_000);

  it('updates stage versions, transition ownership, counts, and terminal status atomically', async () => {
    const fixture = await createFixture([{}]);

    const result = await processing.processBatch(fixture.token);

    expect(result).toMatchObject({
      kind: 'processed',
      batchProcessedCount: 1,
      movedCount: 1,
      status: BulkJobStatus.completed,
    });
    const opportunity = await prisma.opportunity.findUniqueOrThrow({
      where: { id: fixture.opportunityIds[0]! },
    });
    expect(opportunity.stageId).toBe(targetStageId);
    expect(opportunity.stageVersion).toBe(2);
    const transition = await prisma.opportunityTransition.findFirstOrThrow({
      where: { workspaceId, opportunityId: opportunity.id },
    });
    expect(transition).toMatchObject({
      fromStageId: sourceStageId,
      toStageId: targetStageId,
      source: TransitionSource.bulk,
      operationId: fixture.jobId,
    });
    const job = await prisma.bulkJob.findUniqueOrThrow({
      where: { id: fixture.jobId },
    });
    expect(job).toMatchObject({
      processedCount: 1,
      movedCount: 1,
      skippedCount: 0,
      failedCount: 0,
      status: BulkJobStatus.completed,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    expect(job.lastProgressAt).toBeInstanceOf(Date);
    expect(job.completedAt).toBeInstanceOf(Date);
    await expectCounterInvariant(fixture.jobId);
  });

  it('skips an opportunity already at the destination without creating a transition', async () => {
    const fixture = await createFixture([
      { opportunityStageId: targetStageId },
    ]);

    await processing.processBatch(fixture.token);

    const item = await prisma.bulkJobItem.findFirstOrThrow({
      where: { jobId: fixture.jobId },
    });
    expect(item.status).toBe(BulkJobItemStatus.skipped);
    expect(item.outcomeReason).toBe('already_at_destination');
    expect(
      await prisma.opportunityTransition.count({
        where: { workspaceId, opportunityId: fixture.opportunityIds[0]! },
      }),
    ).toBe(0);
    expect(
      (
        await prisma.opportunity.findUniqueOrThrow({
          where: { id: fixture.opportunityIds[0]! },
        })
      ).stageVersion,
    ).toBe(1);
    await expectCounterInvariant(fixture.jobId);
  });

  it('skips stale stage/version snapshots without overwriting manual changes', async () => {
    const fixture = await createFixture([{}, {}]);
    await prisma.opportunity.update({
      where: { id: fixture.opportunityIds[0]! },
      data: { stageId: otherStageId, stageVersion: 2 },
    });
    await prisma.opportunity.update({
      where: { id: fixture.opportunityIds[1]! },
      data: { stageVersion: 2 },
    });

    await processing.processBatch(fixture.token);

    const opportunities = await prisma.opportunity.findMany({
      where: { id: { in: fixture.opportunityIds } },
      orderBy: { id: 'asc' },
    });
    expect(
      opportunities.map((opportunity) => [
        opportunity.stageId,
        opportunity.stageVersion,
      ]),
    ).toContainEqual([otherStageId, 2]);
    expect(
      opportunities.map((opportunity) => [
        opportunity.stageId,
        opportunity.stageVersion,
      ]),
    ).toContainEqual([sourceStageId, 2]);
    const items = await prisma.bulkJobItem.findMany({
      where: { jobId: fixture.jobId },
    });
    expect(items).toHaveLength(2);
    expect(
      items.every((item) => item.status === BulkJobItemStatus.skipped),
    ).toBe(true);
    expect(items.every((item) => item.outcomeReason === 'stale_snapshot')).toBe(
      true,
    );
    expect(
      await prisma.opportunityTransition.count({ where: { workspaceId } }),
    ).toBe(0);
    await expectCounterInvariant(fixture.jobId);
  });

  it('processes due pending items even behind an advanced cursor and across item-ID gaps', async () => {
    const fixture = await createFixture([{}, {}], { insertGap: true });
    expect(fixture.itemIds[1]! - fixture.itemIds[0]!).toBeGreaterThan(1n);
    await prisma.bulkJob.update({
      where: { id: fixture.jobId },
      data: { cursorItemId: fixture.itemIds[1]! },
    });

    const result = await processing.processBatch(fixture.token);

    expect(result).toMatchObject({
      kind: 'processed',
      batchProcessedCount: 2,
      movedCount: 2,
      status: BulkJobStatus.completed,
    });
    const items = await prisma.bulkJobItem.findMany({
      where: { jobId: fixture.jobId },
    });
    expect(items).toHaveLength(2);
    expect(items.every((item) => item.status === BulkJobItemStatus.moved)).toBe(
      true,
    );
    expect(
      (
        await prisma.bulkJob.findUniqueOrThrow({
          where: { id: fixture.jobId },
        })
      ).cursorItemId,
    ).toBe(fixture.itemIds[1]);
    await expectCounterInvariant(fixture.jobId);
  });

  it('does not process future-scheduled pending items', async () => {
    const fixture = await createFixture([{ scheduledForFuture: true }, {}]);

    const result = await processing.processBatch(fixture.token);

    expect(result).toMatchObject({
      kind: 'processed',
      batchProcessedCount: 1,
      movedCount: 1,
      pendingCount: 1,
    });
    const items = await prisma.bulkJobItem.findMany({
      where: { jobId: fixture.jobId },
      orderBy: { itemId: 'asc' },
    });
    expect(items[0]!.status).toBe(BulkJobItemStatus.pending);
    expect(items[1]!.status).toBe(BulkJobItemStatus.moved);
    await expectCounterInvariant(fixture.jobId);
  });

  it.each([
    ['wrong owner', { leaseOwner: 'different-worker' }],
    ['wrong generation', { leaseGeneration: 4 }],
  ])('makes no changes with a %s token', async (_label, tokenChanges) => {
    const fixture = await createFixture([{}]);

    const result = await processing.processBatch({
      ...fixture.token,
      ...tokenChanges,
    });

    expect(result).toEqual({ kind: 'lease_lost' });
    await expectUnchanged(fixture);
  });

  it('rejects an expired lease without business changes', async () => {
    const fixture = await createFixture([{}]);
    await prisma.$executeRaw`
      UPDATE "BulkJob"
      SET "leaseExpiresAt" = clock_timestamp() - INTERVAL '1 second'
      WHERE "id" = ${fixture.jobId}::uuid
    `;

    expect(await processing.processBatch(fixture.token)).toEqual({
      kind: 'lease_lost',
    });
    await expectUnchanged(fixture);
  });

  it('rejects missing jobs and terminal jobs without business changes', async () => {
    const missingToken = {
      jobId: randomUUID(),
      leaseOwner: 'processing-worker',
      leaseGeneration: 3,
    };
    expect(await processing.processBatch(missingToken)).toEqual({
      kind: 'lease_lost',
    });

    const fixture = await createFixture([{}]);
    await prisma.bulkJob.update({
      where: { id: fixture.jobId },
      data: { status: BulkJobStatus.completed },
    });
    expect(await processing.processBatch(fixture.token)).toEqual({
      kind: 'lease_lost',
    });
    await expectUnchanged(fixture);
  });

  it('returns an explicit empty-work result when all pending items are scheduled later', async () => {
    const fixture = await createFixture([{ scheduledForFuture: true }]);

    expect(await processing.processBatch(fixture.token)).toEqual({
      kind: 'no_due_pending_items',
    });
    await expectUnchanged(fixture);
  });

  it('rolls back the entire batch if an item update fails', async () => {
    const fixture = await createFixture([{}, {}]);
    await prisma.$executeRaw`
      CREATE OR REPLACE FUNCTION "bulk_processing_item_update_test"()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW."status" IN ('moved'::"BulkJobItemStatus", 'skipped'::"BulkJobItemStatus") THEN
          RAISE EXCEPTION 'simulated item update failure'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$
    `;
    await prisma.$executeRaw`
      CREATE TRIGGER "bulk_processing_item_update_test"
      BEFORE UPDATE ON "BulkJobItem"
      FOR EACH ROW
      EXECUTE FUNCTION "bulk_processing_item_update_test"()
    `;

    try {
      await expect(processing.processBatch(fixture.token)).rejects.toThrow();
    } finally {
      await prisma.$executeRaw`
        DROP TRIGGER IF EXISTS "bulk_processing_item_update_test" ON "BulkJobItem"
      `;
      await prisma.$executeRaw`
        DROP FUNCTION IF EXISTS "bulk_processing_item_update_test"()
      `;
    }

    for (const opportunityId of fixture.opportunityIds) {
      const opportunity = await prisma.opportunity.findUniqueOrThrow({
        where: { id: opportunityId },
      });
      expect(opportunity.stageId).toBe(sourceStageId);
      expect(opportunity.stageVersion).toBe(1);
    }
    const items = await prisma.bulkJobItem.findMany({
      where: { jobId: fixture.jobId },
    });
    expect(
      items.every((item) => item.status === BulkJobItemStatus.pending),
    ).toBe(true);
    const job = await prisma.bulkJob.findUniqueOrThrow({
      where: { id: fixture.jobId },
    });
    expect(job.processedCount).toBe(0);
    expect(job.movedCount).toBe(0);
    expect(job.skippedCount).toBe(0);
    expect(job.lastProgressAt).toBeNull();
    expect(
      await prisma.opportunityTransition.count({
        where: { workspaceId, operationId: fixture.jobId },
      }),
    ).toBe(0);
    await expectCounterInvariant(fixture.jobId);
  });

  it('records a retryable database failure while leaving its item pending', async () => {
    const fixture = await createFixture([{}, {}]);
    await installConflictTrigger();

    try {
      await expect(processing.processBatch(fixture.token)).rejects.toThrow();
    } finally {
      await removeConflictTrigger();
    }

    const item = await prisma.bulkJobItem.findFirstOrThrow({
      where: { jobId: fixture.jobId, lastErrorCode: { not: null } },
    });
    expect(item.status).toBe(BulkJobItemStatus.pending);
    expect(item.attemptCount).toBe(1);
    expect(item.lastErrorCode).toBe('transaction_conflict');
    expect(item.nextAttemptAt).toBeInstanceOf(Date);
    const deferredState = await prisma.$queryRaw<{ isFuture: boolean }[]>`
      SELECT "nextAttemptAt" > clock_timestamp() AS "isFuture"
      FROM "BulkJobItem"
      WHERE "jobId" = ${fixture.jobId}::uuid
        AND "itemId" = ${item.itemId}
    `;
    expect(deferredState[0]?.isFuture).toBe(true);

    const itemsAfterFailure = await prisma.bulkJobItem.findMany({
      where: { jobId: fixture.jobId },
    });
    expect(itemsAfterFailure).toHaveLength(2);
    expect(
      itemsAfterFailure.every(
        (pendingItem) => pendingItem.status === BulkJobItemStatus.pending,
      ),
    ).toBe(true);
    const opportunitiesAfterFailure = await prisma.opportunity.findMany({
      where: { id: { in: fixture.opportunityIds } },
    });
    expect(
      opportunitiesAfterFailure.every(
        (opportunity) =>
          opportunity.stageId === sourceStageId &&
          opportunity.stageVersion === 1,
      ),
    ).toBe(true);
    const job = await prisma.bulkJob.findUniqueOrThrow({
      where: { id: fixture.jobId },
    });
    expect(job.processedCount).toBe(0);
    expect(job.lastProgressAt).toBeNull();
    await expectCounterInvariant(fixture.jobId);

    const retry = await processing.processBatch(fixture.token);
    expect(retry).toMatchObject({
      kind: 'processed',
      batchProcessedCount: 1,
      movedCount: 1,
      pendingCount: 1,
    });
    const remaining = await prisma.bulkJobItem.findFirstOrThrow({
      where: { jobId: fixture.jobId, itemId: item.itemId },
    });
    expect(remaining.status).toBe(BulkJobItemStatus.pending);
    expect(remaining.attemptCount).toBe(1);
    await expectCounterInvariant(fixture.jobId);
  });

  it('fails an item atomically on its fifth retryable attempt', async () => {
    const fixture = await createFixture([{}]);
    await prisma.bulkJobItem.updateMany({
      where: { jobId: fixture.jobId },
      data: { attemptCount: 4 },
    });
    await installConflictTrigger();

    try {
      await expect(processing.processBatch(fixture.token)).rejects.toThrow();
    } finally {
      await removeConflictTrigger();
    }

    const item = await prisma.bulkJobItem.findFirstOrThrow({
      where: { jobId: fixture.jobId },
    });
    expect(item).toMatchObject({
      status: BulkJobItemStatus.failed,
      attemptCount: 5,
      nextAttemptAt: null,
      outcomeReason: 'max_attempts_exceeded',
      lastErrorCode: 'transaction_conflict',
    });
    expect(item.processedAt).toBeInstanceOf(Date);

    const job = await prisma.bulkJob.findUniqueOrThrow({
      where: { id: fixture.jobId },
    });
    expect(job).toMatchObject({
      status: BulkJobStatus.completed_with_errors,
      processedCount: 1,
      failedCount: 1,
      movedCount: 0,
      skippedCount: 0,
    });
    expect(job.completedAt).toBeInstanceOf(Date);
    await expectCounterInvariant(fixture.jobId);
  });

  it('preserves mixed moved and failed outcomes at job terminalization', async () => {
    const fixture = await createFixture([{}, {}]);
    const firstOpportunityId = [...fixture.opportunityIds].sort()[0];
    const firstItemIndex = fixture.opportunityIds.indexOf(firstOpportunityId!);
    await prisma.bulkJobItem.update({
      where: {
        jobId_itemId: {
          jobId: fixture.jobId,
          itemId: fixture.itemIds[firstItemIndex]!,
        },
      },
      data: { attemptCount: 4 },
    });
    await installConflictTrigger();

    try {
      await expect(processing.processBatch(fixture.token)).rejects.toThrow();
    } finally {
      await removeConflictTrigger();
    }

    const failedItem = await prisma.bulkJobItem.findFirstOrThrow({
      where: { jobId: fixture.jobId, status: BulkJobItemStatus.failed },
    });
    expect(failedItem.attemptCount).toBe(5);

    const result = await processing.processBatch(fixture.token);
    expect(result).toMatchObject({
      kind: 'processed',
      batchProcessedCount: 1,
      movedCount: 1,
      pendingCount: 0,
      status: BulkJobStatus.completed_with_errors,
    });

    const job = await prisma.bulkJob.findUniqueOrThrow({
      where: { id: fixture.jobId },
    });
    expect(job.processedCount).toBe(2);
    expect(job.failedCount).toBe(1);
    expect(job.movedCount).toBe(1);
    expect(job.skippedCount).toBe(0);
    await expectCounterInvariant(fixture.jobId);
  });

  it('does not record fifth-attempt counters when the terminal transaction fails', async () => {
    const fixture = await createFixture([{}]);
    await prisma.bulkJobItem.updateMany({
      where: { jobId: fixture.jobId },
      data: { attemptCount: 4 },
    });
    await installConflictTrigger();
    await prisma.$executeRaw`
      CREATE OR REPLACE FUNCTION "bulk_processing_job_failure_test"()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW."failedCount" > OLD."failedCount" THEN
          RAISE EXCEPTION 'simulated terminal accounting failure'
            USING ERRCODE = '40001';
        END IF;
        RETURN NEW;
      END;
      $$
    `;
    await prisma.$executeRaw`
      CREATE TRIGGER "bulk_processing_job_failure_test"
      BEFORE UPDATE ON "BulkJob"
      FOR EACH ROW
      EXECUTE FUNCTION "bulk_processing_job_failure_test"()
    `;

    let caught: unknown;
    try {
      await processing.processBatch(fixture.token);
    } catch (error) {
      caught = error;
    } finally {
      await removeConflictTrigger();
      await prisma.$executeRaw`
        DROP TRIGGER IF EXISTS "bulk_processing_job_failure_test" ON "BulkJob"
      `;
      await prisma.$executeRaw`
        DROP FUNCTION IF EXISTS "bulk_processing_job_failure_test"()
      `;
    }

    expect(caught).toBeInstanceOf(RetryableBulkJobProcessingError);
    const item = await prisma.bulkJobItem.findFirstOrThrow({
      where: { jobId: fixture.jobId },
    });
    expect(item.status).toBe(BulkJobItemStatus.pending);
    expect(item.attemptCount).toBe(4);
    expect(item.nextAttemptAt).toBeNull();

    const job = await prisma.bulkJob.findUniqueOrThrow({
      where: { id: fixture.jobId },
    });
    expect(job.processedCount).toBe(0);
    expect(job.failedCount).toBe(0);
    await expectCounterInvariant(fixture.jobId);
  });

  it('preserves the processing error when retry metadata recording also fails', async () => {
    const fixture = await createFixture([{}]);
    await installConflictTrigger();
    let observedRolledBackState = false;
    const processingWithMetadataFailure =
      new TestMetadataFailureProcessingService(prisma, async () => {
        const opportunity = await prisma.opportunity.findUniqueOrThrow({
          where: { id: fixture.opportunityIds[0]! },
        });
        const item = await prisma.bulkJobItem.findFirstOrThrow({
          where: { jobId: fixture.jobId },
        });
        const transitions = await prisma.opportunityTransition.count({
          where: { workspaceId, operationId: fixture.jobId },
        });
        observedRolledBackState =
          opportunity.stageId === sourceStageId &&
          opportunity.stageVersion === 1 &&
          item.status === BulkJobItemStatus.pending &&
          transitions === 0;
      });

    let caught: unknown;
    try {
      await processingWithMetadataFailure.processBatch(fixture.token);
    } catch (error) {
      caught = error;
    } finally {
      await removeConflictTrigger();
    }

    expect(observedRolledBackState).toBe(true);
    expect(caught).toBeInstanceOf(RetryableBulkJobProcessingError);
    const retryError = caught as RetryableBulkJobProcessingError;
    expect(retryError.itemId).toBe(fixture.itemIds[0]);
    expect(retryError.retryMetadataStatus).toBe('failed');
    expect(retryError.cause).toMatchObject({ code: 'P2034' });
    expect(retryError.retryMetadataError).toBeInstanceOf(Error);
    expect((retryError.retryMetadataError as Error).message).toContain(
      'simulated retry metadata write failure',
    );
    const job = await prisma.bulkJob.findUniqueOrThrow({
      where: { id: fixture.jobId },
    });
    expect(job.processedCount).toBe(0);
    expect(job.movedCount).toBe(0);
    expect(job.skippedCount).toBe(0);
    const item = await prisma.bulkJobItem.findFirstOrThrow({
      where: { jobId: fixture.jobId },
    });
    expect(item.status).toBe(BulkJobItemStatus.pending);
    expect(item.attemptCount).toBe(0);
    expect(item.nextAttemptAt).toBeNull();
    expect(
      await prisma.opportunityTransition.count({ where: { workspaceId } }),
    ).toBe(0);
  });

  it('returns lease_lost when the fifth-attempt fallback encounters a reclaimed lease', async () => {
    const fixture = await createFixture([{}]);
    await prisma.bulkJobItem.updateMany({
      where: { jobId: fixture.jobId },
      data: { attemptCount: 4 },
    });
    await installConflictTrigger();
    await prisma.$executeRaw`
      CREATE OR REPLACE FUNCTION "bulk_processing_reclaim_test"()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW."status" = 'failed'::"BulkJobItemStatus" THEN
          UPDATE "BulkJob"
          SET
            "leaseOwner" = 'reclaimed-worker',
            "leaseGeneration" = "leaseGeneration" + 1,
            "leaseExpiresAt" = clock_timestamp() + INTERVAL '1 minute'
          WHERE "id" = NEW."jobId";
          RETURN NULL;
        END IF;
        RETURN NEW;
      END;
      $$
    `;
    await prisma.$executeRaw`
      CREATE TRIGGER "bulk_processing_reclaim_test"
      BEFORE UPDATE ON "BulkJobItem"
      FOR EACH ROW
      EXECUTE FUNCTION "bulk_processing_reclaim_test"()
    `;

    let caught: unknown;
    try {
      await processing.processBatch(fixture.token);
    } catch (error) {
      caught = error;
    } finally {
      await removeConflictTrigger();
      await prisma.$executeRaw`
        DROP TRIGGER IF EXISTS "bulk_processing_reclaim_test" ON "BulkJobItem"
      `;
      await prisma.$executeRaw`
        DROP FUNCTION IF EXISTS "bulk_processing_reclaim_test"()
      `;
    }

    expect(caught).toBeInstanceOf(RetryableBulkJobProcessingError);
    const retryError = caught as RetryableBulkJobProcessingError;
    expect(retryError.retryMetadataStatus).toBe('lease_lost');
    expect(retryError.cause).toMatchObject({ code: 'P2034' });
    const job = await prisma.bulkJob.findUniqueOrThrow({
      where: { id: fixture.jobId },
    });
    expect(job.leaseOwner).toBe('reclaimed-worker');
    expect(job.leaseGeneration).toBe(fixture.token.leaseGeneration + 1);
    expect(job.processedCount).toBe(0);
    expect(job.failedCount).toBe(0);
    expect(job.movedCount).toBe(0);
    expect(job.skippedCount).toBe(0);
    expect(job.status).toBe(BulkJobStatus.running);
    expect(job.leaseExpiresAt).toBeInstanceOf(Date);
    expect(job.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    const item = await prisma.bulkJobItem.findFirstOrThrow({
      where: { jobId: fixture.jobId },
    });
    expect(item.status).toBe(BulkJobItemStatus.pending);
    expect(item.attemptCount).toBe(4);
    expect(item.lastErrorCode).toBeNull();
    expect(item.nextAttemptAt).toBeNull();
    expect(
      await prisma.opportunity.findUniqueOrThrow({
        where: { id: fixture.opportunityIds[0]! },
      }),
    ).toMatchObject({ stageId: sourceStageId, stageVersion: 1 });
    expect(
      await prisma.opportunityTransition.count({ where: { workspaceId } }),
    ).toBe(0);
  });

  it('processes a future-scheduled item once its due time has passed', async () => {
    const fixture = await createFixture([{ scheduledForFuture: true }]);
    const itemId = fixture.itemIds[0]!;

    expect(await processing.processBatch(fixture.token)).toEqual({
      kind: 'no_due_pending_items',
    });
    await prisma.$executeRaw`
      UPDATE "BulkJobItem"
      SET "nextAttemptAt" = clock_timestamp() - INTERVAL '1 second'
      WHERE "jobId" = ${fixture.jobId}::uuid
        AND "itemId" = ${itemId}
    `;

    const result = await processing.processBatch(fixture.token);
    expect(result).toMatchObject({
      kind: 'processed',
      batchProcessedCount: 1,
      movedCount: 1,
      status: BulkJobStatus.completed,
    });
    await expectCounterInvariant(fixture.jobId);
  });

  it('prevents lease reclaim from overtaking a locked processing transaction', async () => {
    const fixture = await createFixture([{}, { scheduledForFuture: true }]);
    const [lease] = await prisma.$queryRaw<{ leaseExpiresAt: Date }[]>`
      UPDATE "BulkJob"
      SET "leaseExpiresAt" = clock_timestamp() + INTERVAL '3 seconds'
      WHERE "id" = ${fixture.jobId}::uuid
      RETURNING "leaseExpiresAt" AS "leaseExpiresAt"
    `;
    if (!lease) {
      throw new Error('Expected to set a processing fixture lease.');
    }

    await prisma.$executeRaw`
      DROP TRIGGER IF EXISTS "bulk_processing_lock_test" ON "Opportunity"
    `;
    await prisma.$executeRaw`
      CREATE OR REPLACE FUNCTION "bulk_processing_lock_test"()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM "Workspace"
          WHERE "id" = NEW."workspaceId"
            AND "name" LIKE 'Processing e2e %'
        ) THEN
          PERFORM pg_sleep(8);
        END IF;
        RETURN NEW;
      END;
      $$
    `;
    await prisma.$executeRaw`
      CREATE TRIGGER "bulk_processing_lock_test"
      BEFORE UPDATE ON "Opportunity"
      FOR EACH ROW
      WHEN (NEW."stageVersion" > OLD."stageVersion")
      EXECUTE FUNCTION "bulk_processing_lock_test"()
    `;

    const processingPromise = processing.processBatch(fixture.token);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1_000));

      const remaining = await prisma.$queryRaw<{ milliseconds: number }[]>`
        SELECT GREATEST(
          0,
          CEIL(EXTRACT(EPOCH FROM (
            ${lease.leaseExpiresAt}::timestamptz - clock_timestamp()
          )) * 1000)
        )::int AS "milliseconds"
      `;
      await new Promise((resolve) =>
        setTimeout(resolve, (remaining[0]?.milliseconds ?? 0) + 100),
      );

      expect(await leases.claimNext('reclaimer')).toEqual({ kind: 'empty' });
      const stillOwned = await prisma.bulkJob.findUniqueOrThrow({
        where: { id: fixture.jobId },
      });
      expect(stillOwned.leaseOwner).toBe(fixture.token.leaseOwner);
      expect(stillOwned.leaseGeneration).toBe(fixture.token.leaseGeneration);
    } finally {
      await prisma.$executeRaw`
        DROP TRIGGER IF EXISTS "bulk_processing_lock_test" ON "Opportunity"
      `;
      await prisma.$executeRaw`
        DROP FUNCTION IF EXISTS "bulk_processing_lock_test"()
      `;
    }

    await expect(processingPromise).resolves.toMatchObject({
      kind: 'processed',
      batchProcessedCount: 1,
      movedCount: 1,
      status: BulkJobStatus.running,
    });
    await prisma.$executeRaw`
      UPDATE "BulkJobItem"
      SET "nextAttemptAt" = clock_timestamp() - INTERVAL '1 second'
      WHERE "jobId" = ${fixture.jobId}::uuid
        AND "status" = 'pending'::"BulkJobItemStatus"
    `;
    const reclaimed = await leases.claimNext('reclaimer');
    expect(reclaimed.kind).toBe('claimed');
    if (reclaimed.kind !== 'claimed') {
      throw new Error('Expected the expired lease to be reclaimable.');
    }
    expect(reclaimed.token).toEqual({
      jobId: fixture.jobId,
      leaseOwner: 'reclaimer',
      leaseGeneration: fixture.token.leaseGeneration + 1,
    });
    await expectCounterInvariant(fixture.jobId);
  }, 30_000);

  it('lets a bulk move win a deterministic race with a stale manual stage edit', async () => {
    const fixture = await createFixture([{}]);
    const opportunityId = fixture.opportunityIds[0]!;
    const snapshot = await prisma.bulkJobItem.findFirstOrThrow({
      where: { jobId: fixture.jobId },
    });
    expect(snapshot).toMatchObject({
      opportunityId,
      expectedStageId: sourceStageId,
      expectedStageVersion: 1,
      status: BulkJobItemStatus.pending,
    });
    let releaseAdvisoryLock!: () => void;
    const advisoryLockReleased = new Promise<void>((resolve) => {
      releaseAdvisoryLock = resolve;
    });
    let signalLockHolderReady!: (pid: number) => void;
    let signalLockHolderFailed!: (error: unknown) => void;
    const lockHolderReady = new Promise<number>((resolve, reject) => {
      signalLockHolderReady = resolve;
      signalLockHolderFailed = reject;
    });
    let lockHolderPromise: Promise<void> | undefined;
    let processingPromise:
      ReturnType<BulkJobProcessingService['processBatch']> | undefined;
    let manualPromise: Promise<unknown> | undefined;

    try {
      await prisma.$executeRaw`
        DROP TRIGGER IF EXISTS "bulk_manual_race_test" ON "Opportunity"
      `;
      await prisma.$executeRaw`
        CREATE OR REPLACE FUNCTION "bulk_manual_race_test"()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          IF NEW."stageVersion" > OLD."stageVersion"
            AND EXISTS (
              SELECT 1
              FROM "Workspace"
              WHERE "id" = NEW."workspaceId"
                AND "name" LIKE 'Processing e2e %'
            ) THEN
            PERFORM pg_advisory_xact_lock(
              hashtextextended(NEW."id"::text, 0)
            );
          END IF;
          RETURN NEW;
        END;
        $$
      `;
      await prisma.$executeRaw`
        CREATE TRIGGER "bulk_manual_race_test"
        BEFORE UPDATE ON "Opportunity"
        FOR EACH ROW
        EXECUTE FUNCTION "bulk_manual_race_test"()
      `;

      lockHolderPromise = prisma
        .$transaction(
          async (transaction) => {
            await transaction.$executeRaw`
              SELECT pg_advisory_xact_lock(
                hashtextextended(${opportunityId}::text, 0)
              )
            `;
            const [backend] = await transaction.$queryRaw<
              { pid: number }[]
            >`SELECT pg_backend_pid() AS "pid"`;
            if (!backend) {
              throw new Error('Expected the advisory-lock backend PID.');
            }
            signalLockHolderReady(backend.pid);
            await advisoryLockReleased;
          },
          { timeout: 60_000 },
        )
        .catch((error: unknown) => {
          signalLockHolderFailed(error);
          throw error;
        });
      const lockHolderPid = await lockHolderReady;

      processingPromise = processing.processBatch(fixture.token);
      const processingPid = await waitForDatabaseCondition(async () => {
        const [backend] = await prisma.$queryRaw<{ pid: number }[]>`
          SELECT activity.pid AS "pid"
          FROM pg_stat_activity AS activity
          WHERE activity.wait_event_type = 'Lock'
            AND activity.wait_event = 'advisory'
            AND ${lockHolderPid} = ANY(pg_blocking_pids(activity.pid))
          LIMIT 1
        `;
        return backend?.pid;
      }, 'the bulk transaction to hold its opportunity lock and wait at the advisory lock');

      manualPromise = request(app.getHttpServer())
        .patch(`/api/v1/opportunities/${opportunityId}/stage`)
        .set('X-Workspace-Id', workspaceId)
        .send({
          targetStageId: otherStageId,
          expectedStageVersion: 1,
        })
        .then((response) => response);

      await waitForDatabaseCondition(async () => {
        const [backend] = await prisma.$queryRaw<{ pid: number }[]>`
          SELECT activity.pid AS "pid"
          FROM pg_stat_activity AS activity
          WHERE activity.wait_event_type = 'Lock'
            AND ${processingPid} = ANY(pg_blocking_pids(activity.pid))
            AND activity.query ILIKE '%SELECT "stageId", "stageVersion"%'
            AND activity.query ILIKE '%FOR UPDATE%'
          LIMIT 1
        `;
        return backend?.pid;
      }, 'the manual stage transaction to block behind the bulk row lock');

      releaseAdvisoryLock();
      const [processingResult, manualResponse] = await Promise.all([
        processingPromise,
        manualPromise,
      ]);

      expect(processingResult).toMatchObject({
        kind: 'processed',
        batchProcessedCount: 1,
        movedCount: 1,
        skippedCount: 0,
        pendingCount: 0,
        status: BulkJobStatus.completed,
      });
      expect(manualResponse).toMatchObject({
        status: 409,
        body: { code: 'stage_version_conflict' },
      });

      const opportunity = await prisma.opportunity.findUniqueOrThrow({
        where: { id: opportunityId },
      });
      expect(opportunity).toMatchObject({
        stageId: targetStageId,
        stageVersion: 2,
      });

      const item = await prisma.bulkJobItem.findFirstOrThrow({
        where: { jobId: fixture.jobId },
      });
      expect(item).toMatchObject({
        status: BulkJobItemStatus.moved,
        outcomeReason: 'moved',
        attemptCount: 0,
      });

      const job = await prisma.bulkJob.findUniqueOrThrow({
        where: { id: fixture.jobId },
      });
      expect(job).toMatchObject({
        matchedCount: 1,
        processedCount: 1,
        movedCount: 1,
        skippedCount: 0,
        failedCount: 0,
        status: BulkJobStatus.completed,
      });
      await expectCounterInvariant(fixture.jobId);

      const transitions = await prisma.opportunityTransition.findMany({
        where: { workspaceId, opportunityId },
      });
      expect(transitions).toHaveLength(1);
      expect(transitions[0]).toMatchObject({
        fromStageId: sourceStageId,
        toStageId: targetStageId,
        source: TransitionSource.bulk,
        operationId: fixture.jobId,
      });
    } finally {
      releaseAdvisoryLock();
      await Promise.all([
        lockHolderPromise?.then(
          () => undefined,
          () => undefined,
        ),
        processingPromise?.then(
          () => undefined,
          () => undefined,
        ),
        manualPromise?.then(
          () => undefined,
          () => undefined,
        ),
      ]);
      await prisma.$executeRaw`
        DROP TRIGGER IF EXISTS "bulk_manual_race_test" ON "Opportunity"
      `;
      await prisma.$executeRaw`
        DROP FUNCTION IF EXISTS "bulk_manual_race_test"()
      `;
    }
  }, 60_000);

  it('does not renew an expired lease after renewal waits behind batch processing', async () => {
    const fixture = await createFixture([{}, { scheduledForFuture: true }]);
    const [lease] = await prisma.$queryRaw<
      {
        leaseExpiresAt: Date;
        heartbeatAt: Date;
      }[]
    >`
      UPDATE "BulkJob"
      SET "leaseExpiresAt" = clock_timestamp() + INTERVAL '2 seconds'
      WHERE "id" = ${fixture.jobId}::uuid
      RETURNING
        "leaseExpiresAt" AS "leaseExpiresAt",
        "heartbeatAt" AS "heartbeatAt"
    `;
    if (!lease) {
      throw new Error('Expected to set a processing fixture lease.');
    }
    await prisma.$executeRaw`
      CREATE OR REPLACE FUNCTION "bulk_processing_heartbeat_wait_test"()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM "Workspace"
          WHERE "id" = NEW."workspaceId"
            AND "name" LIKE 'Processing e2e %'
        ) THEN
          PERFORM pg_sleep(6);
        END IF;
        RETURN NEW;
      END;
      $$
    `;
    await prisma.$executeRaw`
      CREATE TRIGGER "bulk_processing_heartbeat_wait_test"
      BEFORE UPDATE ON "Opportunity"
      FOR EACH ROW
      WHEN (NEW."stageVersion" > OLD."stageVersion")
      EXECUTE FUNCTION "bulk_processing_heartbeat_wait_test"()
    `;

    const processPromise = processing.processBatch(fixture.token);
    let renewalSettled = false;
    await new Promise((resolve) => setTimeout(resolve, 500));
    const renewPromise = leases.renew(fixture.token).finally(() => {
      renewalSettled = true;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      expect(renewalSettled).toBe(false);
    } finally {
      await prisma.$executeRaw`
        DROP TRIGGER IF EXISTS "bulk_processing_heartbeat_wait_test" ON "Opportunity"
      `;
      await prisma.$executeRaw`
        DROP FUNCTION IF EXISTS "bulk_processing_heartbeat_wait_test"()
      `;
    }

    await expect(processPromise).resolves.toMatchObject({
      kind: 'processed',
      batchProcessedCount: 1,
      movedCount: 1,
      status: BulkJobStatus.running,
    });
    expect(await renewPromise).toEqual({ kind: 'lease_lost' });
    const persisted = await prisma.bulkJob.findUniqueOrThrow({
      where: { id: fixture.jobId },
    });
    expect(persisted.leaseOwner).toBe(fixture.token.leaseOwner);
    expect(persisted.leaseGeneration).toBe(fixture.token.leaseGeneration);
    expect(persisted.leaseExpiresAt).toEqual(lease.leaseExpiresAt);
    expect(persisted.heartbeatAt).toEqual(lease.heartbeatAt);
    await expectCounterInvariant(fixture.jobId);
  }, 30_000);

  it('does not double-count terminal items when called again', async () => {
    const fixture = await createFixture([{}]);
    const first = await processing.processBatch(fixture.token);
    const jobAfterFirst = await prisma.bulkJob.findUniqueOrThrow({
      where: { id: fixture.jobId },
    });

    const second = await processing.processBatch(fixture.token);
    const jobAfterSecond = await prisma.bulkJob.findUniqueOrThrow({
      where: { id: fixture.jobId },
    });

    expect(first.kind).toBe('processed');
    expect(second).toEqual({ kind: 'lease_lost' });
    expect(jobAfterSecond.processedCount).toBe(jobAfterFirst.processedCount);
    expect(jobAfterSecond.movedCount).toBe(jobAfterFirst.movedCount);
    expect(
      await prisma.opportunityTransition.count({
        where: { workspaceId, operationId: fixture.jobId },
      }),
    ).toBe(1);
    await expectCounterInvariant(fixture.jobId);
  });

  async function expectUnchanged(fixture: ProcessingFixture): Promise<void> {
    const opportunity = await prisma.opportunity.findUniqueOrThrow({
      where: { id: fixture.opportunityIds[0]! },
    });
    expect(opportunity.stageId).toBe(sourceStageId);
    expect(opportunity.stageVersion).toBe(1);
    const item = await prisma.bulkJobItem.findFirstOrThrow({
      where: { jobId: fixture.jobId },
    });
    expect(item.status).toBe(BulkJobItemStatus.pending);
    const job = await prisma.bulkJob.findUniqueOrThrow({
      where: { id: fixture.jobId },
    });
    expect(job.processedCount).toBe(0);
    expect(job.movedCount).toBe(0);
    expect(job.skippedCount).toBe(0);
    expect(
      await prisma.opportunityTransition.count({
        where: { workspaceId, operationId: fixture.jobId },
      }),
    ).toBe(0);
  }
});
