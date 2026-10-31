import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SubmitBulkStageMoveDto } from './submit-bulk-stage-move.dto.js';

describe('SubmitBulkStageMoveDto', () => {
  const validInput = {
    targetStageId: '54d73e72-03bc-4c20-859e-ad4996223cc6',
  };

  it('accepts omitted and empty filters as equivalent valid inputs', async () => {
    for (const input of [
      validInput,
      { ...validInput, filter: { valueRange: {}, createdAt: {} } },
    ]) {
      expect(
        await validate(plainToInstance(SubmitBulkStageMoveDto, input)),
      ).toHaveLength(0);
    }
  });

  it('compares timestamp ranges at PostgreSQL microsecond precision', async () => {
    const dto = plainToInstance(SubmitBulkStageMoveDto, {
      ...validInput,
      filter: {
        createdAt: {
          from: '2026-03-01T10:00:00.000100Z',
          to: '2026-03-01T10:00:00.000500Z',
        },
      },
    });

    expect(await validate(dto)).toHaveLength(0);
  });

  it.each([
    { valueRange: { min: '1e3' } },
    { valueRange: { min: '10', max: '9.99' } },
    {
      createdAt: {
        from: '2026-03-02T00:00:00.000Z',
        to: '2026-03-01T00:00:00.000Z',
      },
    },
    { status: null },
    { stageId: 'not-a-uuid' },
  ])('rejects invalid filter shape or range %#', async (filter) => {
    const dto = plainToInstance(SubmitBulkStageMoveDto, {
      ...validInput,
      filter,
    });

    expect(await validate(dto)).not.toHaveLength(0);
  });
});
