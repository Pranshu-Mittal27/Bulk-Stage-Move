import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { Prisma } from '../generated/prisma/client.js';
import {
  BulkJobHealthStatus,
  BulkJobItemStatus,
  BulkJobStatus,
  OpportunityStatus,
} from '../generated/prisma/enums.js';
import { ApiError } from '../common/api-error.js';
import { PrismaService } from '../database/prisma.service.js';
import type { BulkStageMoveResponseDto } from './dto/bulk-stage-move-response.dto.js';
import type {
  BulkOpportunityFilterDto,
  SubmitBulkStageMoveDto,
} from './dto/submit-bulk-stage-move.dto.js';

const maximumIdempotencyKeyLength = 128;
const maximumMatchedOpportunities = 50_000;

interface NormalizedFilter {
  stageId: string | null;
  ownerId: string | null;
  status: OpportunityStatus | null;
  valueRange: {
    min: string | null;
    max: string | null;
  };
  createdAt: {
    from: string | null;
    to: string | null;
  };
}

function normalizeDecimal(value: string | undefined): string | null {
  return value === undefined ? null : new Prisma.Decimal(value).toFixed(4);
}

function normalizeTimestamp(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const fraction = /T\d{2}:\d{2}:\d{2}\.(\d+)/.exec(value)?.[1] ?? '';
  let microseconds = Number(fraction.padEnd(6, '0').slice(0, 6));
  const date = new Date(value);
  if (fraction.length > 6 && fraction[6]! >= '5') {
    microseconds += 1;
  }
  if (microseconds === 1_000_000) {
    date.setTime(date.getTime() + 1);
    microseconds = 0;
  }
  return date
    .toISOString()
    .replace(/\.\d{3}Z$/, `.${microseconds.toString().padStart(6, '0')}Z`);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
  return `{${entries.join(',')}}`;
}

function normalizeFilter(
  filter: BulkOpportunityFilterDto | undefined,
): NormalizedFilter {
  return {
    stageId: filter?.stageId?.toLowerCase() ?? null,
    ownerId: filter?.ownerId?.toLowerCase() ?? null,
    status: filter?.status ?? null,
    valueRange: {
      min: normalizeDecimal(filter?.valueRange?.min),
      max: normalizeDecimal(filter?.valueRange?.max),
    },
    createdAt: {
      from: normalizeTimestamp(filter?.createdAt?.from),
      to: normalizeTimestamp(filter?.createdAt?.to),
    },
  };
}

function buildSnapshotPredicates(
  workspaceId: string,
  filter: NormalizedFilter,
): Prisma.Sql[] {
  const predicates = [
    Prisma.sql`opportunity."workspaceId" = ${workspaceId}::uuid`,
  ];
  if (filter.stageId) {
    predicates.push(
      Prisma.sql`opportunity."stageId" = ${filter.stageId}::uuid`,
    );
  }
  if (filter.ownerId) {
    predicates.push(
      Prisma.sql`opportunity."ownerId" = ${filter.ownerId}::uuid`,
    );
  }
  if (filter.status) {
    predicates.push(
      Prisma.sql`opportunity."status" = ${filter.status}::"OpportunityStatus"`,
    );
  }
  if (filter.valueRange.min) {
    predicates.push(
      Prisma.sql`opportunity."value" >= ${new Prisma.Decimal(filter.valueRange.min)}`,
    );
  }
  if (filter.valueRange.max) {
    predicates.push(
      Prisma.sql`opportunity."value" <= ${new Prisma.Decimal(filter.valueRange.max)}`,
    );
  }
  if (filter.createdAt.from) {
    predicates.push(
      Prisma.sql`opportunity."createdAt" >= ${filter.createdAt.from}::timestamptz`,
    );
  }
  if (filter.createdAt.to) {
    predicates.push(
      Prisma.sql`opportunity."createdAt" < ${filter.createdAt.to}::timestamptz`,
    );
  }
  return predicates;
}

function toResponse(job: {
  id: string;
  status: BulkJobStatus;
  healthStatus: BulkJobHealthStatus;
  targetStageId: string;
  matchedCount: number;
  processedCount: number;
  movedCount: number;
  skippedCount: number;
  failedCount: number;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  heartbeatAt: Date | null;
  lastProgressAt: Date | null;
  failureCode: string | null;
  failureMessage: string | null;
}): BulkStageMoveResponseDto {
  return {
    id: job.id,
    status: job.status,
    health: job.healthStatus,
    targetStageId: job.targetStageId,
    matchedCount: job.matchedCount,
    processedCount: job.processedCount,
    movedCount: job.movedCount,
    skippedCount: job.skippedCount,
    failedCount: job.failedCount,
    pendingCount: job.matchedCount - job.processedCount,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    heartbeatAt: job.heartbeatAt?.toISOString() ?? null,
    lastProgressAt: job.lastProgressAt?.toISOString() ?? null,
    failureCode:
      job.failureCode && /^[a-z0-9_-]{1,64}$/i.test(job.failureCode)
        ? job.failureCode
        : null,
    failureMessage: job.failureMessage
      ? 'The job failed. Refer to the failure code or contact support.'
      : null,
    waitingReason: null,
  };
}

function isIdempotencyUniqueConflict(error: unknown): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== 'P2002'
  ) {
    return false;
  }

  const adapterError = error.meta?.driverAdapterError;
  if (!adapterError || typeof adapterError !== 'object') {
    return false;
  }
  const cause = (adapterError as { cause?: unknown }).cause;
  if (!cause || typeof cause !== 'object') {
    return false;
  }
  const constraint = (cause as { constraint?: unknown }).constraint;
  if (!constraint || typeof constraint !== 'object') {
    return false;
  }
  return (
    (constraint as { index?: unknown }).index ===
    'BulkJob_workspaceId_idempotencyKey_key'
  );
}

@Injectable()
export class BulkStageMovesService {
  constructor(private readonly prisma: PrismaService) {}

  async submit(
    workspaceId: string,
    idempotencyHeader: string | undefined,
    input: SubmitBulkStageMoveDto,
  ): Promise<{ statusCode: 200 | 202; job: BulkStageMoveResponseDto }> {
    this.validateWorkspaceId(workspaceId);
    const idempotencyKey = this.validateIdempotencyKey(idempotencyHeader);
    const normalizedWorkspaceId = workspaceId.toLowerCase();
    const normalizedTargetStageId = input.targetStageId.toLowerCase();
    const filter = normalizeFilter(input.filter);
    const normalizedRequest = {
      apiVersion: 1,
      workspaceId: normalizedWorkspaceId,
      targetStageId: normalizedTargetStageId,
      filter: {
        stageId: filter.stageId,
        ownerId: filter.ownerId,
        status: filter.status,
        valueRange: {
          min: filter.valueRange.min,
          max: filter.valueRange.max,
        },
        createdAt: {
          from: filter.createdAt.from,
          to: filter.createdAt.to,
        },
      },
    } satisfies Prisma.InputJsonObject;
    const canonicalRequest = canonicalJson(normalizedRequest);
    const canonicalRequestHash = createHash('sha256')
      .update(canonicalRequest)
      .digest('hex');

    try {
      const job = await this.prisma.$transaction(
        async (transaction) => {
          await this.requireWorkspace(transaction, normalizedWorkspaceId);
          await this.requireTargetStage(
            transaction,
            normalizedWorkspaceId,
            normalizedTargetStageId,
          );

          const created = await transaction.bulkJob.create({
            data: {
              workspaceId: normalizedWorkspaceId,
              idempotencyKey,
              canonicalRequestHash,
              normalizedRequest,
              targetStageId: normalizedTargetStageId,
              status: BulkJobStatus.queued,
              healthStatus: BulkJobHealthStatus.healthy,
            },
          });

          const predicates = buildSnapshotPredicates(
            normalizedWorkspaceId,
            filter,
          );
          const snapshotRows = await transaction.$queryRaw<
            { matchedCount: string; insertedCount: string }[]
          >(Prisma.sql`
            WITH matching AS MATERIALIZED (
              SELECT
                opportunity."workspaceId",
                opportunity."id",
                opportunity."stageId",
                opportunity."stageVersion"
              FROM "Opportunity" AS opportunity
              WHERE ${Prisma.join(predicates, ' AND ')}
              LIMIT 50001
            ),
            matched AS MATERIALIZED (
              SELECT COUNT(*)::text AS "matchedCount"
              FROM matching
            ),
            inserted AS (
              INSERT INTO "BulkJobItem" (
                  "jobId",
                  "workspaceId",
                  "opportunityId",
                  "expectedStageId",
                  "expectedStageVersion",
                  "status"
                )
                SELECT
                  ${created.id}::uuid,
                  matching."workspaceId",
                  matching."id",
                  matching."stageId",
                  matching."stageVersion",
                  ${BulkJobItemStatus.pending}::"BulkJobItemStatus"
                FROM matching
                WHERE (
                  SELECT "matchedCount"::bigint
                  FROM matched
                ) <= 50000
              )
              SELECT
                matched."matchedCount",
                CASE
                  WHEN matched."matchedCount"::bigint <= 50000
                    THEN matched."matchedCount"
                  ELSE '0'
                END AS "insertedCount"
              FROM matched
          `);
          const snapshot = snapshotRows[0]!;
          const matchedCount = BigInt(snapshot.matchedCount);
          if (matchedCount > BigInt(maximumMatchedOpportunities)) {
            throw new ApiError(
              422,
              'validation_failed',
              `The filter matches more than ${maximumMatchedOpportunities} opportunities.`,
            );
          }

          const count = Number(matchedCount);
          const insertedCount = BigInt(snapshot.insertedCount);
          if (insertedCount !== matchedCount) {
            throw new Error(
              'Bulk job snapshot count did not match the transaction count.',
            );
          }

          const completedAt = count === 0 ? new Date() : undefined;
          const jobWithCount = await transaction.bulkJob.update({
            where: { id: created.id },
            data: {
              matchedCount: count,
              ...(completedAt
                ? { status: BulkJobStatus.completed, completedAt }
                : {}),
            },
          });

          return jobWithCount;
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
          maxWait: 10_000,
          timeout: 60_000,
        },
      );

      return { statusCode: 202, job: toResponse(job) };
    } catch (error) {
      if (!isIdempotencyUniqueConflict(error)) {
        throw error;
      }

      const existing = await this.prisma.bulkJob.findUnique({
        where: {
          workspaceId_idempotencyKey: {
            workspaceId: normalizedWorkspaceId,
            idempotencyKey,
          },
        },
      });
      if (!existing) {
        throw error;
      }
      if (
        existing.canonicalRequestHash !== canonicalRequestHash ||
        canonicalJson(existing.normalizedRequest) !== canonicalRequest
      ) {
        throw new ApiError(
          409,
          'idempotency_key_reused',
          'The idempotency key was already used for a different request.',
        );
      }
      return { statusCode: 200, job: toResponse(existing) };
    }
  }

  async get(
    workspaceId: string,
    jobId: string,
  ): Promise<BulkStageMoveResponseDto> {
    this.validateWorkspaceId(workspaceId);
    if (!isUUID(jobId)) {
      throw new ApiError(
        400,
        'validation_error',
        'The job ID must be a valid UUID.',
      );
    }

    await this.requireWorkspace(this.prisma, workspaceId.toLowerCase());
    const job = await this.prisma.bulkJob.findFirst({
      where: {
        id: jobId.toLowerCase(),
        workspaceId: workspaceId.toLowerCase(),
      },
    });
    if (!job) {
      throw new ApiError(404, 'resource_not_found', 'The job was not found.');
    }
    return toResponse(job);
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

  private validateIdempotencyKey(value: string | undefined): string {
    const key = value?.trim();
    if (!key || key.length > maximumIdempotencyKeyLength) {
      throw new ApiError(
        400,
        'validation_error',
        `Idempotency-Key must contain 1 to ${maximumIdempotencyKeyLength} characters.`,
      );
    }
    return key;
  }

  private async requireWorkspace(
    client:
      Prisma.TransactionClient | Pick<Prisma.TransactionClient, 'workspace'>,
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

  private async requireTargetStage(
    client: Prisma.TransactionClient,
    workspaceId: string,
    targetStageId: string,
  ): Promise<void> {
    const stage = await client.stage.findFirst({
      where: { id: targetStageId, workspaceId },
      select: { id: true },
    });
    if (!stage) {
      throw new ApiError(
        404,
        'resource_not_found',
        'The target stage was not found in this workspace.',
      );
    }
  }
}
