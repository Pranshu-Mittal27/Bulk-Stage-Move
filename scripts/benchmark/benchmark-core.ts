import {
  stageId as seededStageId,
  workspaceId as seededWorkspaceId,
} from '../assignment-seed-data.js';

export type BenchmarkScenario =
  'baseline' | 'bulk' | 'crash-start' | 'crash-resume';

export interface BenchmarkConfig {
  scenario: BenchmarkScenario;
  confirmBenchmark: boolean;
  baseUrl: string;
  largeWorkspaceId: string;
  largeStageId: string;
  smallWorkspaceId: string;
  smallStageId: string;
  sourceStageId: string;
  targetStageId: string;
  targetCount: number;
  requestRate: number;
  concurrency: number;
  durationMs: number;
  pollIntervalMs: number;
  timeoutMs: number;
  outputPath: string;
  checkpointPath: string;
}

export interface ParsedArguments {
  config: BenchmarkConfig;
  help: boolean;
}

export interface JobCounters {
  matchedCount: number;
  processedCount: number;
  movedCount: number;
  skippedCount: number;
  failedCount: number;
  pendingCount: number;
}

export interface RecoveryProgressSnapshot {
  status: string;
  processedCount: number;
}

export interface MatchedCountMismatch {
  jobId: string;
  workspaceId: string;
  matchedCount: number;
  expectedMatchedCount: number;
  message: string;
}

export interface LatencySummary {
  requestCount: number;
  errors: number;
  httpErrors: number;
  transportErrors: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const allowedOptions = new Set([
  'confirm-benchmark',
  'base-url',
  'large-workspace-id',
  'large-stage-id',
  'small-workspace-id',
  'small-stage-id',
  'source-stage-id',
  'target-stage-id',
  'target-count',
  'request-rate',
  'concurrency',
  'duration-seconds',
  'poll-interval-ms',
  'timeout-seconds',
  'output',
  'checkpoint',
]);

function parseInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(`--${name} must be a whole number.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`--${name} must be between ${min} and ${max}.`);
  }
  return parsed;
}

function parseUuid(name: string, value: string): string {
  if (!uuidPattern.test(value)) {
    throw new Error(`--${name} must be a UUID.`);
  }
  return value.toLowerCase();
}

function parseBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('--base-url must be a valid HTTP or HTTPS URL.');
  }

  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new Error(
      '--base-url must contain only an HTTP(S) origin; credentials, paths, query strings, and fragments are not allowed.',
    );
  }
  return url.origin;
}

export function parseBenchmarkArguments(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
): ParsedArguments {
  const [scenarioValue, ...optionArgs] = args;
  const help = scenarioValue === '--help' || scenarioValue === '-h';
  const scenarios: BenchmarkScenario[] = [
    'baseline',
    'bulk',
    'crash-start',
    'crash-resume',
  ];

  if (help) {
    return { config: defaultConfig('baseline', environment), help: true };
  }
  if (
    !scenarioValue ||
    !scenarios.includes(scenarioValue as BenchmarkScenario)
  ) {
    throw new Error(
      'Choose a scenario: baseline, bulk, crash-start, or crash-resume.',
    );
  }

  const values = new Map<string, string>();
  let confirmBenchmark = false;
  for (let index = 0; index < optionArgs.length; index += 1) {
    const option = optionArgs[index];
    if (option === '--confirm-benchmark') {
      if (confirmBenchmark) {
        throw new Error(
          'Option --confirm-benchmark was provided more than once.',
        );
      }
      confirmBenchmark = true;
      continue;
    }
    const value = optionArgs[index + 1];
    if (!option?.startsWith('--') || option.length < 3 || !value) {
      throw new Error('Options must be provided as --name value pairs.');
    }
    const name = option.slice(2);
    if (!allowedOptions.has(name)) {
      throw new Error(`Unknown option --${name}.`);
    }
    if (values.has(name)) {
      throw new Error(`Option --${name} was provided more than once.`);
    }
    values.set(name, value);
    index += 1;
  }

  const config = defaultConfig(scenarioValue as BenchmarkScenario, environment);
  config.confirmBenchmark = confirmBenchmark;
  const read = (name: string, envName: string, fallback: string): string =>
    values.get(name) ?? environment[envName] ?? fallback;

  config.baseUrl = parseBaseUrl(
    read('base-url', 'BENCHMARK_BASE_URL', config.baseUrl),
  );
  config.largeWorkspaceId = parseUuid(
    'large-workspace-id',
    read(
      'large-workspace-id',
      'BENCHMARK_LARGE_WORKSPACE_ID',
      config.largeWorkspaceId,
    ),
  );
  config.largeStageId = parseUuid(
    'large-stage-id',
    read('large-stage-id', 'BENCHMARK_LARGE_STAGE_ID', config.largeStageId),
  );
  config.smallWorkspaceId = parseUuid(
    'small-workspace-id',
    read(
      'small-workspace-id',
      'BENCHMARK_SMALL_WORKSPACE_ID',
      config.smallWorkspaceId,
    ),
  );
  config.smallStageId = parseUuid(
    'small-stage-id',
    read('small-stage-id', 'BENCHMARK_SMALL_STAGE_ID', config.smallStageId),
  );
  config.sourceStageId = parseUuid(
    'source-stage-id',
    read(
      'source-stage-id',
      'BENCHMARK_SOURCE_STAGE_ID',
      values.get('large-stage-id') ??
        environment.BENCHMARK_LARGE_STAGE_ID ??
        config.sourceStageId,
    ),
  );
  config.targetStageId = parseUuid(
    'target-stage-id',
    read('target-stage-id', 'BENCHMARK_TARGET_STAGE_ID', config.targetStageId),
  );
  config.targetCount = parseInteger(
    'target-count',
    values.get('target-count') ?? environment.BENCHMARK_TARGET_COUNT,
    config.targetCount,
    1,
    50_000,
  );
  if (config.targetCount !== 50_000) {
    throw new Error(
      '--target-count must be exactly 50000 for the assignment bulk benchmark.',
    );
  }
  config.requestRate = parseInteger(
    'request-rate',
    values.get('request-rate') ?? environment.BENCHMARK_REQUEST_RATE,
    config.requestRate,
    1,
    1_000,
  );
  config.concurrency = parseInteger(
    'concurrency',
    values.get('concurrency') ?? environment.BENCHMARK_CONCURRENCY,
    config.concurrency,
    1,
    100,
  );
  config.durationMs =
    parseInteger(
      'duration-seconds',
      values.get('duration-seconds') ?? environment.BENCHMARK_DURATION_SECONDS,
      config.durationMs / 1_000,
      1,
      86_400,
    ) * 1_000;
  config.pollIntervalMs = parseInteger(
    'poll-interval-ms',
    values.get('poll-interval-ms') ?? environment.BENCHMARK_POLL_INTERVAL_MS,
    config.pollIntervalMs,
    100,
    60_000,
  );
  config.timeoutMs =
    parseInteger(
      'timeout-seconds',
      values.get('timeout-seconds') ?? environment.BENCHMARK_TIMEOUT_SECONDS,
      config.timeoutMs / 1_000,
      1,
      86_400,
    ) * 1_000;
  config.outputPath =
    values.get('output') ?? environment.BENCHMARK_OUTPUT ?? config.outputPath;
  config.checkpointPath =
    values.get('checkpoint') ??
    environment.BENCHMARK_CHECKPOINT ??
    config.checkpointPath;

  if (config.scenario === 'bulk' || config.scenario === 'crash-start') {
    if (!config.confirmBenchmark) {
      throw new Error(
        `The ${config.scenario} scenario submits a real bulk job and can modify 50,000 opportunities. Rerun with --confirm-benchmark to confirm benchmark execution.`,
      );
    }
    if (config.sourceStageId === config.targetStageId) {
      throw new Error('The source stage and target stage must be different.');
    }
  }

  return { config, help: false };
}

function defaultConfig(
  scenario: BenchmarkScenario,
  environment: NodeJS.ProcessEnv,
): BenchmarkConfig {
  return {
    scenario,
    confirmBenchmark: false,
    baseUrl: environment.BENCHMARK_BASE_URL ?? 'http://127.0.0.1:3000',
    largeWorkspaceId:
      environment.BENCHMARK_LARGE_WORKSPACE_ID ?? seededWorkspaceId(1),
    largeStageId: environment.BENCHMARK_LARGE_STAGE_ID ?? seededStageId(1, 1),
    smallWorkspaceId:
      environment.BENCHMARK_SMALL_WORKSPACE_ID ?? seededWorkspaceId(2),
    smallStageId: environment.BENCHMARK_SMALL_STAGE_ID ?? seededStageId(2, 1),
    sourceStageId:
      environment.BENCHMARK_SOURCE_STAGE_ID ??
      environment.BENCHMARK_LARGE_STAGE_ID ??
      seededStageId(1, 1),
    targetStageId: environment.BENCHMARK_TARGET_STAGE_ID ?? seededStageId(1, 2),
    targetCount: 50_000,
    requestRate: 2,
    concurrency: 1,
    durationMs: 60_000,
    pollIntervalMs: 1_000,
    timeoutMs: 3_600_000,
    outputPath: '',
    checkpointPath: 'benchmarks/crash-recovery-checkpoint.json',
  };
}

export function percentile(
  values: number[],
  percentage: number,
): number | null {
  if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
    throw new Error('Percentile must be between 0 and 100.');
  }
  if (values.length === 0) {
    return null;
  }
  const ordered = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil((percentage / 100) * ordered.length));
  return ordered[rank - 1] ?? null;
}

export function summarizeLatencies(
  latenciesMs: number[],
  httpErrors: number,
  transportErrors: number,
): LatencySummary {
  return {
    requestCount: latenciesMs.length,
    errors: httpErrors + transportErrors,
    httpErrors,
    transportErrors,
    p50Ms: percentile(latenciesMs, 50),
    p95Ms: percentile(latenciesMs, 95),
    p99Ms: percentile(latenciesMs, 99),
  };
}

export function calculatePersistedThroughput(
  counters: JobCounters,
  persistedWallClockElapsedMs: number,
): {
  persistedWallClockElapsedMs: number;
  processedItemsPerPersistedWallClockSecond: number | null;
  movedOpportunitiesPerPersistedWallClockSecond: number | null;
} {
  if (
    !Number.isFinite(persistedWallClockElapsedMs) ||
    persistedWallClockElapsedMs <= 0 ||
    !isConsistentJobCounters(counters)
  ) {
    return {
      persistedWallClockElapsedMs,
      processedItemsPerPersistedWallClockSecond: null,
      movedOpportunitiesPerPersistedWallClockSecond: null,
    };
  }
  const seconds = persistedWallClockElapsedMs / 1_000;
  return {
    persistedWallClockElapsedMs,
    processedItemsPerPersistedWallClockSecond:
      counters.processedCount / seconds,
    movedOpportunitiesPerPersistedWallClockSecond:
      counters.movedCount / seconds,
  };
}

export function restartProgressMeasurement(
  baseline: RecoveryProgressSnapshot,
  observed: RecoveryProgressSnapshot,
  elapsedMs: number,
): { restartConfirmationToObservedProgressMs: number | null } {
  if (
    isTerminalJobStatus(baseline.status) ||
    observed.processedCount <= baseline.processedCount ||
    !Number.isFinite(elapsedMs) ||
    elapsedMs < 0
  ) {
    return { restartConfirmationToObservedProgressMs: null };
  }
  return { restartConfirmationToObservedProgressMs: elapsedMs };
}

export function matchedCountMismatch(
  jobId: string,
  workspaceId: string,
  matchedCount: number,
  expectedMatchedCount: number,
): MatchedCountMismatch | null {
  if (matchedCount === expectedMatchedCount) {
    return null;
  }
  return {
    jobId,
    workspaceId,
    matchedCount,
    expectedMatchedCount,
    message:
      `Bulk job ${jobId} in workspace ${workspaceId} was already created ` +
      `with matchedCount ${matchedCount}; expected exactly ${expectedMatchedCount}. ` +
      'The job may continue running; no cancellation was attempted.',
  };
}

export function isTerminalJobStatus(status: string): boolean {
  return (
    status === 'completed' ||
    status === 'completed_with_errors' ||
    status === 'failed'
  );
}

export function isConsistentJobCounters(counters: JobCounters): boolean {
  return (
    counters.matchedCount >= 0 &&
    counters.processedCount >= 0 &&
    counters.processedCount <= counters.matchedCount &&
    counters.movedCount >= 0 &&
    counters.skippedCount >= 0 &&
    counters.failedCount >= 0 &&
    counters.pendingCount >= 0 &&
    counters.processedCount ===
      counters.movedCount + counters.skippedCount + counters.failedCount &&
    counters.pendingCount === counters.matchedCount - counters.processedCount
  );
}
