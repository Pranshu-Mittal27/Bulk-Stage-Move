export const ASSIGNMENT_SEED_DATABASE = 'ghl_bulk_stage_seed';
export const ASSIGNMENT_SEED_BATCH_SIZE = 1_000;
export const ASSIGNMENT_SEED_DATE_START = new Date('2025-05-01T00:00:00.000Z');
export const ASSIGNMENT_SEED_DATE_END = new Date('2026-11-01T00:00:00.000Z');

export const ASSIGNMENT_SEED_STAGES = [
  'New',
  'Qualified',
  'Discovery',
  'Evaluation',
  'Proposal',
  'Negotiation',
  'Contracting',
  'On Hold',
  'Nurture',
  'Closed Won',
  'Closed Lost',
  'Disqualified',
] as const;

export const ASSIGNMENT_SEED_STAGE_WEIGHTS = [
  25, 18, 14, 11, 8, 7, 5, 4, 3, 2, 2, 1,
] as const;

export interface AssignmentWorkspaceSeed {
  ordinal: number;
  name: string;
  opportunityCount: number;
}

export const ASSIGNMENT_SEED_WORKSPACES: readonly AssignmentWorkspaceSeed[] = [
  {
    ordinal: 1,
    name: 'Take-home seed: large workspace',
    opportunityCount: 500_000,
  },
  {
    ordinal: 2,
    name: 'Take-home seed: small workspace 1',
    opportunityCount: 2_000,
  },
  {
    ordinal: 3,
    name: 'Take-home seed: small workspace 2',
    opportunityCount: 2_500,
  },
  {
    ordinal: 4,
    name: 'Take-home seed: small workspace 3',
    opportunityCount: 3_000,
  },
  {
    ordinal: 5,
    name: 'Take-home seed: small workspace 4',
    opportunityCount: 3_500,
  },
  {
    ordinal: 6,
    name: 'Take-home seed: small workspace 5',
    opportunityCount: 4_000,
  },
];

export interface AssignmentSeedStage {
  id: string;
  name: string;
  position: number;
  opportunityCount: number;
}

export interface AssignmentSeedOpportunity {
  id: string;
  stageId: string;
  name: string;
  value: string;
  status: 'open';
  stageVersion: 1;
  createdAt: Date;
  updatedAt: Date;
}

function seedUuid(prefix: string, suffix: number): string {
  return `${prefix}-0000-4000-8000-${suffix.toString(16).padStart(12, '0')}`;
}

export function workspaceId(ordinal: number): string {
  return seedUuid('10000000', ordinal);
}

export function stageId(workspaceOrdinal: number, position: number): string {
  return seedUuid('20000000', workspaceOrdinal * 100 + position);
}

export function opportunityId(
  workspaceOrdinal: number,
  opportunityNumber: number,
): string {
  return seedUuid('30000000', workspaceOrdinal * 1_000_000 + opportunityNumber);
}

export function stageCountsForWorkspace(
  workspaceOrdinal: number,
  opportunityCount: number,
): number[] {
  if (workspaceOrdinal === 1) {
    let cumulativeWeight = 0;
    let previousCount = 0;

    return ASSIGNMENT_SEED_STAGE_WEIGHTS.map((weight) => {
      cumulativeWeight += weight;
      const cumulativeCount = Math.floor(
        (cumulativeWeight * opportunityCount) / 100,
      );
      const count = cumulativeCount - previousCount;
      previousCount = cumulativeCount;
      return count;
    });
  }

  const counts = ASSIGNMENT_SEED_STAGE_WEIGHTS.map(() =>
    Math.floor(opportunityCount / ASSIGNMENT_SEED_STAGE_WEIGHTS.length),
  );
  const remainder = opportunityCount % ASSIGNMENT_SEED_STAGE_WEIGHTS.length;
  for (let index = 0; index < remainder; index += 1) {
    counts[index] = (counts[index] ?? 0) + 1;
  }
  return counts;
}

export function stagesForWorkspace(
  workspaceOrdinal: number,
  opportunityCount: number,
): AssignmentSeedStage[] {
  const counts = stageCountsForWorkspace(workspaceOrdinal, opportunityCount);

  return ASSIGNMENT_SEED_STAGES.map((name, index) => ({
    id: stageId(workspaceOrdinal, index + 1),
    name,
    position: index + 1,
    opportunityCount: counts[index] ?? 0,
  }));
}

export function opportunityForWorkspace(
  workspace: AssignmentWorkspaceSeed,
  opportunityNumber: number,
  stages = stagesForWorkspace(workspace.ordinal, workspace.opportunityCount),
): AssignmentSeedOpportunity {
  let stageIndex = 0;
  let cumulativeCount = stages[0]?.opportunityCount ?? 0;

  while (
    opportunityNumber > cumulativeCount &&
    stageIndex < stages.length - 1
  ) {
    stageIndex += 1;
    cumulativeCount += stages[stageIndex]?.opportunityCount ?? 0;
  }

  const timeRange =
    ASSIGNMENT_SEED_DATE_END.getTime() - ASSIGNMENT_SEED_DATE_START.getTime();
  const createdAt = new Date(
    ASSIGNMENT_SEED_DATE_START.getTime() +
      Math.floor(
        ((opportunityNumber - 1) * timeRange) /
          Math.max(workspace.opportunityCount - 1, 1),
      ),
  );

  return {
    id: opportunityId(workspace.ordinal, opportunityNumber),
    stageId: stageId(workspace.ordinal, stageIndex + 1),
    name: `Seed opportunity ${workspace.ordinal}-${opportunityNumber}`,
    value: `${(100 + (opportunityNumber % 100_000)).toFixed(4)}`,
    status: 'open',
    stageVersion: 1,
    createdAt,
    updatedAt: createdAt,
  };
}

export function validateAssignmentSeedPlan(): void {
  if (
    ASSIGNMENT_SEED_STAGES.length !== 12 ||
    ASSIGNMENT_SEED_STAGE_WEIGHTS.length !== ASSIGNMENT_SEED_STAGES.length ||
    ASSIGNMENT_SEED_STAGE_WEIGHTS.reduce((sum, weight) => sum + weight, 0) !==
      100
  ) {
    throw new Error('The assignment seed must define 12 stages totaling 100%.');
  }

  if (
    ASSIGNMENT_SEED_WORKSPACES.length !== 6 ||
    ASSIGNMENT_SEED_WORKSPACES[0]?.opportunityCount !== 500_000 ||
    ASSIGNMENT_SEED_WORKSPACES.slice(1).some(
      ({ opportunityCount }) =>
        opportunityCount < 1_000 || opportunityCount > 5_000,
    )
  ) {
    throw new Error(
      'The assignment seed must define one 500,000-opportunity workspace and five small workspaces.',
    );
  }

  for (const workspace of ASSIGNMENT_SEED_WORKSPACES) {
    const stages = stagesForWorkspace(
      workspace.ordinal,
      workspace.opportunityCount,
    );
    if (
      stages.length !== 12 ||
      stages.reduce((sum, stage) => sum + stage.opportunityCount, 0) !==
        workspace.opportunityCount ||
      stages.some((stage) => stage.opportunityCount <= 0)
    ) {
      throw new Error(
        `Invalid stage distribution for workspace ${workspace.ordinal}.`,
      );
    }
  }

  const largeWorkspace = ASSIGNMENT_SEED_WORKSPACES[0];
  if (!largeWorkspace) {
    throw new Error('The large assignment workspace is missing.');
  }
  const largeStageCounts = stageCountsForWorkspace(
    largeWorkspace.ordinal,
    largeWorkspace.opportunityCount,
  );
  if (new Set(largeStageCounts).size < 2) {
    throw new Error('The large workspace stage distribution must be uneven.');
  }

  const firstOpportunity = opportunityForWorkspace(largeWorkspace, 1);
  const lastOpportunity = opportunityForWorkspace(
    largeWorkspace,
    largeWorkspace.opportunityCount,
  );
  if (
    firstOpportunity.createdAt.getTime() !==
      ASSIGNMENT_SEED_DATE_START.getTime() ||
    lastOpportunity.createdAt.getTime() !== ASSIGNMENT_SEED_DATE_END.getTime()
  ) {
    throw new Error('The assignment seed date range is invalid.');
  }
}
