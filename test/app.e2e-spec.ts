import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Prisma } from '../src/generated/prisma/client.js';
import { AppModule } from '../src/app.module.js';
import { configureApplication } from '../src/common/configure-application.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { TransitionSource } from '../src/generated/prisma/enums.js';

interface OpportunityJson {
  id: string;
  workspaceId: string;
  stageId: string;
  ownerId: string | null;
  name: string;
  value: string;
  status: string;
  stageVersion: number;
  createdAt: string;
  updatedAt: string;
}

describe('Opportunity API (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let stageId: string;
  let secondStageId: string;
  let otherStageId: string;
  let fixtureFailure: Error | undefined;

  const workspaceHeader = (): { 'X-Workspace-Id': string } => ({
    'X-Workspace-Id': workspaceId,
  });

  async function createOpportunity(
    overrides: Record<string, unknown> = {},
    stage = stageId,
  ): Promise<OpportunityJson> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/opportunities')
      .set(workspaceHeader())
      .send({
        stageId: stage,
        name: 'Test opportunity',
        value: '12500.00',
        ...overrides,
      })
      .expect(201);
    return response.body as OpportunityJson;
  }

  async function transitionCount(opportunityId: string): Promise<number> {
    return prisma.opportunityTransition.count({
      where: { workspaceId, opportunityId },
    });
  }

  beforeAll(async () => {
    try {
      prisma = new PrismaService();
      await prisma.$connect();

      const workspace = await prisma.workspace.create({
        data: { name: `Opportunity e2e ${randomUUID()}` },
      });
      workspaceId = workspace.id;
      const otherWorkspace = await prisma.workspace.create({
        data: { name: `Opportunity e2e other ${randomUUID()}` },
      });
      otherWorkspaceId = otherWorkspace.id;

      const stages = await prisma.stage.createManyAndReturn({
        data: [
          { workspaceId, name: 'Initial', position: 1 },
          { workspaceId, name: 'Next', position: 2 },
          { workspaceId: otherWorkspaceId, name: 'Foreign', position: 1 },
        ],
        select: { id: true, workspaceId: true, position: true },
      });
      stageId = stages.find(
        (stage) => stage.workspaceId === workspaceId && stage.position === 1,
      )!.id;
      secondStageId = stages.find(
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
    } catch (error) {
      fixtureFailure =
        error instanceof Error
          ? error
          : new Error('Unknown fixture setup error');
      throw error;
    }
  });

  afterAll(async () => {
    if (prisma && workspaceId && otherWorkspaceId) {
      await prisma.opportunityTransition.deleteMany({
        where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } },
      });
      await prisma.opportunity.deleteMany({
        where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } },
      });
      await prisma.stage.deleteMany({
        where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } },
      });
      await prisma.workspace.deleteMany({
        where: { id: { in: [workspaceId, otherWorkspaceId] } },
      });
    }
    await app?.close();
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    if (fixtureFailure) {
      throw fixtureFailure;
    }
    await prisma.opportunityTransition.deleteMany({
      where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } },
    });
    await prisma.opportunity.deleteMany({
      where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } },
    });
  });

  it('creates an opportunity with a decimal string and initial history', async () => {
    const ownerId = randomUUID();
    const response = await request(app.getHttpServer())
      .post('/api/v1/opportunities')
      .set(workspaceHeader())
      .send({
        stageId,
        ownerId,
        name: '  Example opportunity  ',
        value: '12500.01',
      })
      .expect(201);

    expect(response.body).toMatchObject({
      workspaceId,
      stageId,
      ownerId,
      name: 'Example opportunity',
      value: '12500.0100',
      status: 'open',
      stageVersion: 1,
    });
    expect(response.body.id).toEqual(expect.any(String));
    expect(response.body.createdAt).toEqual(expect.any(String));
    expect(response.body.updatedAt).toEqual(expect.any(String));

    const transitions = await prisma.opportunityTransition.findMany({
      where: { workspaceId, opportunityId: response.body.id },
    });
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      fromStageId: null,
      toStageId: stageId,
      source: TransitionSource.manual,
    });
  });

  it('rejects unknown workspace and a stage owned by another workspace', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/opportunities')
      .set('X-Workspace-Id', randomUUID())
      .send({ stageId, name: 'Unknown workspace', value: '1' })
      .expect(404)
      .expect(({ body }) => expect(body.code).toBe('resource_not_found'));

    await request(app.getHttpServer())
      .post('/api/v1/opportunities')
      .set(workspaceHeader())
      .send({ stageId: otherStageId, name: 'Foreign stage', value: '1' })
      .expect(404)
      .expect(({ body }) => expect(body.code).toBe('resource_not_found'));
  });

  it.each([
    ['empty name', { name: '   ' }],
    ['negative value', { value: '-1' }],
    ['too many fractional digits', { value: '1.00001' }],
    ['too many integer digits', { value: '1000000000000000' }],
    ['numeric value instead of string', { value: 1 }],
    ['invalid status', { status: 'pending' }],
    ['null status', { status: null }],
    ['malformed stage UUID', { stageId: 'not-a-uuid' }],
    ['malformed owner UUID', { ownerId: 'not-a-uuid' }],
  ])('rejects invalid create input: %s', async (_label, overrides) => {
    await request(app.getHttpServer())
      .post('/api/v1/opportunities')
      .set(workspaceHeader())
      .send({
        stageId,
        name: 'Valid name',
        value: '1',
        ...overrides,
      })
      .expect(400)
      .expect(({ body }) => expect(body.code).toBe('validation_error'));
  });

  it('requires a valid workspace header', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/opportunities')
      .send({ stageId, name: 'No workspace', value: '1' })
      .expect(400);

    await request(app.getHttpServer())
      .get(`/api/v1/opportunities?stageId=${stageId}`)
      .set('X-Workspace-Id', 'invalid')
      .expect(400);
  });

  it('lists only opportunities from the requested workspace and stage', async () => {
    const requested = await createOpportunity();
    await createOpportunity({}, secondStageId);
    await prisma.opportunity.create({
      data: {
        workspaceId: otherWorkspaceId,
        stageId: otherStageId,
        name: 'Foreign opportunity',
        value: new Prisma.Decimal('2'),
      },
    });

    const response = await request(app.getHttpServer())
      .get(`/api/v1/opportunities?stageId=${stageId}`)
      .set(workspaceHeader())
      .expect(200);

    expect(response.body.items.map((item: OpportunityJson) => item.id)).toEqual(
      [requested.id],
    );
    expect(response.body.pagination).toEqual({ limit: 50, nextCursor: null });
  });

  it('paginates by cursor without missing or repeating opportunities', async () => {
    const created: OpportunityJson[] = [];
    for (let index = 0; index < 5; index += 1) {
      created.push(await createOpportunity({ name: `Page ${index}` }));
    }
    const expectedIds = created.map(({ id }) => id).sort();
    const receivedIds: string[] = [];
    let cursor: string | null = null;

    do {
      const query = new URLSearchParams({ stageId, limit: '2' });
      if (cursor) {
        query.set('cursor', cursor);
      }
      const response = await request(app.getHttpServer())
        .get(`/api/v1/opportunities?${query.toString()}`)
        .set(workspaceHeader())
        .expect(200);

      receivedIds.push(
        ...response.body.items.map((item: OpportunityJson) => item.id),
      );
      cursor = response.body.pagination.nextCursor;
      expect(response.body.items.length).toBeLessThanOrEqual(2);
    } while (cursor);

    expect(receivedIds).toEqual(expectedIds);
    expect(new Set(receivedIds).size).toBe(expectedIds.length);
  });

  it.each([
    ['missing stage filter', ''],
    ['invalid stage UUID', '?stageId=invalid'],
    ['invalid cursor', `?stageId=${stageId}&cursor=invalid`],
    ['limit below range', `?stageId=${stageId}&limit=0`],
    ['limit above range', `?stageId=${stageId}&limit=101`],
    ['non-integer limit', `?stageId=${stageId}&limit=1.5`],
  ])('rejects invalid list query: %s', async (_label, query) => {
    await request(app.getHttpServer())
      .get(`/api/v1/opportunities${query}`)
      .set(workspaceHeader())
      .expect(400)
      .expect(({ body }) => expect(body.code).toBe('validation_error'));
  });

  it('moves an opportunity once and writes exactly one manual transition', async () => {
    const opportunity = await createOpportunity();
    const response = await request(app.getHttpServer())
      .patch(`/api/v1/opportunities/${opportunity.id}/stage`)
      .set(workspaceHeader())
      .send({ targetStageId: secondStageId, expectedStageVersion: 1 })
      .expect(200);

    expect(response.body.stageId).toBe(secondStageId);
    expect(response.body.stageVersion).toBe(2);
    const transitions = await prisma.opportunityTransition.findMany({
      where: { workspaceId, opportunityId: opportunity.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(transitions).toHaveLength(2);
    expect(transitions[1]).toMatchObject({
      fromStageId: stageId,
      toStageId: secondStageId,
      source: TransitionSource.manual,
    });
  });

  it('returns a conflict for a stale version without changing opportunity or history', async () => {
    const opportunity = await createOpportunity();
    await request(app.getHttpServer())
      .patch(`/api/v1/opportunities/${opportunity.id}/stage`)
      .set(workspaceHeader())
      .send({ targetStageId: secondStageId, expectedStageVersion: 0 })
      .expect(400);

    await request(app.getHttpServer())
      .patch(`/api/v1/opportunities/${opportunity.id}/stage`)
      .set(workspaceHeader())
      .send({ targetStageId: secondStageId, expectedStageVersion: 2 })
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('stage_version_conflict'));

    const unchanged = await prisma.opportunity.findFirstOrThrow({
      where: { workspaceId, id: opportunity.id },
    });
    expect(unchanged.stageId).toBe(stageId);
    expect(unchanged.stageVersion).toBe(1);
    expect(await transitionCount(opportunity.id)).toBe(1);
  });

  it('rejects a foreign target stage without changing opportunity or history', async () => {
    const opportunity = await createOpportunity();
    await request(app.getHttpServer())
      .patch(`/api/v1/opportunities/${opportunity.id}/stage`)
      .set(workspaceHeader())
      .send({ targetStageId: otherStageId, expectedStageVersion: 1 })
      .expect(404);

    const unchanged = await prisma.opportunity.findFirstOrThrow({
      where: { workspaceId, id: opportunity.id },
    });
    expect(unchanged.stageId).toBe(stageId);
    expect(unchanged.stageVersion).toBe(1);
    expect(await transitionCount(opportunity.id)).toBe(1);
  });

  it('rejects invalid transition IDs and versions', async () => {
    const opportunity = await createOpportunity();
    await request(app.getHttpServer())
      .patch('/api/v1/opportunities/not-a-uuid/stage')
      .set(workspaceHeader())
      .send({ targetStageId: secondStageId, expectedStageVersion: 1 })
      .expect(400);

    await request(app.getHttpServer())
      .patch(`/api/v1/opportunities/${opportunity.id}/stage`)
      .set(workspaceHeader())
      .send({ targetStageId: 'not-a-uuid', expectedStageVersion: 1 })
      .expect(400);

    await request(app.getHttpServer())
      .patch(`/api/v1/opportunities/${opportunity.id}/stage`)
      .set(workspaceHeader())
      .send({ targetStageId: secondStageId, expectedStageVersion: 1.5 })
      .expect(400);

    expect(await transitionCount(opportunity.id)).toBe(1);
  });

  it('treats a move to the current stage with the current version as a no-op', async () => {
    const opportunity = await createOpportunity();
    const response = await request(app.getHttpServer())
      .patch(`/api/v1/opportunities/${opportunity.id}/stage`)
      .set(workspaceHeader())
      .send({ targetStageId: stageId, expectedStageVersion: 1 })
      .expect(200);

    expect(response.body.stageId).toBe(stageId);
    expect(response.body.stageVersion).toBe(1);
    expect(await transitionCount(opportunity.id)).toBe(1);
  });

  it('rejects a stale version when targeting the current stage without changing state or history', async () => {
    const opportunity = await createOpportunity();
    await request(app.getHttpServer())
      .patch(`/api/v1/opportunities/${opportunity.id}/stage`)
      .set(workspaceHeader())
      .send({ targetStageId: secondStageId, expectedStageVersion: 1 })
      .expect(200);

    const transitionCountBeforeStaleRequest = await transitionCount(
      opportunity.id,
    );
    await request(app.getHttpServer())
      .patch(`/api/v1/opportunities/${opportunity.id}/stage`)
      .set(workspaceHeader())
      .send({ targetStageId: secondStageId, expectedStageVersion: 1 })
      .expect(409)
      .expect(({ body }) => expect(body.code).toBe('stage_version_conflict'));

    const unchanged = await prisma.opportunity.findFirstOrThrow({
      where: { workspaceId, id: opportunity.id },
    });
    expect(unchanged.stageId).toBe(secondStageId);
    expect(unchanged.stageVersion).toBe(2);
    expect(await transitionCount(opportunity.id)).toBe(
      transitionCountBeforeStaleRequest,
    );
  });

  it('allows only one concurrent transition using the same expected version', async () => {
    const opportunity = await createOpportunity();
    const results = await Promise.all([
      request(app.getHttpServer())
        .patch(`/api/v1/opportunities/${opportunity.id}/stage`)
        .set(workspaceHeader())
        .send({ targetStageId: secondStageId, expectedStageVersion: 1 }),
      request(app.getHttpServer())
        .patch(`/api/v1/opportunities/${opportunity.id}/stage`)
        .set(workspaceHeader())
        .send({ targetStageId: secondStageId, expectedStageVersion: 1 }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const saved = await prisma.opportunity.findFirstOrThrow({
      where: { workspaceId, id: opportunity.id },
    });
    expect(saved.stageId).toBe(secondStageId);
    expect(saved.stageVersion).toBe(2);
    expect(await transitionCount(opportunity.id)).toBe(2);
  });

  it('rolls back a stage update when transition insertion fails', async () => {
    const opportunity = await createOpportunity();
    const faultDatabase = new PrismaService();
    const failingPrisma = new Proxy(faultDatabase, {
      get(target, property, receiver) {
        if (property === '$transaction') {
          return (
            callback: (
              transaction: Prisma.TransactionClient,
            ) => Promise<unknown>,
          ) =>
            target.$transaction((transaction) => {
              const failingTransaction = new Proxy(transaction, {
                get(
                  transactionTarget,
                  transactionProperty,
                  transactionReceiver,
                ) {
                  if (transactionProperty === 'opportunityTransition') {
                    const delegate = Reflect.get(
                      transactionTarget,
                      transactionProperty,
                      transactionReceiver,
                    ) as object;
                    return new Proxy(delegate, {
                      get(delegateTarget, method, delegateReceiver) {
                        if (method === 'create') {
                          return () => {
                            throw new Error('Injected transition failure.');
                          };
                        }
                        return Reflect.get(
                          delegateTarget,
                          method,
                          delegateReceiver,
                        );
                      },
                    });
                  }
                  return Reflect.get(
                    transactionTarget,
                    transactionProperty,
                    transactionReceiver,
                  );
                },
              });
              return callback(failingTransaction as Prisma.TransactionClient);
            });
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
        .patch(`/api/v1/opportunities/${opportunity.id}/stage`)
        .set(workspaceHeader())
        .send({ targetStageId: secondStageId, expectedStageVersion: 1 })
        .expect(500)
        .expect(({ body }) => {
          expect(body.code).toBe('internal_error');
          expect(body.message).not.toContain('Injected');
        });
    } finally {
      await failingApp.close();
    }

    const unchanged = await prisma.opportunity.findFirstOrThrow({
      where: { workspaceId, id: opportunity.id },
    });
    expect(unchanged.stageId).toBe(stageId);
    expect(unchanged.stageVersion).toBe(1);
    expect(await transitionCount(opportunity.id)).toBe(1);
  });
});
