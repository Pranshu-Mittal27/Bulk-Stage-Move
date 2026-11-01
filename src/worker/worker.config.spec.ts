import { describe, expect, it } from '@jest/globals';
import { parseLeaseDurationMs } from '../bulk-stage-moves/bulk-job-lease.service.js';
import {
  parseWorkerConfig,
  prepareWorkerEnvironment,
} from './worker.config.js';

describe('parseWorkerConfig', () => {
  it('uses worker-safe defaults', () => {
    expect(
      parseWorkerConfig({
        BULK_JOB_WORKER_ID: 'worker-test',
      }),
    ).toEqual({
      workerId: 'worker-test',
      pollIntervalMs: 1_000,
      leaseDurationMs: 120_000,
    });
  });

  it('accepts explicit bounded worker settings', () => {
    expect(
      parseWorkerConfig({
        BULK_JOB_WORKER_ID: 'worker-test',
        BULK_JOB_WORKER_LEASE_DURATION_MS: '90000',
        BULK_JOB_POLL_INTERVAL_MS: '5000',
      }),
    ).toEqual({
      workerId: 'worker-test',
      pollIntervalMs: 5_000,
      leaseDurationMs: 90_000,
    });
  });

  it.each([
    ['poll interval below range', { BULK_JOB_POLL_INTERVAL_MS: '99' }],
    ['poll interval above range', { BULK_JOB_POLL_INTERVAL_MS: '60001' }],
    ['non-integer poll interval', { BULK_JOB_POLL_INTERVAL_MS: '1.5' }],
    [
      'worker lease below safe range',
      { BULK_JOB_WORKER_LEASE_DURATION_MS: '89999' },
    ],
    [
      'worker lease above service maximum',
      { BULK_JOB_WORKER_LEASE_DURATION_MS: '300001' },
    ],
    [
      'non-integer worker lease',
      { BULK_JOB_WORKER_LEASE_DURATION_MS: '90000.5' },
    ],
    ['invalid worker id', { BULK_JOB_WORKER_ID: '  ' }],
  ])('rejects %s', (_label, values) => {
    expect(() =>
      parseWorkerConfig({
        BULK_JOB_WORKER_ID: 'worker-test',
        ...values,
      }),
    ).toThrow();
  });

  it('keeps API lease defaults separate from worker settings', () => {
    const environment = {
      BULK_JOB_WORKER_LEASE_DURATION_MS: '120000',
    };

    expect(parseLeaseDurationMs(environment.BULK_JOB_LEASE_DURATION_MS)).toBe(
      30_000,
    );
    expect(parseWorkerConfig(environment).leaseDurationMs).toBe(120_000);
    expect(environment.BULK_JOB_LEASE_DURATION_MS).toBeUndefined();
  });

  it('maps worker lease configuration only when preparing the worker process', () => {
    const environment = {
      BULK_JOB_WORKER_LEASE_DURATION_MS: '150000',
      BULK_JOB_LEASE_DURATION_MS: '45000',
    };

    const config = prepareWorkerEnvironment(environment);

    expect(config.leaseDurationMs).toBe(150_000);
    expect(environment.BULK_JOB_LEASE_DURATION_MS).toBe('150000');
  });
});
