import {
  parseBatchSize,
  parseRetryBackoffMs,
} from './bulk-job-processing.service.js';

describe('parseBatchSize', () => {
  it('uses the bounded default batch size when unset', () => {
    expect(parseBatchSize(undefined)).toBe(100);
  });

  it.each([
    ['1', 1],
    ['500', 500],
  ])('accepts a supported batch size of %s', (value, expected) => {
    expect(parseBatchSize(value)).toBe(expected);
  });

  it.each(['', ' 100', '100 ', '1.5', '0', '501', 'Infinity'])(
    'rejects invalid batch size %s',
    (value) => {
      expect(() => parseBatchSize(value)).toThrow('BULK_JOB_BATCH_SIZE');
    },
  );
});

describe('parseRetryBackoffMs', () => {
  it('uses the bounded default retry backoff when unset', () => {
    expect(parseRetryBackoffMs(undefined)).toBe(30_000);
  });

  it.each([
    ['1000', 1_000],
    ['3600000', 3_600_000],
  ])(
    'accepts a supported retry backoff of %s milliseconds',
    (value, expected) => {
      expect(parseRetryBackoffMs(value)).toBe(expected);
    },
  );

  it.each(['', ' 30000', '30000 ', '1.5', '999', '3600001', 'Infinity'])(
    'rejects invalid retry backoff %s',
    (value) => {
      expect(() => parseRetryBackoffMs(value)).toThrow(
        'BULK_JOB_RETRY_BACKOFF_MS',
      );
    },
  );
});
