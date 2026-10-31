import { parseLeaseDurationMs } from './bulk-job-lease.service.js';

describe('parseLeaseDurationMs', () => {
  it('uses the bounded development default when unset', () => {
    expect(parseLeaseDurationMs(undefined)).toBe(30_000);
  });

  it.each([
    ['1000', 1_000],
    ['300000', 300_000],
  ])('accepts a supported duration of %s milliseconds', (value, expected) => {
    expect(parseLeaseDurationMs(value)).toBe(expected);
  });

  it.each(['', ' 30000', '30000 ', '1.5', '999', '300001', 'Infinity'])(
    'rejects invalid lease duration %s',
    (value) => {
      expect(() => parseLeaseDurationMs(value)).toThrow(
        'BULK_JOB_LEASE_DURATION_MS',
      );
    },
  );
});
