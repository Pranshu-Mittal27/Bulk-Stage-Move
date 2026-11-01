import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { configureApplication } from '../src/common/configure-application.js';
import { BulkJobLeaseService } from '../src/bulk-stage-moves/bulk-job-lease.service.js';
import {
  BulkJobProcessingService,
  RetryableBulkJobProcessingError,
  type RetryMetadataStatus,
} from '../src/bulk-stage-moves/bulk-job-processing.service.js';
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

class TestStaleLeaseProcessingService extends BulkJobProcessingService {
  constructor(
    private readonly database: PrismaService,
    private readonly jobId: string,
  ) {
    super(database);
  }

  protected override async recordRetryableAttempt(
    token: ProcessingFixture['token'],
    itemId: bigint,
    previousAttemptCount: number,
    errorCode: string,
  ): Promise<RetryMetadataStatus> {
    await this.database.bulkJob.update({
      where: { id: this.jobId },
      data: {
        leaseOwner: 'reclaimed-worker',
        leaseGeneration: token.leaseGeneration + 1,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    return super.recordRetryableAttempt(
      token,
      itemId,
      previousAttemptCount,
      errorCode,
    );
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
    await prisma.bulkJobItem.update({
      where: { itemId: fixture.itemIds[1]! },
      data: { attemptCount: 2_147_483_647 },
    });

    await expect(processing.processBatch(fixture.token)).rejects.toThrow();

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

  it('does not record retry metadata after lease ownership changes during rollback', async () => {
    const fixture = await createFixture([{}]);
    await installConflictTrigger();
    const staleLeaseProcessor = new TestStaleLeaseProcessingService(
      prisma,
      fixture.jobId,
    );

    let caught: unknown;
    try {
      await staleLeaseProcessor.processBatch(fixture.token);
    } catch (error) {
      caught = error;
    } finally {
      await removeConflictTrigger();
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
    const item = await prisma.bulkJobItem.findFirstOrThrow({
      where: { jobId: fixture.jobId },
    });
    expect(item.status).toBe(BulkJobItemStatus.pending);
    expect(item.attemptCount).toBe(0);
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
