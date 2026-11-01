import { hostname } from 'node:os';
import { parseLeaseDurationMs } from '../bulk-stage-moves/bulk-job-lease.service.js';

const defaultLeaseDurationMs = 120_000;
const minimumWorkerLeaseDurationMs = 90_000;
const defaultPollIntervalMs = 1_000;
const minimumPollIntervalMs = 100;
const maximumPollIntervalMs = 60_000;
const maximumWorkerIdLength = 128;

export interface WorkerConfig {
  workerId: string;
  pollIntervalMs: number;
  leaseDurationMs: number;
}

function parsePollInterval(value: string | undefined): number {
  if (value === undefined) {
    return defaultPollIntervalMs;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(
      'BULK_JOB_POLL_INTERVAL_MS must be an integer number of milliseconds.',
    );
  }
  const intervalMs = Number(value);
  if (
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < minimumPollIntervalMs ||
    intervalMs > maximumPollIntervalMs
  ) {
    throw new Error(
      `BULK_JOB_POLL_INTERVAL_MS must be between ${minimumPollIntervalMs} and ${maximumPollIntervalMs}.`,
    );
  }
  return intervalMs;
}

export function parseWorkerConfig(
  environment: NodeJS.ProcessEnv,
): WorkerConfig {
  const leaseDurationMs = parseLeaseDurationMs(
    environment.BULK_JOB_WORKER_LEASE_DURATION_MS ??
      String(defaultLeaseDurationMs),
  );
  if (leaseDurationMs < minimumWorkerLeaseDurationMs) {
    throw new Error(
      `Worker lease duration must be at least ${minimumWorkerLeaseDurationMs} milliseconds to cover the batch transaction timeout, acquisition wait, and safety margin.`,
    );
  }

  const workerId =
    environment.BULK_JOB_WORKER_ID ?? `${hostname()}-${process.pid}`;
  if (workerId.trim().length === 0 || workerId.length > maximumWorkerIdLength) {
    throw new Error(
      `BULK_JOB_WORKER_ID must contain 1 to ${maximumWorkerIdLength} characters.`,
    );
  }

  return {
    workerId,
    pollIntervalMs: parsePollInterval(environment.BULK_JOB_POLL_INTERVAL_MS),
    leaseDurationMs,
  };
}

export function prepareWorkerEnvironment(
  environment: NodeJS.ProcessEnv,
): WorkerConfig {
  const config = parseWorkerConfig(environment);
  environment.BULK_JOB_LEASE_DURATION_MS = String(config.leaseDurationMs);
  return config;
}
