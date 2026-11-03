import 'dotenv/config';
import { cpus, arch, platform, release } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { randomUUID } from 'node:crypto';
import { stdin, stdout } from 'node:process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  calculatePersistedThroughput,
  isConsistentJobCounters,
  isTerminalJobStatus,
  matchedCountMismatch,
  parseBenchmarkArguments,
  restartProgressMeasurement,
  summarizeLatencies,
  type BenchmarkConfig,
  type BenchmarkScenario,
  type JobCounters,
  type LatencySummary,
  type MatchedCountMismatch,
} from './benchmark/benchmark-core.js';

const requestTimeoutMs = 10_000;
const expectedMatchedCount = 50_000;
interface JobResponse extends JobCounters {
  id: string;
  status: string;
  targetStageId: string;
  startedAt: string | null;
  completedAt: string | null;
}

interface LatencyMeasurements {
  latencyMs: number[];
  httpErrors: number;
  transportErrors: number;
}

interface CrashCheckpoint {
  version: 1;
  jobId: string;
  workspaceId: string;
  submittedAt: string;
  submissionLatencyMs: number;
  matchedCount: number;
  progressObservedBeforeStop: JobCounters;
  progressAtStop: JobCounters;
  progressFirstObservedAt: string;
  workerStopConfirmedAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return 'Unknown failure.';
}

function environmentMetadata(): Record<string, unknown> {
  const cpu = cpus()[0];
  return {
    platform: platform(),
    platformRelease: release(),
    architecture: arch(),
    nodeVersion: process.version,
    cpuModel: cpu?.model ?? 'unavailable',
    logicalCpuCount: cpus().length,
  };
}

function outputPath(
  config: BenchmarkConfig,
  scenario: BenchmarkScenario,
): string {
  const suffix = new Date().toISOString().replaceAll(':', '-');
  return resolve(config.outputPath || `benchmarks/${scenario}-${suffix}.json`);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function buildUrl(baseUrl: string, path: string): URL {
  return new URL(path, `${baseUrl}/`);
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const body = await response.text();
  if (!body) {
    return null;
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

function safeResponseCode(body: unknown): string | undefined {
  if (
    typeof body === 'object' &&
    body !== null &&
    'code' in body &&
    typeof body.code === 'string' &&
    /^[a-z0-9_-]{1,64}$/i.test(body.code)
  ) {
    return body.code;
  }
  return undefined;
}

async function apiRequest(
  baseUrl: string,
  path: string,
  workspaceId: string,
  options: {
    method?: string;
    idempotencyKey?: string;
    body?: unknown;
    timeoutMs?: number;
  } = {},
): Promise<{ status: number; body: unknown; elapsedMs: number }> {
  const startedAt = performance.now();
  const headers: Record<string, string> = {
    'X-Workspace-Id': workspaceId,
    Accept: 'application/json',
  };
  if (options.idempotencyKey) {
    headers['Idempotency-Key'] = options.idempotencyKey;
  }
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  let response: Response;
  try {
    response = await fetch(buildUrl(baseUrl, path), {
      method: options.method ?? 'GET',
      headers,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs ?? requestTimeoutMs),
    });
  } catch (error) {
    const kind =
      error instanceof Error && error.name === 'TimeoutError'
        ? 'timed out'
        : 'transport failed';
    throw new Error(`API request ${kind}; no response was received.`, {
      cause: error,
    });
  }
  const body = await readJsonResponse(response);
  return {
    status: response.status,
    body,
    elapsedMs: performance.now() - startedAt,
  };
}

function assertJobResponse(body: unknown): JobResponse {
  if (typeof body !== 'object' || body === null) {
    throw new Error('API returned an invalid bulk-job response.');
  }
  const value = body as Record<string, unknown>;
  const countFields = [
    'matchedCount',
    'processedCount',
    'movedCount',
    'skippedCount',
    'failedCount',
    'pendingCount',
  ] as const;
  if (
    typeof value.id !== 'string' ||
    typeof value.status !== 'string' ||
    typeof value.targetStageId !== 'string' ||
    countFields.some(
      (field) =>
        !Number.isSafeInteger(value[field]) || (value[field] as number) < 0,
    ) ||
    (value.startedAt !== null && typeof value.startedAt !== 'string') ||
    (value.completedAt !== null && typeof value.completedAt !== 'string')
  ) {
    throw new Error('API returned an invalid bulk-job response shape.');
  }
  return value as unknown as JobResponse;
}

function requireSuccessfulResponse(
  response: { status: number; body: unknown },
  operation: string,
  acceptedStatuses: number[],
): void {
  if (!acceptedStatuses.includes(response.status)) {
    const code = safeResponseCode(response.body);
    throw new Error(
      `${operation} returned HTTP ${response.status}${code ? ` (${code})` : ''}.`,
    );
  }
}

function toCounters(job: JobResponse): JobCounters {
  return {
    matchedCount: job.matchedCount,
    processedCount: job.processedCount,
    movedCount: job.movedCount,
    skippedCount: job.skippedCount,
    failedCount: job.failedCount,
    pendingCount: job.pendingCount,
  };
}

async function getJob(
  baseUrl: string,
  workspaceId: string,
  jobId: string,
  timeoutMs = requestTimeoutMs,
): Promise<JobResponse> {
  const response = await apiRequest(
    baseUrl,
    `/api/v1/bulk-stage-moves/${encodeURIComponent(jobId)}`,
    workspaceId,
    { timeoutMs },
  );
  requireSuccessfulResponse(response, 'Job status request', [200]);
  return assertJobResponse(response.body);
}

async function submitBulkJob(
  config: BenchmarkConfig,
  workspaceId: string,
): Promise<{
  job: JobResponse;
  submissionLatencyMs: number;
  submittedAt: string;
}> {
  const key = `benchmark-${Date.now()}-${randomUUID()}`;
  const submittedAt = nowIso();
  const response = await apiRequest(
    config.baseUrl,
    '/api/v1/bulk-stage-moves',
    workspaceId,
    {
      method: 'POST',
      idempotencyKey: key,
      body: {
        targetStageId: config.targetStageId,
        filter: {
          stageId: config.sourceStageId,
          valueRange: { min: '101.0000', max: '25100.0000' },
        },
      },
    },
  );
  requireSuccessfulResponse(response, 'Bulk-job submission', [202]);
  const job = assertJobResponse(response.body);
  if (job.targetStageId.toLowerCase() !== config.targetStageId.toLowerCase()) {
    throw new Error('Submitted job reports an unexpected target stage.');
  }
  return {
    job,
    submissionLatencyMs: response.elapsedMs,
    submittedAt,
  };
}

function exactMatchCountMismatch(
  job: JobResponse,
  workspaceId: string,
): MatchedCountMismatch | null {
  return matchedCountMismatch(
    job.id,
    workspaceId,
    job.matchedCount,
    expectedMatchedCount,
  );
}

async function interactiveRequest(
  baseUrl: string,
  workspaceId: string,
  stageId: string,
): Promise<{ elapsedMs: number; error: 'http' | 'transport' | null }> {
  const url = buildUrl(
    baseUrl,
    `/api/v1/opportunities?stageId=${encodeURIComponent(stageId)}&limit=1`,
  );
  const startedAt = performance.now();
  try {
    const response = await fetch(url, {
      headers: {
        'X-Workspace-Id': workspaceId,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    await response.arrayBuffer();
    return {
      elapsedMs: performance.now() - startedAt,
      error: response.ok ? null : 'http',
    };
  } catch {
    return {
      elapsedMs: performance.now() - startedAt,
      error: 'transport',
    };
  }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolveWait) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolveWait();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

async function runLatencyStream(
  config: BenchmarkConfig,
  workspaceId: string,
  stageId: string,
  signal: AbortSignal,
): Promise<LatencyMeasurements> {
  const result: LatencyMeasurements = {
    latencyMs: [],
    httpErrors: 0,
    transportErrors: 0,
  };
  const active = new Set<Promise<void>>();
  const intervalMs = 1_000 / config.requestRate;
  let nextRequestAt = performance.now();

  while (!signal.aborted) {
    const now = performance.now();
    if (now < nextRequestAt) {
      await wait(nextRequestAt - now, signal);
      continue;
    }
    if (active.size >= config.concurrency) {
      await Promise.race(active);
      continue;
    }

    nextRequestAt += intervalMs;
    if (nextRequestAt < now) {
      nextRequestAt = now + intervalMs;
    }
    const request = interactiveRequest(config.baseUrl, workspaceId, stageId)
      .then(({ elapsedMs, error }) => {
        result.latencyMs.push(elapsedMs);
        if (error === 'http') {
          result.httpErrors += 1;
        } else if (error === 'transport') {
          result.transportErrors += 1;
        }
      })
      .finally(() => active.delete(request));
    active.add(request);
  }

  await Promise.all(active);
  return result;
}

function startLatencyMeasurements(config: BenchmarkConfig): {
  stop: () => number;
  result: Promise<{
    largeWorkspace: LatencySummary;
    smallWorkspace: LatencySummary;
  }>;
} {
  const controller = new AbortController();
  const startedMonotonic = performance.now();
  let stoppedElapsedMs: number | undefined;
  const result = Promise.all([
    runLatencyStream(
      config,
      config.largeWorkspaceId,
      config.largeStageId,
      controller.signal,
    ),
    runLatencyStream(
      config,
      config.smallWorkspaceId,
      config.smallStageId,
      controller.signal,
    ),
  ]).then(([large, small]) => ({
    largeWorkspace: summarizeLatencies(
      large.latencyMs,
      large.httpErrors,
      large.transportErrors,
    ),
    smallWorkspace: summarizeLatencies(
      small.latencyMs,
      small.httpErrors,
      small.transportErrors,
    ),
  }));
  return {
    stop: () => {
      controller.abort();
      stoppedElapsedMs ??= performance.now() - startedMonotonic;
      return stoppedElapsedMs;
    },
    result,
  };
}

async function waitForTerminalJob(
  config: BenchmarkConfig,
  workspaceId: string,
  jobId: string,
  onJob?: (job: JobResponse) => void,
): Promise<JobResponse> {
  const deadline = performance.now() + config.timeoutMs;
  let latest: JobResponse | undefined;
  while (performance.now() < deadline) {
    const remainingMs = deadline - performance.now();
    latest = await getJob(
      config.baseUrl,
      workspaceId,
      jobId,
      Math.max(1, Math.min(requestTimeoutMs, remainingMs)),
    );
    onJob?.(latest);
    if (isTerminalJobStatus(latest.status)) {
      return latest;
    }
    await new Promise((resolveWait) =>
      setTimeout(
        resolveWait,
        Math.min(
          config.pollIntervalMs,
          Math.max(0, deadline - performance.now()),
        ),
      ),
    );
  }
  throw new Error(
    `Timed out after ${config.timeoutMs} ms waiting for job ${jobId}; last persisted progress was ${latest?.processedCount ?? 0}/${latest?.matchedCount ?? expectedMatchedCount}.`,
  );
}

function failureForJob(job: JobResponse): string | undefined {
  if (job.status !== 'completed') {
    return `Job reached terminal status "${job.status}".`;
  }
  if (
    job.matchedCount !== expectedMatchedCount ||
    job.processedCount !== job.matchedCount ||
    job.pendingCount !== 0 ||
    job.failedCount !== 0 ||
    !isConsistentJobCounters(toCounters(job))
  ) {
    return 'Completed job counters do not show 50,000 fully processed outcomes without failures.';
  }
  return undefined;
}

function persistedWallClockElapsedMs(job: JobResponse): number | null {
  if (!job.startedAt || !job.completedAt) {
    return null;
  }
  const elapsed = Date.parse(job.completedAt) - Date.parse(job.startedAt);
  return Number.isFinite(elapsed) && elapsed > 0 ? elapsed : null;
}

function summarizeJob(job: JobResponse): Record<string, unknown> {
  const elapsed = persistedWallClockElapsedMs(job);
  return {
    id: job.id,
    status: job.status,
    targetStageId: job.targetStageId,
    counters: toCounters(job),
    workerStartedAt: job.startedAt,
    workerCompletedAt: job.completedAt,
    persistedWallClockElapsedMs: elapsed,
    throughput:
      elapsed === null
        ? null
        : calculatePersistedThroughput(toCounters(job), elapsed),
  };
}

async function runBaseline(
  config: BenchmarkConfig,
): Promise<Record<string, unknown>> {
  const startedAt = nowIso();
  const load = startLatencyMeasurements(config);
  await new Promise((resolveWait) =>
    setTimeout(resolveWait, config.durationMs),
  );
  const measurementElapsedMs = load.stop();
  const completedAt = nowIso();
  const latency = await load.result;
  const hasRequests =
    latency.largeWorkspace.requestCount > 0 &&
    latency.smallWorkspace.requestCount > 0;
  const hasErrors =
    latency.largeWorkspace.errors > 0 || latency.smallWorkspace.errors > 0;
  return {
    scenario: 'baseline',
    success: hasRequests && !hasErrors,
    startedAt,
    completedAt,
    elapsedMs: measurementElapsedMs,
    interactiveMeasurementDurationMs: measurementElapsedMs,
    workload: workloadSummary(config),
    interactiveLatency: latency,
    failure: !hasRequests
      ? 'No interactive requests completed for one or both workspaces.'
      : hasErrors
        ? 'Interactive requests reported HTTP or transport errors.'
        : null,
  };
}

async function runBulk(
  config: BenchmarkConfig,
): Promise<Record<string, unknown>> {
  const load = startLatencyMeasurements(config);
  const startedAt = nowIso();
  const submissionStartedMonotonic = performance.now();
  let jobSummary: Record<string, unknown> | null = null;
  let completionObserved = false;
  let completionObservedAt: string | null = null;
  let completionElapsedMs: number | null = null;
  let submissionLatencyMs: number | null = null;
  let countMismatch: MatchedCountMismatch | null = null;
  let interactiveMeasurementDurationMs: number | null;
  let failure: string | null;
  try {
    const submission = await submitBulkJob(config, config.largeWorkspaceId);
    submissionLatencyMs = submission.submissionLatencyMs;
    jobSummary = summarizeJob(submission.job);
    countMismatch = exactMatchCountMismatch(
      submission.job,
      config.largeWorkspaceId,
    );
    if (countMismatch) {
      throw new Error(countMismatch.message);
    }
    const finalJob = await waitForTerminalJob(
      config,
      config.largeWorkspaceId,
      submission.job.id,
    );
    jobSummary = summarizeJob(finalJob);
    completionObserved = true;
    completionObservedAt = nowIso();
    completionElapsedMs = performance.now() - submissionStartedMonotonic;
    failure = failureForJob(finalJob) ?? null;
  } catch (error) {
    failure = errorMessage(error);
  } finally {
    interactiveMeasurementDurationMs = load.stop();
  }
  const interactiveLatency = await load.result;
  if (
    failure === null &&
    (interactiveLatency.largeWorkspace.errors > 0 ||
      interactiveLatency.smallWorkspace.errors > 0)
  ) {
    failure = 'Interactive requests reported HTTP or transport errors.';
  }
  const elapsedMs =
    completionElapsedMs ?? performance.now() - submissionStartedMonotonic;
  return {
    scenario: 'bulk',
    success: failure === null,
    startedAt,
    completedAt: completionObservedAt ?? nowIso(),
    workspaceId: config.largeWorkspaceId,
    elapsedMs,
    submissionLatencyMs,
    totalCompletionElapsedMs: completionObserved ? elapsedMs : null,
    interactiveMeasurementDurationMs,
    workload: workloadSummary(config),
    job: jobSummary,
    countMismatch,
    interactiveLatency,
    failure,
  };
}

function workloadSummary(config: BenchmarkConfig): Record<string, unknown> {
  return {
    request: 'GET /api/v1/opportunities?stageId=<configured-stage>&limit=1',
    requestsPerSecondPerWorkspace: config.requestRate,
    maxConcurrencyPerWorkspace: config.concurrency,
    targetCount: expectedMatchedCount,
    largeWorkspaceId: config.largeWorkspaceId,
    largeStageId: config.largeStageId,
    smallWorkspaceId: config.smallWorkspaceId,
    smallStageId: config.smallStageId,
  };
}

async function runCrashStart(
  config: BenchmarkConfig,
): Promise<Record<string, unknown>> {
  const startedAt = nowIso();
  const startedMonotonic = performance.now();
  const submission = await submitBulkJob(config, config.largeWorkspaceId);
  let latestJob = submission.job;
  const countMismatch = exactMatchCountMismatch(
    submission.job,
    config.largeWorkspaceId,
  );
  if (countMismatch) {
    return {
      scenario: 'crash-start',
      success: false,
      startedAt,
      completedAt: nowIso(),
      submissionLatencyMs: submission.submissionLatencyMs,
      workspaceId: config.largeWorkspaceId,
      job: summarizeJob(submission.job),
      countMismatch,
      failure: countMismatch.message,
    };
  }

  try {
    let progressBeforeWorkerStop: JobResponse | undefined;
    const deadline = performance.now() + config.timeoutMs;
    let progressFirstObservedAt: string | undefined;
    while (performance.now() < deadline) {
      const remainingMs = deadline - performance.now();
      const job = await getJob(
        config.baseUrl,
        config.largeWorkspaceId,
        submission.job.id,
        Math.max(1, Math.min(requestTimeoutMs, remainingMs)),
      );
      latestJob = job;
      if (isTerminalJobStatus(job.status)) {
        throw new Error(
          `Job reached terminal status "${job.status}" before an operator could stop the worker.`,
        );
      }
      if (job.processedCount > 0) {
        progressBeforeWorkerStop = await getJob(
          config.baseUrl,
          config.largeWorkspaceId,
          submission.job.id,
          Math.max(1, Math.min(requestTimeoutMs, deadline - performance.now())),
        );
        latestJob = progressBeforeWorkerStop;
        if (isTerminalJobStatus(progressBeforeWorkerStop.status)) {
          throw new Error(
            `Job reached terminal status "${progressBeforeWorkerStop.status}" before an operator could stop the worker.`,
          );
        }
        progressFirstObservedAt = nowIso();
        break;
      }
      await new Promise((resolveWait) =>
        setTimeout(
          resolveWait,
          Math.min(
            config.pollIntervalMs,
            Math.max(0, deadline - performance.now()),
          ),
        ),
      );
    }
    if (!progressBeforeWorkerStop || !progressFirstObservedAt) {
      throw new Error(
        `Timed out waiting for initial job progress after ${config.timeoutMs} ms.`,
      );
    }

    console.log(
      `Latest durable progress immediately before stop observed at ${progressFirstObservedAt}: ${progressBeforeWorkerStop.processedCount}/${progressBeforeWorkerStop.matchedCount}. Ensure no other worker instance is running or able to claim this job. Stop only this worker process; keep the API and PostgreSQL running. Once the worker has exited, press Enter here.`,
    );
    const readline = createInterface({ input: stdin, output: stdout });
    try {
      await readline.question('');
    } finally {
      readline.close();
    }

    const workerStopConfirmedAt = nowIso();
    const stoppedJob = await getJob(
      config.baseUrl,
      config.largeWorkspaceId,
      submission.job.id,
    );
    latestJob = stoppedJob;
    if (isTerminalJobStatus(stoppedJob.status)) {
      throw new Error(
        'The job completed before the worker stop was recorded; this is not a valid crash-recovery checkpoint.',
      );
    }

    const checkpoint: CrashCheckpoint = {
      version: 1,
      jobId: stoppedJob.id,
      workspaceId: config.largeWorkspaceId,
      submittedAt: submission.submittedAt,
      submissionLatencyMs: submission.submissionLatencyMs,
      matchedCount: stoppedJob.matchedCount,
      progressObservedBeforeStop: toCounters(progressBeforeWorkerStop),
      progressAtStop: toCounters(stoppedJob),
      progressFirstObservedAt,
      workerStopConfirmedAt,
    };
    await writeJson(resolve(config.checkpointPath), checkpoint);

    return {
      scenario: 'crash-start',
      success: true,
      startedAt,
      completedAt: nowIso(),
      elapsedMs: performance.now() - startedMonotonic,
      submissionLatencyMs: submission.submissionLatencyMs,
      workspaceId: config.largeWorkspaceId,
      job: summarizeJob(stoppedJob),
      checkpointPath: resolve(config.checkpointPath),
      progressImmediatelyBeforeStop: checkpoint.progressObservedBeforeStop,
      progressAtStop: checkpoint.progressAtStop,
      progressFirstObservedAt: checkpoint.progressFirstObservedAt,
      workerStopConfirmedAt: checkpoint.workerStopConfirmedAt,
      operatorAction:
        'Worker stop was operator-attested. No other worker may run during the experiment. Restart the worker manually, then run crash-resume with this checkpoint.',
    };
  } catch (error) {
    return {
      scenario: 'crash-start',
      success: false,
      startedAt,
      completedAt: nowIso(),
      elapsedMs: performance.now() - startedMonotonic,
      submissionLatencyMs: submission.submissionLatencyMs,
      job: summarizeJob(latestJob),
      failure: errorMessage(error),
    };
  }
}

function parseCheckpoint(value: unknown): CrashCheckpoint {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Crash-recovery checkpoint is not a JSON object.');
  }
  const checkpoint = value as Partial<CrashCheckpoint>;
  if (
    checkpoint.version !== 1 ||
    typeof checkpoint.jobId !== 'string' ||
    typeof checkpoint.workspaceId !== 'string' ||
    typeof checkpoint.submittedAt !== 'string' ||
    !checkpoint.progressAtStop ||
    !Number.isSafeInteger(checkpoint.progressAtStop.processedCount) ||
    !Number.isSafeInteger(checkpoint.matchedCount) ||
    checkpoint.matchedCount !== expectedMatchedCount
  ) {
    throw new Error('Crash-recovery checkpoint is incomplete or unsupported.');
  }
  return checkpoint as CrashCheckpoint;
}

async function runCrashResume(
  config: BenchmarkConfig,
): Promise<Record<string, unknown>> {
  const checkpointPath = resolve(config.checkpointPath);
  let checkpoint: CrashCheckpoint;
  try {
    checkpoint = parseCheckpoint(
      JSON.parse(await readFile(checkpointPath, 'utf8')) as unknown,
    );
  } catch (error) {
    throw new Error(
      error instanceof Error && error.message.startsWith('Crash-recovery')
        ? error.message
        : 'Could not read the crash-recovery checkpoint.',
      { cause: error },
    );
  }

  console.log(
    'Ensure no other worker instance is running or able to claim the job. Start the worker manually. After its worker_started event appears, press Enter to record the persisted restart-confirmation baseline.',
  );
  const readline = createInterface({ input: stdin, output: stdout });
  try {
    await readline.question('');
  } finally {
    readline.close();
  }

  const restartConfirmationAt = nowIso();
  const restartMonotonic = performance.now();
  const restartBaseline = await getJob(
    config.baseUrl,
    checkpoint.workspaceId,
    checkpoint.jobId,
  );
  const restartProgressSnapshot = {
    status: restartBaseline.status,
    processedCount: restartBaseline.processedCount,
  };
  const restartConfirmationProgress = {
    status: restartProgressSnapshot.status,
    counters: toCounters(restartBaseline),
  };
  if (isTerminalJobStatus(restartBaseline.status)) {
    const completionObservedAt = nowIso();
    return {
      scenario: 'crash-resume',
      success: false,
      submittedAt: checkpoint.submittedAt,
      restartConfirmationAt,
      completionObservedAt,
      restartConfirmationProgress,
      restartConfirmationToObservedProgressMs: null,
      totalCompletionWallClockMs:
        Date.parse(completionObservedAt) - Date.parse(checkpoint.submittedAt),
      submissionLatencyMs: checkpoint.submissionLatencyMs,
      progressAtStop: checkpoint.progressAtStop,
      job: summarizeJob(restartBaseline),
      failure:
        `Job was already terminal (${restartBaseline.status}) at restart confirmation; ` +
        'crash recovery cannot be measured.',
      timingNote:
        'Recovery is operator-attested. The harness does not verify which OS process caused progress.',
    };
  }

  let resumedProgressAtMs: number | null = null;
  const finalJob = await waitForTerminalJob(
    config,
    checkpoint.workspaceId,
    checkpoint.jobId,
    (job) => {
      if (resumedProgressAtMs === null) {
        resumedProgressAtMs = restartProgressMeasurement(
          restartProgressSnapshot,
          { status: job.status, processedCount: job.processedCount },
          performance.now() - restartMonotonic,
        ).restartConfirmationToObservedProgressMs;
      }
    },
  );
  const completionObservedAt = nowIso();
  const totalCompletionWallClockMs =
    Date.parse(completionObservedAt) - Date.parse(checkpoint.submittedAt);
  const failure = failureForJob(finalJob);
  const success =
    failure === undefined &&
    resumedProgressAtMs !== null &&
    isConsistentJobCounters(toCounters(finalJob));

  return {
    scenario: 'crash-resume',
    success,
    submittedAt: checkpoint.submittedAt,
    restartConfirmationAt,
    restartConfirmationProgress,
    completionObservedAt,
    restartConfirmationToObservedProgressMs: resumedProgressAtMs,
    totalCompletionWallClockMs,
    submissionLatencyMs: checkpoint.submissionLatencyMs,
    progressAtStop: checkpoint.progressAtStop,
    job: summarizeJob(finalJob),
    failure:
      failure ??
      (resumedProgressAtMs === null
        ? 'No persisted progress increase beyond the restart-confirmation baseline was observed.'
        : null),
    timingNote:
      'The monotonic recovery interval starts when the operator confirms worker_started and is named from that confirmation boundary. The harness does not verify which OS process caused persisted progress. End-to-end crash completion spans processes and uses UTC wall-clock timestamps.',
  };
}

function printSummary(report: Record<string, unknown>, path: string): void {
  const scenario = String(report.scenario ?? 'benchmark');
  const success = report.success === true;
  console.log(`${scenario}: ${success ? 'PASS' : 'FAIL'}`);
  if (typeof report.submissionLatencyMs === 'number') {
    console.log(
      `Submission latency: ${report.submissionLatencyMs.toFixed(2)} ms`,
    );
  }
  if (typeof report.elapsedMs === 'number') {
    console.log(`Elapsed: ${(report.elapsedMs / 1_000).toFixed(2)} s`);
  }
  const job = report.job as
    | {
        status?: string;
        counters?: JobCounters;
        throughput?: {
          processedItemsPerPersistedWallClockSecond?: number | null;
          movedOpportunitiesPerPersistedWallClockSecond?: number | null;
        } | null;
      }
    | null
    | undefined;
  if (job?.counters) {
    console.log(
      `Job ${job.status}: matched=${job.counters.matchedCount}, processed=${job.counters.processedCount}, moved=${job.counters.movedCount}, skipped=${job.counters.skippedCount}, failed=${job.counters.failedCount}, pending=${job.counters.pendingCount}`,
    );
  }
  if (job?.throughput) {
    console.log(
      `Persisted throughput: processedItemsPerPersistedWallClockSecond=${job.throughput.processedItemsPerPersistedWallClockSecond ?? 'n/a'}, movedOpportunitiesPerPersistedWallClockSecond=${job.throughput.movedOpportunitiesPerPersistedWallClockSecond ?? 'n/a'} (items/s)`,
    );
  }
  const latency = report.interactiveLatency as
    | {
        largeWorkspace: LatencySummary;
        smallWorkspace: LatencySummary;
      }
    | undefined;
  if (latency) {
    for (const [label, metrics] of [
      ['large workspace', latency.largeWorkspace],
      ['small workspace', latency.smallWorkspace],
    ] as const) {
      console.log(
        `${label}: n=${metrics.requestCount}, errors=${metrics.errors} (HTTP ${metrics.httpErrors}, transport ${metrics.transportErrors}), p50=${metrics.p50Ms ?? 'n/a'} ms, p95=${metrics.p95Ms ?? 'n/a'} ms, p99=${metrics.p99Ms ?? 'n/a'} ms`,
      );
    }
  }
  if (report.failure) {
    console.error(`Failure: ${String(report.failure)}`);
  }
  console.log(`JSON results: ${path}`);
}

function printHelp(): void {
  console.log(
    [
      'Usage: npm run benchmark:bulk -- <baseline|bulk|crash-start|crash-resume> [options]',
      'Mutation confirmation: --confirm-benchmark is required for bulk and crash-start.',
      'Common options: --base-url --large-workspace-id --large-stage-id',
      '  --small-workspace-id --small-stage-id --source-stage-id --target-stage-id',
      '  --target-count 50000 --request-rate 2 --concurrency 1',
      '  --duration-seconds 60 --poll-interval-ms 1000 --timeout-seconds 3600',
      '  --output <json-path> --checkpoint <checkpoint-path>',
      'Crash-resume reads the checkpoint and only needs --base-url, --checkpoint,',
      '  --poll-interval-ms, --timeout-seconds, and --output.',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseBenchmarkArguments(process.argv.slice(2));
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 2;
    return;
  }
  if (parsed.help) {
    printHelp();
    return;
  }

  const { config } = parsed;
  const path = outputPath(config, config.scenario);
  const report: Record<string, unknown> = {
    generatedAt: nowIso(),
    scenario: config.scenario,
    baseUrl: config.baseUrl,
    environment: environmentMetadata(),
  };
  try {
    Object.assign(
      report,
      config.scenario === 'baseline'
        ? await runBaseline(config)
        : config.scenario === 'bulk'
          ? await runBulk(config)
          : config.scenario === 'crash-start'
            ? await runCrashStart(config)
            : await runCrashResume(config),
    );
  } catch (error) {
    report.success = false;
    report.failure = errorMessage(error);
    report.completedAt = nowIso();
  }

  await writeJson(path, report);
  printSummary(report, path);
  if (report.success !== true) {
    process.exitCode = 1;
  }
}

await main();
