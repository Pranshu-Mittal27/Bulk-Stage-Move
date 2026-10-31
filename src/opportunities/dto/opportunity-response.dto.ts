import { ApiProperty } from '@nestjs/swagger';
import { OpportunityStatus } from '../../generated/prisma/enums.js';

export class OpportunityResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  workspaceId!: string;

  @ApiProperty({ format: 'uuid' })
  stageId!: string;

  @ApiProperty({ format: 'uuid', nullable: true })
  ownerId!: string | null;

  @ApiProperty()
  name!: string;

  @ApiProperty({ type: String, example: '12500.0000' })
  value!: string;

  @ApiProperty({ enum: OpportunityStatus })
  status!: OpportunityStatus;

  @ApiProperty({ minimum: 1 })
  stageVersion!: number;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}

export class OpportunityListResponseDto {
  @ApiProperty({ type: [OpportunityResponseDto] })
  items!: OpportunityResponseDto[];

  @ApiProperty({
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      nextCursor: { type: 'string', nullable: true },
    },
  })
  pagination!: {
    limit: number;
    nextCursor: string | null;
  };
}
