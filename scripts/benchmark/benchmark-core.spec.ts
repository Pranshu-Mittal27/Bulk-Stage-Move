import { describe, expect, it } from '@jest/globals';
import {
  ASSIGNMENT_SEED_WORKSPACES,
  opportunityForWorkspace,
  stagesForWorkspace,
} from '../assignment-seed-data.js';
import {
  calculatePersistedThroughput,
  isConsistentJobCounters,
  isTerminalJobStatus,
  matchedCountMismatch,
  parseBenchmarkArguments,
  percentile,
  restartProgressMeasurement,
  summarizeLatencies,
} from './benchmark-core.js';

describe('benchmark core', () => {
  it('uses nearest-rank percentiles and handles empty samples', () => {
    expect(percentile([50, 10, 30, 20, 40], 50)).toBe(30);
    expect(percentile([50, 10, 30, 20, 40], 95)).toBe(50);
    expect(percentile([], 99)).toBeNull();
    expect(() => percentile([1], 101)).toThrow('between 0 and 100');
  });

  it('reports latency errors separately from latency sample count', () => {
    expect(summarizeLatencies([10, 20, 30], 2, 1)).toEqual({
      requestCount: 3,
      errors: 3,
      httpErrors: 2,
      transportErrors: 1,
      p50Ms: 20,
      p95Ms: 30,
      p99Ms: 30,
    });
  });

  it('calculates throughput from persisted processed and moved counters', () => {
    expect(
      calculatePersistedThroughput(
        {
          matchedCount: 50_000,
          processedCount: 50_000,
          movedCount: 48_000,
          skippedCount: 1_500,
          failedCount: 500,
          pendingCount: 0,
        },
        2_000,
      ),
    ).toEqual({
      persistedWallClockElapsedMs: 2_000,
      processedItemsPerPersistedWallClockSecond: 25_000,
      movedOpportunitiesPerPersistedWallClockSecond: 24_000,
    });
    expect(
      calculatePersistedThroughput(
        {
          matchedCount: 1,
          processedCount: 1,
          movedCount: 1,
          skippedCount: 0,
          failedCount: 0,
          pendingCount: 0,
        },
        0,
      ).processedItemsPerPersistedWallClockSecond,
    ).toBeNull();
  });

  it('does not count progress when the job was complete at restart confirmation', () => {
    expect(
      restartProgressMeasurement(
        { status: 'completed', processedCount: 50_000 },
        { status: 'completed', processedCount: 50_000 },
        25,
      ),
    ).toEqual({ restartConfirmationToObservedProgressMs: null });
  });

  it('does not count a status change without persisted progress', () => {
    expect(
      restartProgressMeasurement(
        { status: 'queued', processedCount: 250 },
        { status: 'running', processedCount: 250 },
        25,
      ),
    ).toEqual({ restartConfirmationToObservedProgressMs: null });
  });

  it('reports the confirmation-to-progress duration after persisted progress increases', () => {
    expect(
      restartProgressMeasurement(
        { status: 'running', processedCount: 250 },
        { status: 'running', processedCount: 500 },
        125,
      ),
    ).toEqual({ restartConfirmationToObservedProgressMs: 125 });
  });

  it('includes job and workspace details when the accepted match count is wrong', () => {
    const mismatch = matchedCountMismatch(
      'job-123',
      'workspace-456',
      49_999,
      50_000,
    );
    expect(mismatch).toEqual({
      jobId: 'job-123',
      workspaceId: 'workspace-456',
      matchedCount: 49_999,
      expectedMatchedCount: 50_000,
      message:
        'Bulk job job-123 in workspace workspace-456 was already created ' +
        'with matchedCount 49999; expected exactly 50000. ' +
        'The job may continue running; no cancellation was attempted.',
    });
    expect(
      matchedCountMismatch('job-123', 'workspace-456', 50_000, 50_000),
    ).toBeNull();
  });

  it('checks persisted counter invariants and terminal states', () => {
    expect(
      isConsistentJobCounters({
        matchedCount: 5,
        processedCount: 3,
        movedCount: 2,
        skippedCount: 1,
        failedCount: 0,
        pendingCount: 2,
      }),
    ).toBe(true);
    expect(
      isConsistentJobCounters({
        matchedCount: 5,
        processedCount: 3,
        movedCount: 2,
        skippedCount: 0,
        failedCount: 0,
        pendingCount: 2,
      }),
    ).toBe(false);
    expect(isTerminalJobStatus('completed')).toBe(true);
    expect(isTerminalJobStatus('completed_with_errors')).toBe(true);
    expect(isTerminalJobStatus('running')).toBe(false);
  });

  it('accepts defaults but rejects non-assignment counts and unsafe URLs', () => {
    const parsed = parseBenchmarkArguments(['bulk'], {});
    expect(parsed.config.targetCount).toBe(50_000);
    expect(parsed.config.largeWorkspaceId).toBe(
      '10000000-0000-4000-8000-000000000001',
    );
    expect(() =>
      parseBenchmarkArguments(['bulk', '--target-count', '49999'], {}),
    ).toThrow('exactly 50000');
    expect(() =>
      parseBenchmarkArguments(
        ['baseline', '--base-url', 'https://user:password@example.test'],
        {},
      ),
    ).toThrow('credentials');
    expect(() =>
      parseBenchmarkArguments(['baseline', '--request-rate', '0'], {}),
    ).toThrow('between 1 and 1000');
  });

  it('requires source and destination stages to differ for bulk runs', () => {
    const stage = '20000000-0000-4000-8000-000000000065';
    expect(() =>
      parseBenchmarkArguments(
        ['bulk', '--source-stage-id', stage, '--target-stage-id', stage],
        {},
      ),
    ).toThrow('must be different');
  });

  it('selects exactly 50,000 seeded opportunities with the benchmark filter', () => {
    const workspace = ASSIGNMENT_SEED_WORKSPACES[0];
    if (!workspace) {
      throw new Error('Large workspace fixture is missing.');
    }
    const stages = stagesForWorkspace(1, workspace.opportunityCount);
    const firstStage = stages[0];
    if (!firstStage) {
      throw new Error('Large workspace first stage is missing.');
    }

    let matched = 0;
    for (let number = 1; number <= firstStage.opportunityCount; number += 1) {
      const opportunity = opportunityForWorkspace(workspace, number, stages);
      const value = Number(opportunity.value);
      if (
        opportunity.stageId === firstStage.id &&
        value >= 101 &&
        value <= 25_100
      ) {
        matched += 1;
      }
    }
    expect(matched).toBe(50_000);
  });
});
