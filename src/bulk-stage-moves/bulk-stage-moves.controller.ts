import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { BulkStageMoveResponseDto } from './dto/bulk-stage-move-response.dto.js';
import { SubmitBulkStageMoveDto } from './dto/submit-bulk-stage-move.dto.js';
import { BulkStageMovesService } from './bulk-stage-moves.service.js';

@ApiTags('bulk-stage-moves')
@ApiHeader({
  name: 'X-Workspace-Id',
  required: true,
  description: 'Workspace scope (not an authentication credential).',
})
@Controller('api/v1/bulk-stage-moves')
export class BulkStageMovesController {
  constructor(private readonly bulkStageMoves: BulkStageMovesService) {}

  @Post()
  @ApiOperation({
    summary: 'Submit a bulk stage move and snapshot matching opportunities',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'Request idempotency key, trimmed and limited to 128 characters.',
  })
  @ApiAcceptedResponse({ type: BulkStageMoveResponseDto })
  @ApiOkResponse({
    description: 'An existing job was returned for a repeated request.',
    type: BulkStageMoveResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Invalid workspace, idempotency key, or submission body.',
  })
  @ApiConflictResponse({
    description: 'The idempotency key was reused with a different request.',
  })
  @ApiNotFoundResponse({
    description: 'Workspace or destination stage was not found.',
  })
  @ApiUnprocessableEntityResponse({
    description: 'More than 50,000 opportunities match the filter.',
  })
  async submit(
    @Headers('x-workspace-id') workspaceId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: SubmitBulkStageMoveDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<BulkStageMoveResponseDto> {
    const result = await this.bulkStageMoves.submit(
      workspaceId,
      idempotencyKey,
      input,
    );
    response.status(result.statusCode);
    return result.job;
  }

  @Get(':jobId')
  @ApiOperation({ summary: 'Get persisted bulk stage move job status' })
  @ApiOkResponse({ type: BulkStageMoveResponseDto })
  @ApiBadRequestResponse({
    description: 'Invalid workspace header or job ID.',
  })
  @ApiNotFoundResponse({
    description: 'Workspace or workspace-scoped job was not found.',
  })
  get(
    @Headers('x-workspace-id') workspaceId: string,
    @Param('jobId') jobId: string,
  ): Promise<BulkStageMoveResponseDto> {
    return this.bulkStageMoves.get(workspaceId, jobId);
  }
}
