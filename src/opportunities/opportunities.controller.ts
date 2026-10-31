import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ChangeOpportunityStageDto } from './dto/change-opportunity-stage.dto.js';
import { CreateOpportunityDto } from './dto/create-opportunity.dto.js';
import { ListOpportunitiesDto } from './dto/list-opportunities.dto.js';
import {
  OpportunityListResponseDto,
  OpportunityResponseDto,
} from './dto/opportunity-response.dto.js';
import { OpportunitiesService } from './opportunities.service.js';

@ApiTags('opportunities')
@ApiHeader({
  name: 'X-Workspace-Id',
  required: true,
  description: 'Workspace scope (not an authentication credential).',
})
@Controller('api/v1/opportunities')
export class OpportunitiesController {
  constructor(private readonly opportunities: OpportunitiesService) {}

  @Post()
  @ApiOperation({ summary: 'Create an opportunity and its initial transition' })
  @ApiCreatedResponse({ type: OpportunityResponseDto })
  @ApiBadRequestResponse({
    description: 'Invalid workspace header or request body.',
  })
  @ApiNotFoundResponse({ description: 'Workspace or stage was not found.' })
  create(
    @Headers('x-workspace-id') workspaceId: string,
    @Body() input: CreateOpportunityDto,
  ): Promise<OpportunityResponseDto> {
    return this.opportunities.create(workspaceId, input);
  }

  @Get()
  @ApiOperation({
    summary: 'List opportunities by stage using cursor pagination',
  })
  @ApiOkResponse({ type: OpportunityListResponseDto })
  @ApiBadRequestResponse({
    description: 'Invalid workspace header or query parameters.',
  })
  @ApiNotFoundResponse({ description: 'Workspace or stage was not found.' })
  list(
    @Headers('x-workspace-id') workspaceId: string,
    @Query() query: ListOpportunitiesDto,
  ): Promise<OpportunityListResponseDto> {
    return this.opportunities.list(workspaceId, query);
  }

  @Patch(':id/stage')
  @ApiOperation({
    summary: 'Move an opportunity to another stage conditionally',
  })
  @ApiOkResponse({ type: OpportunityResponseDto })
  @ApiBadRequestResponse({
    description: 'Invalid workspace header, ID, or request body.',
  })
  @ApiNotFoundResponse({
    description: 'Workspace, opportunity, or target stage was not found.',
  })
  @ApiConflictResponse({ description: 'The expected stage version is stale.' })
  changeStage(
    @Headers('x-workspace-id') workspaceId: string,
    @Param('id') opportunityId: string,
    @Body() input: ChangeOpportunityStageDto,
  ): Promise<OpportunityResponseDto> {
    return this.opportunities.changeStage(workspaceId, opportunityId, input);
  }
}
