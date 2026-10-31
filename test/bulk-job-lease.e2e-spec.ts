import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { BulkJobLeaseService } from '../src/bulk-stage-moves/bulk-job-lease.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { BulkJobStatus } from '../src/generated/prisma/enums.js';

describe('Bulk job lease service (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let leases: BulkJobLeaseService;
  let workspaceId: string;
  let stageId: string;

  async function createJob(): Promise<{ id: string; itemId: bigint }> {
    const opportunity = await prisma.opportunity.create({
      data: {
        workspaceId,
        stageId,
        name: `Lease e2e ${randomUUID()}`,
        value: '1.0000',
      },
      select: { id: true, stageId: true, stageVersion: true },
    });
    const job = await prisma.bulkJob.create({
      data: {
        workspaceId,
        idempotencyKey: `lease-e2e-${randomUUID()}`,
        canonicalRequestHash: randomUUID(),
        normalizedRequest: { apiVersion: 1 },
        targetStageId: stageId,
        matchedCount: 1,
      },
      select: { id: true },
    });
    const item = await prisma.bulkJobItem.create({
      data: {
        workspaceId,
        jobId: job.id,
        opportunityId: opportunity.id,
        expectedStageId: opportunity.stageId,
        expectedStageVersion: opportunity.stageVersion,
      },
      select: { itemId: true },
    });
    return { id: job.id, itemId: item.itemId };
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

  it('does not claim a queued job scheduled for the future', async () => {
    const created = await createJob();
    await prisma.$executeRaw`
      UPDATE "BulkJob"
      SET "nextAttemptAt" = clock_timestamp() + INTERVAL '1 hour'
      WHERE "id" = ${created.id}::uuid
    `;

    expect(await leases.claimNext('worker-a')).toEqual({ kind: 'empty' });
    const job = await prisma.bulkJob.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(job.status).toBe(BulkJobStatus.queued);
    expect(job.leaseOwner).toBeNull();
    expect(job.leaseGeneration).toBe(0);
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
    expect(persisted.nextAttemptAt).not.toBeNull();
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

  it('returns an explicit empty result when no work is eligible', async () => {
    expect(await leases.claimNext('worker-idle')).toEqual({ kind: 'empty' });
  });

  it('requires an explicit non-empty worker identity', async () => {
    await expect(leases.claimNext('')).rejects.toThrow('Worker ID');
    await expect(leases.claimNext('   ')).rejects.toThrow('Worker ID');
  });
});
