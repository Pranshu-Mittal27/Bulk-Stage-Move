import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsObject,
  IsString,
  IsUUID,
  Matches,
  Validate,
  ValidateIf,
  ValidateNested,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
  type ValidationArguments,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Prisma } from '../../generated/prisma/client.js';
import { OpportunityStatus } from '../../generated/prisma/enums.js';

const decimalPattern = /^(?:0|[1-9]\d{0,14})(?:\.\d{1,4})?$/;
const timestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function timestampMicroseconds(value: string): bigint | undefined {
  if (!timestampPattern.test(value)) {
    return undefined;
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    return undefined;
  }
  const fraction = /T\d{2}:\d{2}:\d{2}\.(\d+)/.exec(value)?.[1] ?? '';
  const millisecondPart = Number(fraction.padEnd(3, '0').slice(0, 3));
  let microsecondPart = Number(fraction.padEnd(6, '0').slice(0, 6));
  if (fraction.length > 6 && fraction[6]! >= '5') {
    microsecondPart += 1;
  }
  const secondMilliseconds = milliseconds - millisecondPart;
  if (microsecondPart === 1_000_000) {
    return BigInt(secondMilliseconds + 1000) * 1000n;
  }
  return BigInt(secondMilliseconds) * 1000n + BigInt(microsecondPart);
}

@ValidatorConstraint({ name: 'orderedValueRange', async: false })
class OrderedValueRangeConstraint implements ValidatorConstraintInterface {
  validate(_value: string | undefined, args?: ValidationArguments): boolean {
    if (!args) {
      return false;
    }
    const value = args.object as ValueRangeDto;
    if (value.min === undefined || value.max === undefined) {
      return true;
    }

    if (!decimalPattern.test(value.min) || !decimalPattern.test(value.max)) {
      return true;
    }

    return new Prisma.Decimal(value.min).lessThanOrEqualTo(value.max);
  }

  defaultMessage(): string {
    return 'valueRange.min must be less than or equal to valueRange.max.';
  }
}

@ValidatorConstraint({ name: 'orderedCreatedAtRange', async: false })
class OrderedCreatedAtRangeConstraint implements ValidatorConstraintInterface {
  validate(_value: string | undefined, args?: ValidationArguments): boolean {
    if (!args) {
      return false;
    }
    const value = args.object as CreatedAtRangeDto;
    if (value.from === undefined || value.to === undefined) {
      return true;
    }

    const from = timestampMicroseconds(value.from);
    const to = timestampMicroseconds(value.to);
    return from === undefined || to === undefined || from < to;
  }

  defaultMessage(): string {
    return 'createdAt.from must be earlier than createdAt.to.';
  }
}

export class ValueRangeDto {
  @ApiPropertyOptional({
    type: String,
    example: '100.00',
    description: 'Inclusive non-negative decimal lower bound.',
  })
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Matches(decimalPattern)
  min?: string;

  @ApiPropertyOptional({
    type: String,
    example: '5000.00',
    description: 'Inclusive non-negative decimal upper bound.',
  })
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Matches(decimalPattern)
  @Validate(OrderedValueRangeConstraint)
  max?: string;
}

export class CreatedAtRangeDto {
  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description: 'Inclusive ISO-8601 lower bound.',
  })
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Matches(timestampPattern)
  @IsDateString({ strict: true })
  from?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date-time',
    description: 'Exclusive ISO-8601 upper bound.',
  })
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Matches(timestampPattern)
  @IsDateString({ strict: true })
  @Validate(OrderedCreatedAtRangeConstraint)
  to?: string;
}

export class BulkOpportunityFilterDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @ValidateIf((_object, value) => value !== undefined)
  @IsUUID()
  stageId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @ValidateIf((_object, value) => value !== undefined)
  @IsUUID()
  ownerId?: string;

  @ApiPropertyOptional({ enum: OpportunityStatus })
  @ValidateIf((_object, value) => value !== undefined)
  @IsEnum(OpportunityStatus)
  status?: OpportunityStatus;

  @ApiPropertyOptional({ type: ValueRangeDto })
  @ValidateIf((_object, value) => value !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => ValueRangeDto)
  valueRange?: ValueRangeDto;

  @ApiPropertyOptional({ type: CreatedAtRangeDto })
  @ValidateIf((_object, value) => value !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => CreatedAtRangeDto)
  createdAt?: CreatedAtRangeDto;
}

export class SubmitBulkStageMoveDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  targetStageId!: string;

  @ApiPropertyOptional({ type: BulkOpportunityFilterDto })
  @ValidateIf((_object, value) => value !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => BulkOpportunityFilterDto)
  filter?: BulkOpportunityFilterDto;
}
