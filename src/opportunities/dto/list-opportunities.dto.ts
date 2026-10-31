import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class ListOpportunitiesDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  stageId!: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value !== 'string' || !/^\d+$/.test(value)) {
      return Number.NaN;
    }
    return Number(value);
  })
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({
    description: 'Opaque cursor returned by the previous page.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^v1_[A-Za-z0-9_-]+$/)
  @MaxLength(128)
  cursor?: string;
}
