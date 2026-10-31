import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { OpportunityStatus } from '../../generated/prisma/enums.js';

export class CreateOpportunityDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  stageId!: string;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID()
  ownerId?: string | null;

  @ApiProperty({ minLength: 1 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  name!: string;

  @ApiProperty({
    type: String,
    example: '12500.00',
    description:
      'Non-negative decimal string with at most 15 integer digits and 4 fractional digits.',
  })
  @IsString()
  @Matches(/^(?:0|[1-9]\d{0,14})(?:\.\d{1,4})?$/)
  value!: string;

  @ApiPropertyOptional({
    enum: OpportunityStatus,
    default: OpportunityStatus.open,
  })
  @ValidateIf((_object, value) => value !== undefined)
  @IsEnum(OpportunityStatus)
  status?: OpportunityStatus;
}
