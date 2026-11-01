import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import {
  ASSIGNMENT_SEED_BATCH_SIZE,
  ASSIGNMENT_SEED_DATE_END,
  ASSIGNMENT_SEED_DATE_START,
  ASSIGNMENT_SEED_WORKSPACES,
  opportunityForWorkspace,
  stagesForWorkspace,
  validateAssignmentSeedPlan,
  workspaceId,
} from './assignment-seed-data.js';
import {
  assertDatabaseUrlMatchesConfirmation,
  parseConfirmedDatabaseName,
  runSeedWritesAfterDatabaseNameCheck,
} from './assignment-seed-safety.js';

function getDatabaseConnectionString(confirmedDatabaseName: string): string {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not configured.');
  }

  assertDatabaseUrlMatchesConfirmation(connectionString, confirmedDatabaseName);
  return connectionString;
}

async function seedAssignment(): Promise<void> {
  const confirmedDatabaseName = parseConfirmedDatabaseName(
    process.argv.slice(2),
  );
  const connectionString = getDatabaseConnectionString(confirmedDatabaseName);
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });

  try {
    const databaseRows = await prisma.$queryRaw<{ databaseName: string }[]>`
      SELECT current_database() AS "databaseName"
    `;
    await runSeedWritesAfterDatabaseNameCheck(
      databaseRows[0]?.databaseName,
      confirmedDatabaseName,
      async () => {
        for (const workspace of ASSIGNMENT_SEED_WORKSPACES) {
          const expectedWorkspaceId = workspaceId(workspace.ordinal);
          const existingWorkspace = await prisma.workspace.findUnique({
            where: { id: expectedWorkspaceId },
          });

          if (existingWorkspace && existingWorkspace.name !== workspace.name) {
            throw new Error(
              `Seed workspace ID ${expectedWorkspaceId} is already used by a different workspace.`,
            );
          }

          await prisma.workspace.createMany({
            data: [{ id: expectedWorkspaceId, name: workspace.name }],
            skipDuplicates: true,
          });

          const stageRows = stagesForWorkspace(
            workspace.ordinal,
            workspace.opportunityCount,
          );
          await prisma.stage.createMany({
            data: stageRows.map(({ id, name, position }) => ({
              id,
              workspaceId: expectedWorkspaceId,
              name,
              position,
            })),
            skipDuplicates: true,
          });

          const existingStages = await prisma.stage.findMany({
            where: { workspaceId: expectedWorkspaceId },
            select: { id: true, name: true, position: true },
          });
          if (
            existingStages.length !== stageRows.length ||
            stageRows.some((expected) => {
              const existing = existingStages.find(
                (stage) => stage.position === expected.position,
              );
              return (
                !existing ||
                existing.id !== expected.id ||
                existing.name !== expected.name
              );
            })
          ) {
            throw new Error(
              `Workspace ${expectedWorkspaceId} contains unexpected stages; no existing data was deleted.`,
            );
          }

          const existingOpportunityCount = await prisma.opportunity.count({
            where: { workspaceId: expectedWorkspaceId },
          });
          if (existingOpportunityCount > workspace.opportunityCount) {
            throw new Error(
              `Workspace ${expectedWorkspaceId} already has more opportunities than this seed defines; no existing data was deleted.`,
            );
          }

          const opportunityStages = stagesForWorkspace(
            workspace.ordinal,
            workspace.opportunityCount,
          );
          for (
            let batchStart = 1;
            batchStart <= workspace.opportunityCount;
            batchStart += ASSIGNMENT_SEED_BATCH_SIZE
          ) {
            const batchEnd = Math.min(
              batchStart + ASSIGNMENT_SEED_BATCH_SIZE - 1,
              workspace.opportunityCount,
            );
            const data = [];
            for (
              let opportunityNumber = batchStart;
              opportunityNumber <= batchEnd;
              opportunityNumber += 1
            ) {
              const opportunity = opportunityForWorkspace(
                workspace,
                opportunityNumber,
                opportunityStages,
              );
              data.push({
                ...opportunity,
                workspaceId: expectedWorkspaceId,
              });
            }

            await prisma.opportunity.createMany({
              data,
              skipDuplicates: true,
            });
          }

          const finalOpportunityCount = await prisma.opportunity.count({
            where: { workspaceId: expectedWorkspaceId },
          });
          if (finalOpportunityCount !== workspace.opportunityCount) {
            throw new Error(
              `Workspace ${expectedWorkspaceId} has ${finalOpportunityCount} opportunities; expected ${workspace.opportunityCount}.`,
            );
          }

          const actualStageCounts = await prisma.opportunity.groupBy({
            by: ['stageId'],
            where: { workspaceId: expectedWorkspaceId },
            _count: { _all: true },
          });
          const actualCountsByStage = new Map(
            actualStageCounts.map(({ stageId: id, _count }) => [
              id,
              _count._all,
            ]),
          );
          if (
            actualStageCounts.length !== stageRows.length ||
            stageRows.some(
              (stage) =>
                actualCountsByStage.get(stage.id) !== stage.opportunityCount,
            )
          ) {
            throw new Error(
              `Workspace ${expectedWorkspaceId} does not match the expected stage distribution.`,
            );
          }

          const dateBounds = await prisma.opportunity.aggregate({
            where: { workspaceId: expectedWorkspaceId },
            _min: { createdAt: true },
            _max: { createdAt: true },
          });
          if (
            dateBounds._min.createdAt?.getTime() !==
              ASSIGNMENT_SEED_DATE_START.getTime() ||
            dateBounds._max.createdAt?.getTime() !==
              ASSIGNMENT_SEED_DATE_END.getTime()
          ) {
            throw new Error(
              `Workspace ${expectedWorkspaceId} does not span the expected creation-date range.`,
            );
          }

          console.log(
            `Verified ${workspace.name}: ${stageRows.length} stages, ${finalOpportunityCount} opportunities; stage counts ${stageRows.map((stage) => actualCountsByStage.get(stage.id)).join(', ')}.`,
          );
        }
      },
    );

    console.log(
      `Assignment seed completed in database ${confirmedDatabaseName}.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

try {
  validateAssignmentSeedPlan();
  await seedAssignment();
} catch (error) {
  const errorType = error instanceof Error ? error.name : 'UnknownError';
  console.error(
    `Assignment seed failed (${errorType}). No database credentials were printed.`,
  );
  process.exitCode = 1;
}
