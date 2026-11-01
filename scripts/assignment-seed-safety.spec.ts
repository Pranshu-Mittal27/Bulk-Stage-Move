import { describe, expect, it, jest } from '@jest/globals';
import {
  assertConnectedDatabaseMatchesConfirmation,
  assertDatabaseUrlMatchesConfirmation,
  parseConfirmedDatabaseName,
  runSeedWritesAfterDatabaseNameCheck,
} from './assignment-seed-safety.js';

const invalidConfirmationArguments = [
  [],
  ['ghl_bulk_stage_seed'],
  ['--confirm-disposable-database'],
  ['--confirm-disposable-database', 'ghl_bulk_stage_seed', 'extra'],
  [
    '--confirm-disposable-database',
    'ghl_bulk_stage_seed',
    '--confirm-disposable-database',
    'ghl_bulk_stage_bench',
  ],
  ['--confirm-disposable-database', 'GHL_BULK_STAGE_BENCH'],
  ['--confirm-disposable-database', '1ghl_bulk_stage_bench'],
  ['--confirm-disposable-database', 'ghl-bulk-stage-bench'],
  ['--confirm-disposable-database', 'ghl_bulk_stage_bench\n'],
  ['--confirm-disposable-database', `${'a'.repeat(63)}a`],
];

describe('assignment seed safety checks', () => {
  it.each(['ghl_bulk_stage_seed', 'ghl_bulk_stage_bench'])(
    'accepts an explicit confirmation for %s',
    (databaseName) => {
      expect(
        parseConfirmedDatabaseName([
          '--confirm-disposable-database',
          databaseName,
        ]),
      ).toBe(databaseName);
    },
  );

  it.each(invalidConfirmationArguments.map((args) => ({ args })))(
    'rejects invalid confirmation arguments $args',
    ({ args }) => {
      expect(() => parseConfirmedDatabaseName(args)).toThrow();
    },
  );

  it('accepts a URL whose decoded database name matches confirmation', () => {
    expect(() =>
      assertDatabaseUrlMatchesConfirmation(
        'postgresql://seed-test:password@localhost:5432/ghl_bulk_stage%5Fbench?schema=public',
        'ghl_bulk_stage_bench',
      ),
    ).not.toThrow();
  });

  it.each([
    'postgresql://localhost:5432/ghl_bulk_stage_bench',
    'postgres://localhost:5432/ghl_bulk_stage_seed',
  ])('accepts hierarchical PostgreSQL URLs: %s', (url) => {
    expect(() =>
      assertDatabaseUrlMatchesConfirmation(
        url,
        url.endsWith('ghl_bulk_stage_seed')
          ? 'ghl_bulk_stage_seed'
          : 'ghl_bulk_stage_bench',
      ),
    ).not.toThrow();
  });

  it.each([
    'postgresql:ghl_bulk_stage_bench',
    'postgresql://localhost:5432',
    'postgresql://localhost:5432/',
    'postgresql:///ghl_bulk_stage_bench',
  ])('rejects URLs without hierarchical database paths: %s', (url) => {
    expect(() =>
      assertDatabaseUrlMatchesConfirmation(url, 'ghl_bulk_stage_bench'),
    ).toThrow();
  });

  it('rejects a URL database name that differs from confirmation', () => {
    expect(() =>
      assertDatabaseUrlMatchesConfirmation(
        'postgresql://seed-test:password@localhost:5432/ghl_bulk_stage_seed',
        'ghl_bulk_stage_bench',
      ),
    ).toThrow('does not match');
  });

  it('rejects malformed encoded names and non-PostgreSQL URLs', () => {
    expect(() =>
      assertDatabaseUrlMatchesConfirmation(
        'postgresql://seed-test:password@localhost:5432/%E0%A4%A',
        'ghl_bulk_stage_bench',
      ),
    ).toThrow('invalid encoded database name');
    expect(() =>
      assertDatabaseUrlMatchesConfirmation(
        'https://localhost/ghl_bulk_stage_bench',
        'ghl_bulk_stage_bench',
      ),
    ).toThrow('hierarchical PostgreSQL URL');
  });

  it('requires PostgreSQL current_database() to match confirmation', () => {
    expect(() =>
      assertConnectedDatabaseMatchesConfirmation(
        'ghl_bulk_stage_bench',
        'ghl_bulk_stage_bench',
      ),
    ).not.toThrow();
    expect(() =>
      assertConnectedDatabaseMatchesConfirmation(
        'ghl_bulk_stage_seed',
        'ghl_bulk_stage_bench',
      ),
    ).toThrow('does not match');
    expect(() =>
      assertConnectedDatabaseMatchesConfirmation(
        undefined,
        'ghl_bulk_stage_bench',
      ),
    ).toThrow('does not match');
  });

  it('rejects malformed percent escapes in the database path', () => {
    expect(() =>
      assertDatabaseUrlMatchesConfirmation(
        'postgresql://localhost:5432/ghl_bulk_stage%ZZbench',
        'ghl_bulk_stage_bench',
      ),
    ).toThrow('invalid encoded database name');
  });

  it('does not invoke seed writes when the connected database mismatches', async () => {
    const writeSeedData = jest.fn<() => Promise<void>>().mockResolvedValue();

    await expect(
      runSeedWritesAfterDatabaseNameCheck(
        'ghl_bulk_stage_seed',
        'ghl_bulk_stage_bench',
        writeSeedData,
      ),
    ).rejects.toThrow('does not match');
    expect(writeSeedData).not.toHaveBeenCalled();
  });

  it('invokes seed writes after the connected database matches', async () => {
    const writeSeedData = jest
      .fn<() => Promise<string>>()
      .mockResolvedValue('seeded');

    await expect(
      runSeedWritesAfterDatabaseNameCheck(
        'ghl_bulk_stage_bench',
        'ghl_bulk_stage_bench',
        writeSeedData,
      ),
    ).resolves.toBe('seeded');
    expect(writeSeedData).toHaveBeenCalledTimes(1);
  });
});
