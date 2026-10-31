import { Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { Prisma } from '../generated/prisma/client.js';
import {
  OpportunityStatus,
  TransitionSource,
} from '../generated/prisma/enums.js';
import { ApiError } from '../common/api-error.js';
import { PrismaService } from '../database/prisma.service.js';
import { ChangeOpportunityStageDto } from './dto/change-opportunity-stage.dto.js';
import { CreateOpportunityDto } from './dto/create-opportunity.dto.js';
import { ListOpportunitiesDto } from './dto/list-opportunities.dto.js';
import {
  OpportunityListResponseDto,
  OpportunityResponseDto,
} from './dto/opportunity-response.dto.js';

const opportunitySelect = {
  id: true,
  workspaceId: true,
  stageId: true,
  ownerId: true,
  name: true,
  value: true,
  status: true,
  stageVersion: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.OpportunitySelect;

type OpportunityRecord = Prisma.OpportunityGetPayload<{
  select: typeof opportunitySelect;
}>;

interface LockedOpportunity {
  stageId: string;
  stageVersion: number;
}

function toResponse(opportunity: OpportunityRecord): OpportunityResponseDto {
  return {
    id: opportunity.id,
    workspaceId: opportunity.workspaceId,
    stageId: opportunity.stageId,
    ownerId: opportunity.ownerId,
    name: opportunity.name,
    value: opportunity.value.toFixed(4),
    status: opportunity.status,
    stageVersion: opportunity.stageVersion,
    createdAt: opportunity.createdAt.toISOString(),
    updatedAt: opportunity.updatedAt.toISOString(),
  };
}

function encodeCursor(opportunityId: string): string {
  return `v1_${Buffer.from(opportunityId, 'utf8').toString('base64url')}`;
}

function decodeCursor(cursor: string): string {
  const match = /^v1_([A-Za-z0-9_-]+)$/.exec(cursor);
  const encodedId = match?.[1];
  if (!encodedId) {
    throw new ApiError(400, 'validation_error', 'The cursor is invalid.');
  }

  const opportunityId = Buffer.from(encodedId, 'base64url').toString('utf8');
  if (!isUUID(opportunityId) || encodeCursor(opportunityId) !== cursor) {
    throw new ApiError(400, 'validation_error', 'The cursor is invalid.');
  }

  return opportunityId;
}

@Injectable()
export class OpportunitiesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    workspaceId: string,
    input: CreateOpportunityDto,
  ): Promise<OpportunityResponseDto> {
    this.validateWorkspaceId(workspaceId);

    return this.prisma.$transaction(async (transaction) => {
      await this.requireWorkspace(transaction, workspaceId);
      await this.requireStage(transaction, workspaceId, input.stageId);

      const opportunity = await transaction.opportunity.create({
        data: {
          workspaceId,
          stageId: input.stageId,
          ownerId: input.ownerId ?? null,
          name: input.name,
          value: new Prisma.Decimal(input.value),
          status: input.status ?? OpportunityStatus.open,
          stageVersion: 1,
        },
        select: opportunitySelect,
      });

      await transaction.opportunityTransition.create({
        data: {
          workspaceId,
          opportunityId: opportunity.id,
          fromStageId: null,
          toStageId: opportunity.stageId,
          source: TransitionSource.manual,
        },
      });

      return toResponse(opportunity);
    });
  }

  async list(
    workspaceId: string,
    query: ListOpportunitiesDto,
  ): Promise<OpportunityListResponseDto> {
    this.validateWorkspaceId(workspaceId);
    const limit = query.limit ?? 50;
    const cursorId = query.cursor ? decodeCursor(query.cursor) : undefined;

    await this.requireWorkspace(this.prisma, workspaceId);
    await this.requireStage(this.prisma, workspaceId, query.stageId);

    const records = await this.prisma.opportunity.findMany({
      where: {
        workspaceId,
        stageId: query.stageId,
        ...(cursorId ? { id: { gt: cursorId } } : {}),
      },
      orderBy: { id: 'asc' },
      take: limit + 1,
      select: opportunitySelect,
    });
    const hasMore = records.length > limit;
    const page = hasMore ? records.slice(0, limit) : records;

    return {
      items: page.map(toResponse),
      pagination: {
        limit,
        nextCursor: hasMore ? encodeCursor(page[page.length - 1]!.id) : null,
      },
    };
  }

  async changeStage(
    workspaceId: string,
    opportunityId: string,
    input: ChangeOpportunityStageDto,
  ): Promise<OpportunityResponseDto> {
    this.validateWorkspaceId(workspaceId);
    if (!isUUID(opportunityId)) {
      throw new ApiError(
        400,
        'validation_error',
        'The opportunity ID must be a valid UUID.',
      );
    }

    return this.prisma.$transaction(async (transaction) => {
      await this.requireWorkspace(transaction, workspaceId);
      await this.requireStage(transaction, workspaceId, input.targetStageId);

      const rows = await transaction.$queryRaw<LockedOpportunity[]>`
        SELECT "stageId", "stageVersion"
        FROM "Opportunity"
        WHERE "workspaceId" = ${workspaceId}::uuid
          AND "id" = ${opportunityId}::uuid
        FOR UPDATE
      `;
      const current = rows[0];
      if (!current) {
        throw new ApiError(
          404,
          'resource_not_found',
          'The opportunity was not found.',
        );
      }

      if (current.stageVersion !== input.expectedStageVersion) {
        throw this.stageVersionConflict();
      }

      if (current.stageId === input.targetStageId) {
        const unchanged = await transaction.opportunity.findFirst({
          where: { id: opportunityId, workspaceId },
          select: opportunitySelect,
        });
        if (!unchanged) {
          throw new ApiError(
            404,
            'resource_not_found',
            'The opportunity was not found.',
          );
        }
        return toResponse(unchanged);
      }

      const updatedAt = new Date();
      const update = await transaction.opportunity.updateMany({
        where: {
          id: opportunityId,
          workspaceId,
          stageId: current.stageId,
          stageVersion: input.expectedStageVersion,
        },
        data: {
          stageId: input.targetStageId,
          stageVersion: { increment: 1 },
          updatedAt,
        },
      });
      if (update.count !== 1) {
        throw this.stageVersionConflict();
      }

      await transaction.opportunityTransition.create({
        data: {
          workspaceId,
          opportunityId,
          fromStageId: current.stageId,
          toStageId: input.targetStageId,
          source: TransitionSource.manual,
        },
      });

      const updated = await transaction.opportunity.findFirst({
        where: { id: opportunityId, workspaceId },
        select: opportunitySelect,
      });
      if (!updated) {
        throw new ApiError(
          404,
          'resource_not_found',
          'The opportunity was not found.',
        );
      }

      return toResponse(updated);
    });
  }

  private validateWorkspaceId(workspaceId: string): void {
    if (!isUUID(workspaceId)) {
      throw new ApiError(
        400,
        'validation_error',
        'X-Workspace-Id must be a valid UUID.',
      );
    }
  }

  private async requireWorkspace(
    client: Pick<Prisma.TransactionClient, 'workspace'> | PrismaService,
    workspaceId: string,
  ): Promise<void> {
    const workspace = await client.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true },
    });
    if (!workspace) {
      throw new ApiError(
        404,
        'resource_not_found',
        'The workspace was not found.',
      );
    }
  }

  private async requireStage(
    client: Pick<Prisma.TransactionClient, 'stage'> | PrismaService,
    workspaceId: string,
    stageId: string,
  ): Promise<void> {
    const stage = await client.stage.findFirst({
      where: { id: stageId, workspaceId },
      select: { id: true },
    });
    if (!stage) {
      throw new ApiError(
        404,
        'resource_not_found',
        'The stage was not found in this workspace.',
      );
    }
  }

  private stageVersionConflict(): ApiError {
    return new ApiError(
      409,
      'stage_version_conflict',
      'The opportunity stage version is stale.',
    );
  }
}
