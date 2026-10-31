import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsUUID, Min } from 'class-validator';

export class ChangeOpportunityStageDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  targetStageId!: string;

  @ApiProperty({ minimum: 1, example: 1 })
  @IsInt()
  @Min(1)
  expectedStageVersion!: number;
}
