import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateOpportunityDto } from './create-opportunity.dto.js';
import { ListOpportunitiesDto } from './list-opportunities.dto.js';

describe('CreateOpportunityDto', () => {
  const validInput = {
    stageId: '54d73e72-03bc-4c20-859e-ad4996223cc6',
    name: '  Example opportunity  ',
    value: '12500.00',
  };

  it('trims names without coercing decimal strings', async () => {
    const dto = plainToInstance(CreateOpportunityDto, validInput);

    expect(dto.name).toBe('Example opportunity');
    expect(dto.value).toBe('12500.00');
    expect(await validate(dto)).toHaveLength(0);
  });

  it.each(['-1', '1.00001', '1000000000000000', '1e3', 'NaN'])(
    'rejects invalid monetary precision/value %s',
    async (value) => {
      const dto = plainToInstance(CreateOpportunityDto, {
        ...validInput,
        value,
      });

      expect(await validate(dto)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ property: 'value' }),
        ]),
      );
    },
  );

  it('rejects null status instead of treating it as omitted', async () => {
    const dto = plainToInstance(CreateOpportunityDto, {
      ...validInput,
      status: null,
    });

    expect(await validate(dto)).toEqual(
      expect.arrayContaining([expect.objectContaining({ property: 'status' })]),
    );
  });

  it('rejects malformed or empty cursors', async () => {
    for (const cursor of ['', 'not-a-cursor']) {
      const dto = plainToInstance(ListOpportunitiesDto, {
        stageId: validInput.stageId,
        cursor,
      });
      expect(await validate(dto)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ property: 'cursor' }),
        ]),
      );
    }
  });
});
