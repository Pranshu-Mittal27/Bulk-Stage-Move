import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Prisma } from '../src/generated/prisma/client.js';
import { AppModule } from '../src/app.module.js';
import { configureApplication } from '../src/common/configure-application.js';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  BulkJobHealthStatus,
  BulkJobStatus,
} from '../src/generated/prisma/enums.js';

interface SubmissionBody {
  targetStageId: string;
  filter?: Record<string, unknown>;
}

describe('Bulk stage move submission API (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let sourceStageId: string;
  let targetStageId: string;
  let otherStageId: string;

  const idempotencyKey = (): string => `e2e-${randomUUID()}`;

  async function createOpportunity(
    options: {
      stageId?: string;
      ownerId?: string | null;
      status?: 'open' | 'won' | 'lost' | 'abandoned';
      value?: string;
      stageVersion?: number;
    } = {},
  ): Promise<string> {
    const opportunity = await prisma.opportunity.create({
      data: {
        workspaceId,
        stageId: options.stageId ?? sourceStageId,
        ownerId: options.ownerId ?? null,
        name: `Bulk e2e ${randomUUID()}`,
        value: new Prisma.Decimal(options.value ?? '10.0000'),
        status: options.status ?? 'open',
        stageVersion: options.stageVersion ?? 1,
      },
      select: { id: true },
    });
    return opportunity.id;
  }

  async function createOpportunities(
    rows: Array<{
      stageId?: string;
      ownerId?: string | null;
      status?: 'open' | 'won' | 'lost' | 'abandoned';
      value?: string;
      stageVersion?: number;
    }>,
  ): Promise<string[]> {
    const result = await prisma.opportunity.createManyAndReturn({
      data: rows.map((row) => ({
        workspaceId,
        stageId: row.stageId ?? sourceStageId,
        ownerId: row.ownerId ?? null,
        name: `Bulk e2e ${randomUUID()}`,
        value: new Prisma.Decimal(row.value ?? '10.0000'),
        status: row.status ?? 'open',
        stageVersion: row.stageVersion ?? 1,
      })),
      select: { id: true },
    });
    return result.map((opportunity) => opportunity.id);
  }

  function submit(
    body: SubmissionBody,
    key = idempotencyKey(),
    workspace = workspaceId,
  ) {
    return request(app.getHttpServer())
      .post('/api/v1/bulk-stage-moves')
      .set('X-Workspace-Id', workspace)
      .set('Idempotency-Key', key)
      .send(body);
  }

  async function countJobs(key: string): Promise<number> {
    return prisma.bulkJob.count({
      where: { workspaceId, idempotencyKey: key },
    });
  }

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();

    const workspace = await prisma.workspace.create({
      data: { name: `Bulk e2e ${randomUUID()}` },
    });
    workspaceId = workspace.id;
    const otherWorkspace = await prisma.workspace.create({
      data: { name: `Bulk e2e other ${randomUUID()}` },
    });
    otherWorkspaceId = otherWorkspace.id;

    const stages = await prisma.stage.createManyAndReturn({
      data: [
        { workspaceId, name: 'Source', position: 1 },
        { workspaceId, name: 'Destination', position: 2 },
        { workspaceId: otherWorkspaceId, name: 'Foreign', position: 1 },
      ],
      select: { id: true, workspaceId: true, position: true },
    });
    sourceStageId = stages.find(
      (stage) => stage.workspaceId === workspaceId && stage.position === 1,
    )!.id;
    targetStageId = stages.find(
      (stage) => stage.workspaceId === workspaceId && stage.position === 2,
    )!.id;
    otherStageId = stages.find(
      (stage) => stage.workspaceId === otherWorkspaceId,
    )!.id;

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApplication(app);
    await app.init();
  });

  afterEach(async () => {
    const workspaceIds = [workspaceId, otherWorkspaceId];
    await prisma.opportunityTransition.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    });
    await prisma.bulkJobItem.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    });
    await prisma.bulkJob.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    });
    await prisma.opportunity.deleteMany({
      where: { workspaceId: { in: workspaceIds } },
    });
  }, 60_000);

  afterAll(async () => {
    if (prisma && workspaceId && otherWorkspaceId) {
      const workspaceIds = [workspaceId, otherWorkspaceId];
      await prisma.opportunityTransition.deleteMany({
        where: { workspaceId: { in: workspaceIds } },
      });
      await prisma.bulkJobItem.deleteMany({
        where: { workspaceId: { in: workspaceIds } },
      });
      await prisma.bulkJob.deleteMany({
        where: { workspaceId: { in: workspaceIds } },
      });
      await prisma.opportunity.deleteMany({
        where: { workspaceId: { in: workspaceIds } },
      });
      await prisma.stage.deleteMany({
        where: { workspaceId: { in: workspaceIds } },
      });
      await prisma.workspace.deleteMany({
        where: { id: { in: workspaceIds } },
      });
    }
    await app?.close();
    await prisma?.$disconnect();
  }, 60_000);

  it('submits a job with an atomic snapshot and returns 202', async () => {
    const opportunityIds = await createOpportunities([{}, {}]);
    const response = await submit({ targetStageId })
      .expect(202)
      .expect(({ body }) => {
        expect(body).toMatchObject({
          status: 'queued',
          health: 'healthy',
          targetStageId,
          matchedCount: 2,
          processedCount: 0,
          movedCount: 0,
          skippedCount: 0,
          failedCount: 0,
          pendingCount: 2,
          startedAt: null,
          completedAt: null,
          waitingReason: null,
        });
      });

    const items = await prisma.bulkJobItem.findMany({
      where: { workspaceId, jobId: response.body.id },
    });
    expect(items.map((item) => item.opportunityId).sort()).toEqual(
      opportunityIds.sort(),
    );
    expect(items.every((item) => item.status === 'pending')).toBe(true);
    expect(items.every((item) => item.expectedStageId === sourceStageId)).toBe(
      true,
    );
    expect(items.every((item) => item.expectedStageVersion === 1)).toBe(true);
  });

  it('returns the same job for an equivalent normalized request', async () => {
    await createOpportunity();
    const key = idempotencyKey();
    const first = await submit(
      {
        targetStageId,
        filter: {
          valueRange: { min: '1.0' },
          createdAt: { from: '2026-03-01T10:00:00.100Z' },
        },
      },
      key,
    ).expect(202);
    const second = await submit(
      {
        targetStageId: targetStageId.toUpperCase(),
        filter: {
          valueRange: { min: '1.0000' },
          createdAt: { from: '2026-03-01T12:00:00.100000+02:00' },
        },
      },
      key,
    ).expect(200);

    expect(second.body.id).toBe(first.body.id);
    expect(await countJobs(key)).toBe(1);
    expect(
      await prisma.bulkJobItem.count({
        where: { workspaceId, jobId: first.body.id },
      }),
    ).toBe(1);
  });

  it('rejects a reused idempotency key with a different canonical request', async () => {
    await createOpportunity();
    const key = idempotencyKey();
    await submit({ targetStageId }, key).expect(202);
    await submit({ targetStageId, filter: { status: 'won' } }, key)
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('idempotency_key_reused'));
    expect(await countJobs(key)).toBe(1);
  });

  it('allows only one concurrent same-key submission and snapshot', async () => {
    await createOpportunities([{}, {}, {}]);
    const key = idempotencyKey();
    const responses = await Promise.all([
      submit({ targetStageId }, key),
      submit({ targetStageId }, key),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 202,
    ]);
    expect(responses[0]!.body.id).toBe(responses[1]!.body.id);
    expect(await countJobs(key)).toBe(1);
    const jobs = await prisma.bulkJob.findMany({
      where: { workspaceId, idempotencyKey: key },
      select: { id: true },
    });
    expect(
      await prisma.bulkJobItem.count({
        where: { workspaceId, jobId: jobs[0]!.id },
      }),
    ).toBe(3);
  });

  it('resolves concurrent different requests to one job and one matching snapshot', async () => {
    const [openOpportunityId, wonOpportunityId] = await createOpportunities([
      { status: 'open' },
      { status: 'won' },
    ]);
    const key = idempotencyKey();
    const submissions = [
      { targetStageId, filter: { status: 'open' } },
      { targetStageId, filter: { status: 'won' } },
    ] as const;
    const responses = await Promise.all(
      submissions.map((body) => submit(body, key)),
    );

    expect(responses.map((response) => response.status).sort()).toEqual([
      202, 409,
    ]);
    const winnerIndex = responses.findIndex(
      (response) => response.status === 202,
    );
    const conflictIndex = responses.findIndex(
      (response) => response.status === 409,
    );
    expect(responses[conflictIndex]!.body.code).toBe('idempotency_key_reused');

    const jobs = await prisma.bulkJob.findMany({
      where: { workspaceId, idempotencyKey: key },
    });
    expect(jobs).toHaveLength(1);
    const job = jobs[0]!;
    const expectedOpportunityId =
      submissions[winnerIndex]!.filter.status === 'open'
        ? openOpportunityId
        : wonOpportunityId;
    const items = await prisma.bulkJobItem.findMany({
      where: { workspaceId, jobId: job.id },
      select: { opportunityId: true },
    });
    expect(job.matchedCount).toBe(1);
    expect(items.map((item) => item.opportunityId)).toEqual([
      expectedOpportunityId,
    ]);
    expect(items).toHaveLength(job.matchedCount);
  });

  it('applies all filters with inclusive decimal and lower-time bounds and exclusive upper time', async () => {
    const ownerId = randomUUID();
    const from = '2026-03-01T10:00:00.000000Z';
    const to = '2026-03-01T10:02:00.000000Z';
    const fixtureRows = [
      {
        id: randomUUID(),
        ownerId,
        stageId: sourceStageId,
        status: 'open',
        value: '10',
        createdAt: from,
      },
      {
        id: randomUUID(),
        ownerId,
        stageId: sourceStageId,
        status: 'open',
        value: '20',
        createdAt: '2026-03-01T10:01:00.000000Z',
      },
      {
        id: randomUUID(),
        ownerId,
        stageId: sourceStageId,
        status: 'open',
        value: '15',
        createdAt: '2026-03-01T09:59:59.999000Z',
      },
      {
        id: randomUUID(),
        ownerId,
        stageId: sourceStageId,
        status: 'open',
        value: '15',
        createdAt: to,
      },
      {
        id: randomUUID(),
        ownerId: randomUUID(),
        stageId: sourceStageId,
        status: 'open',
        value: '15',
        createdAt: from,
      },
      {
        id: randomUUID(),
        ownerId,
        stageId: sourceStageId,
        status: 'won',
        value: '15',
        createdAt: from,
      },
      {
        id: randomUUID(),
        ownerId,
        stageId: targetStageId,
        status: 'open',
        value: '15',
        createdAt: from,
      },
      {
        id: randomUUID(),
        ownerId,
        stageId: sourceStageId,
        status: 'open',
        value: '20.0001',
        createdAt: from,
      },
    ] as const;
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "Opportunity" (
        "id", "workspaceId", "stageId", "ownerId", "name", "value",
        "status", "stageVersion", "createdAt", "updatedAt"
      )
      VALUES ${Prisma.join(
        fixtureRows.map(
          (row) => Prisma.sql`(
            ${row.id}::uuid, ${workspaceId}::uuid, ${row.stageId}::uuid,
            ${row.ownerId}::uuid, 'Filter fixture', ${new Prisma.Decimal(row.value)},
            ${row.status}::"OpportunityStatus", 1,
            ${row.createdAt}::timestamptz, CURRENT_TIMESTAMP
          )`,
        ),
        ', ',
      )}
    `);
    const expectedIds = fixtureRows.slice(0, 2).map((row) => row.id);
    const fromBound = '2026-03-01T10:00:00.000Z';
    const toBound = '2026-03-01T10:02:00.000Z';
    const response = await submit({
      targetStageId,
      filter: {
        stageId: sourceStageId,
        ownerId,
        status: 'open',
        valueRange: { min: '10.0000', max: '20.0000' },
        createdAt: {
          from: fromBound,
          to: toBound,
        },
      },
    }).expect(202);
    const items = await prisma.bulkJobItem.findMany({
      where: { workspaceId, jobId: response.body.id },
      select: { opportunityId: true },
    });
    expect(items.map((item) => item.opportunityId).sort()).toEqual(
      expectedIds.sort(),
    );
  });

  it('preserves microsecond precision for created-at filter boundaries', async () => {
    const matchingId = randomUUID();
    const belowId = randomUUID();
    const upperBoundaryId = randomUUID();
    await prisma.$executeRaw`
      INSERT INTO "Opportunity" (
        "id", "workspaceId", "stageId", "name", "value", "status",
        "stageVersion", "createdAt", "updatedAt"
      )
      VALUES
        (${matchingId}::uuid, ${workspaceId}::uuid, ${sourceStageId}::uuid,
         'Microsecond matching fixture', 0, 'open'::"OpportunityStatus",
         1, '2026-03-01T10:00:00.000500Z'::timestamptz, CURRENT_TIMESTAMP),
        (${belowId}::uuid, ${workspaceId}::uuid, ${sourceStageId}::uuid,
         'Microsecond lower fixture', 0, 'open'::"OpportunityStatus",
         1, '2026-03-01T10:00:00.000499Z'::timestamptz, CURRENT_TIMESTAMP),
        (${upperBoundaryId}::uuid, ${workspaceId}::uuid, ${sourceStageId}::uuid,
         'Microsecond upper fixture', 0, 'open'::"OpportunityStatus",
         1, '2026-03-01T10:00:00.000501Z'::timestamptz, CURRENT_TIMESTAMP)
    `;

    const response = await submit({
      targetStageId,
      filter: {
        createdAt: {
          from: '2026-03-01T10:00:00.000500Z',
          to: '2026-03-01T10:00:00.000501Z',
        },
      },
    }).expect(202);
    const items = await prisma.bulkJobItem.findMany({
      where: { workspaceId, jobId: response.body.id },
      select: { opportunityId: true },
    });
    expect(items.map((item) => item.opportunityId)).toEqual([matchingId]);
  });

  it('scopes snapshots to the workspace and rejects a foreign destination stage', async () => {
    await createOpportunity();
    await prisma.opportunity.create({
      data: {
        workspaceId: otherWorkspaceId,
        stageId: otherStageId,
        name: `Foreign ${randomUUID()}`,
        value: new Prisma.Decimal('10'),
        status: 'open',
        stageVersion: 1,
      },
    });
    const key = idempotencyKey();
    await submit({ targetStageId }, key).expect(202);
    const job = await prisma.bulkJob.findUniqueOrThrow({
      where: {
        workspaceId_idempotencyKey: { workspaceId, idempotencyKey: key },
      },
    });
    expect(
      await prisma.bulkJobItem.count({
        where: { workspaceId, jobId: job.id },
      }),
    ).toBe(1);

    await submit({ targetStageId: otherStageId }, idempotencyKey())
      .expect(404)
      .expect(({ body }) => expect(body.code).toBe('resource_not_found'));
  });

  it('rejects more than 50,000 matches without persisting a job or items', async () => {
    const key = idempotencyKey();
    await prisma.$executeRaw`
      INSERT INTO "Opportunity" (
        "id", "workspaceId", "stageId", "name", "value", "status",
        "stageVersion", "createdAt", "updatedAt"
      )
      SELECT
        gen_random_uuid(),
        ${workspaceId}::uuid,
        ${sourceStageId}::uuid,
        'Bulk limit fixture ' || series::text,
        0,
        'open'::"OpportunityStatus",
        1,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      FROM generate_series(1, 50001) AS series
    `;

    await submit({ targetStageId }, key)
      .expect(422)
      .expect(({ body }) => expect(body.code).toBe('validation_failed'));
    expect(await countJobs(key)).toBe(0);
    expect(await prisma.bulkJobItem.count({ where: { workspaceId } })).toBe(0);
  }, 60_000);

  it('accepts exactly 50,000 matches and snapshots every matching opportunity', async () => {
    const insertedOpportunities = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO "Opportunity" (
        "id", "workspaceId", "stageId", "name", "value", "status",
        "stageVersion", "createdAt", "updatedAt"
      )
      SELECT
        gen_random_uuid(),
        ${workspaceId}::uuid,
        ${sourceStageId}::uuid,
        'Exact limit fixture ' || series::text,
        0,
        'open'::"OpportunityStatus",
        1,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      FROM generate_series(1, 50000) AS series
      RETURNING "id"
    `;
    expect(insertedOpportunities).toHaveLength(50_000);

    const key = idempotencyKey();
    const response = await submit({ targetStageId }, key);
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      matchedCount: 50_000,
      processedCount: 0,
      pendingCount: 50_000,
    });

    const snapshotCount = await prisma.bulkJobItem.count({
      where: { workspaceId, jobId: response.body.id },
    });
    expect(snapshotCount).toBe(50_000);
    const snapshotIds = await prisma.bulkJobItem.findMany({
      where: { workspaceId, jobId: response.body.id },
      select: { opportunityId: true },
    });
    expect(snapshotIds.map((item) => item.opportunityId).sort()).toEqual(
      insertedOpportunities.map((opportunity) => opportunity.id).sort(),
    );
  }, 240_000);

  it('completes immediately when no opportunities match', async () => {
    const response = await submit({
      targetStageId,
      filter: { status: 'won' },
    }).expect(202);
    expect(response.body).toMatchObject({
      status: BulkJobStatus.completed,
      health: 'healthy',
      matchedCount: 0,
      processedCount: 0,
      movedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      pendingCount: 0,
    });
    expect(response.body.completedAt).toEqual(expect.any(String));
    expect(
      await prisma.bulkJobItem.count({
        where: { workspaceId, jobId: response.body.id },
      }),
    ).toBe(0);
  });

  it('includes opportunities already at the destination in the snapshot', async () => {
    const opportunityId = await createOpportunity({ stageId: targetStageId });
    const response = await submit({ targetStageId }).expect(202);
    const item = await prisma.bulkJobItem.findFirstOrThrow({
      where: { workspaceId, jobId: response.body.id },
    });
    expect(item.opportunityId).toBe(opportunityId);
    expect(item.expectedStageId).toBe(targetStageId);
  });

  it('does not add opportunities created after the committed snapshot', async () => {
    const firstOpportunityId = await createOpportunity();
    const response = await submit({ targetStageId }).expect(202);
    const laterOpportunityId = await createOpportunity();
    const snapshotIds = await prisma.bulkJobItem.findMany({
      where: { workspaceId, jobId: response.body.id },
      select: { opportunityId: true },
    });
    expect(snapshotIds.map((item) => item.opportunityId)).toEqual([
      firstOpportunityId,
    ]);
    expect(
      snapshotIds.some((item) => item.opportunityId === laterOpportunityId),
    ).toBe(false);
  });

  it('returns workspace-scoped persisted job status and hides foreign jobs', async () => {
    await createOpportunities([{}, {}]);
    const response = await submit({ targetStageId }).expect(202);
    const progressAt = new Date();
    await prisma.bulkJob.update({
      where: { id: response.body.id },
      data: {
        status: BulkJobStatus.failed,
        healthStatus: BulkJobHealthStatus.slow,
        processedCount: 1,
        movedCount: 1,
        startedAt: progressAt,
        heartbeatAt: progressAt,
        lastProgressAt: progressAt,
        completedAt: progressAt,
        failureCode: 'worker_failed',
        failureMessage: 'Internal SQL and credential details must not leak.',
      },
    });
    const status = await request(app.getHttpServer())
      .get(`/api/v1/bulk-stage-moves/${response.body.id}`)
      .set('X-Workspace-Id', workspaceId)
      .expect(200);
    expect(status.body).toMatchObject({
      id: response.body.id,
      status: 'failed',
      health: 'slow',
      targetStageId,
      matchedCount: 2,
      processedCount: 1,
      movedCount: 1,
      skippedCount: 0,
      failedCount: 0,
      pendingCount: 1,
      failureCode: 'worker_failed',
      failureMessage:
        'The job failed. Refer to the failure code or contact support.',
      waitingReason: null,
    });
    expect(status.body.createdAt).toEqual(expect.any(String));
    expect(status.body.startedAt).toBe(progressAt.toISOString());
    expect(status.body.completedAt).toBe(progressAt.toISOString());
    expect(status.body.heartbeatAt).toBe(progressAt.toISOString());
    expect(status.body.lastProgressAt).toBe(progressAt.toISOString());
    expect(status.body.failureMessage).not.toContain('credential');

    await request(app.getHttpServer())
      .get(`/api/v1/bulk-stage-moves/${response.body.id}`)
      .set('X-Workspace-Id', otherWorkspaceId)
      .expect(404)
      .expect(({ body }) => expect(body.code).toBe('resource_not_found'));
  });

  it('rolls back the job when snapshot materialization fails', async () => {
    await createOpportunity();
    const key = idempotencyKey();
    const failingDatabase = new PrismaService();
    const failingPrisma = new Proxy(failingDatabase, {
      get(target, property, receiver) {
        if (property === '$transaction') {
          return (
            callback: (
              transaction: Prisma.TransactionClient,
            ) => Promise<unknown>,
            options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
          ) =>
            target.$transaction((transaction) => {
              const failingTransaction = new Proxy(transaction, {
                get(
                  transactionTarget,
                  transactionProperty,
                  transactionReceiver,
                ) {
                  if (transactionProperty === '$queryRaw') {
                    return () => {
                      throw new Error('Injected snapshot failure.');
                    };
                  }
                  return Reflect.get(
                    transactionTarget,
                    transactionProperty,
                    transactionReceiver,
                  );
                },
              });
              return callback(failingTransaction as Prisma.TransactionClient);
            }, options);
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(failingPrisma)
      .compile();
    const failingApp = moduleRef.createNestApplication();
    configureApplication(failingApp);
    await failingApp.init();

    try {
      await request(failingApp.getHttpServer())
        .post('/api/v1/bulk-stage-moves')
        .set('X-Workspace-Id', workspaceId)
        .set('Idempotency-Key', key)
        .send({ targetStageId })
        .expect(500)
        .expect(({ body }) => {
          expect(body.code).toBe('internal_error');
          expect(body.message).not.toContain('Injected');
        });
    } finally {
      await failingApp.close();
      await failingDatabase.$disconnect();
    }

    expect(await countJobs(key)).toBe(0);
    expect(await prisma.bulkJobItem.count({ where: { workspaceId } })).toBe(0);
  });

  it('validates required headers, UUIDs, ranges, and filter values', async () => {
    const validBody = { targetStageId };
    await request(app.getHttpServer())
      .post('/api/v1/bulk-stage-moves')
      .set('X-Workspace-Id', workspaceId)
      .send(validBody)
      .expect(400);

    await request(app.getHttpServer())
      .post('/api/v1/bulk-stage-moves')
      .set('X-Workspace-Id', workspaceId)
      .set('Idempotency-Key', ' ')
      .send(validBody)
      .expect(400);

    await submit({ targetStageId: 'not-a-uuid' })
      .expect(400)
      .expect(({ body }) => expect(body.code).toBe('validation_error'));
    await submit({
      targetStageId,
      filter: { valueRange: { min: '1e2' } },
    }).expect(400);
    await submit({
      targetStageId,
      filter: { valueRange: { min: '10', max: '9.99' } },
    }).expect(400);
    await submit({
      targetStageId,
      filter: {
        createdAt: {
          from: '2026-01-02T00:00:00.000Z',
          to: '2026-01-01T00:00:00.000Z',
        },
      },
    }).expect(400);
    await submit({
      targetStageId,
      filter: { status: 'invalid' },
    }).expect(400);
  });
});
