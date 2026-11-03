import { describe, expect, it } from '@jest/globals';
import {
  ASSIGNMENT_SEED_DATE_END,
  ASSIGNMENT_SEED_DATE_START,
  ASSIGNMENT_SEED_STAGES,
  ASSIGNMENT_SMALL_SEED_WORKSPACES,
  ASSIGNMENT_SEED_WORKSPACES,
  opportunityForWorkspace,
  stageCountsForWorkspace,
  stagesForWorkspace,
  validateAssignmentSeedPlan,
} from './assignment-seed-data.js';

describe('assignment seed plan', () => {
  it('defines an independent, genuinely small setup seed mode', () => {
    expect(ASSIGNMENT_SMALL_SEED_WORKSPACES).toEqual([
      {
        ordinal: 7,
        name: 'Take-home setup: small test workspace',
        opportunityCount: 120,
      },
    ]);
  });
  it('defines one large and five small workspaces with twelve stages each', () => {
    expect(
      ASSIGNMENT_SEED_WORKSPACES.map((workspace) => workspace.opportunityCount),
    ).toEqual([500_000, 2_000, 2_500, 3_000, 3_500, 4_000]);
    expect(ASSIGNMENT_SEED_WORKSPACES).toHaveLength(6);
    for (const workspace of ASSIGNMENT_SEED_WORKSPACES) {
      expect(
        stagesForWorkspace(workspace.ordinal, workspace.opportunityCount),
      ).toHaveLength(12);
    }
    expect(ASSIGNMENT_SEED_STAGES).toHaveLength(12);
  });

  it('allocates exactly 500,000 large-workspace opportunities unevenly', () => {
    const counts = stageCountsForWorkspace(1, 500_000);

    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(500_000);
    expect(counts).toEqual([
      125_000, 90_000, 70_000, 55_000, 40_000, 35_000, 25_000, 20_000, 15_000,
      10_000, 10_000, 5_000,
    ]);
    expect(new Set(counts).size).toBeGreaterThan(1);
  });

  it('assigns generated opportunities to stages at the distribution boundaries', () => {
    const workspace = ASSIGNMENT_SEED_WORKSPACES[0];
    if (!workspace) {
      throw new Error('Large workspace fixture is missing.');
    }

    let stageEnd = 0;
    for (const [index, count] of stageCountsForWorkspace(
      1,
      500_000,
    ).entries()) {
      stageEnd += count;
      expect(opportunityForWorkspace(workspace, stageEnd).stageId).toBe(
        stagesForWorkspace(1, 500_000)[index]?.id,
      );
    }
  });

  it('spreads opportunity timestamps over the fixed 18-month window', () => {
    const largeWorkspace = ASSIGNMENT_SEED_WORKSPACES[0];
    if (!largeWorkspace) {
      throw new Error('Large workspace fixture is missing.');
    }

    expect(opportunityForWorkspace(largeWorkspace, 1).createdAt).toEqual(
      ASSIGNMENT_SEED_DATE_START,
    );
    expect(
      opportunityForWorkspace(largeWorkspace, largeWorkspace.opportunityCount)
        .createdAt,
    ).toEqual(ASSIGNMENT_SEED_DATE_END);
    expect(
      opportunityForWorkspace(largeWorkspace, 250_000).createdAt.getTime(),
    ).toBeGreaterThan(ASSIGNMENT_SEED_DATE_START.getTime());
    expect(
      opportunityForWorkspace(largeWorkspace, 250_000).createdAt.getTime(),
    ).toBeLessThan(ASSIGNMENT_SEED_DATE_END.getTime());
  });

  it('produces identical opportunity data for the same workspace and number', () => {
    const workspace = ASSIGNMENT_SEED_WORKSPACES[0];
    if (!workspace) {
      throw new Error('Large workspace fixture is missing.');
    }

    const first = opportunityForWorkspace(workspace, 123_456);
    const second = opportunityForWorkspace(workspace, 123_456);

    expect(first).toEqual(second);
  });

  it('validates the complete seed definition', () => {
    expect(() => validateAssignmentSeedPlan()).not.toThrow();
  });
});
