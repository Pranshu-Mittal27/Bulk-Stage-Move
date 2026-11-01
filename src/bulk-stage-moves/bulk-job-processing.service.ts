import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import {
  BulkJobItemStatus,
  BulkJobStatus,
  TransitionSource,
} from '../generated/prisma/enums.js';
import { PrismaService } from '../database/prisma.service.js';
import {
  type BulkJobLeaseToken,
  validateBulkJobLeaseToken,
} from './bulk-job-lease.service.js';

const defaultBatchSize = 100;
const minimumBatchSize = 1;
const maximumBatchSize = 500;
const defaultRetryBackoffMs = 30_000;
const minimumRetryBackoffMs = 1_000;
const maximumRetryBackoffMs = 3_600_000;
const transactionTimeoutMs = 60_000;
const transactionMaxWaitMs = 10_000;

interface LockedBulkJobRow {
  id: string;
  workspaceId: string;
  status: BulkJobStatus;
  leaseOwner: string | null;
  leaseGeneration: number;
  targetStageId: string;
  matchedCount: number;
  processedCount: number;
  movedCount: number;
  skippedCount: number;
  failedCount: number;
}

interface DatabaseBooleanRow {
  valid: boolean;
}

interface PendingBulkJobItemRow {
  itemId: bigint;
  workspaceId: string;
  opportunityId: string;
  expectedStageId: string;
  expectedStageVersion: number;
  attemptCount: number;
}

interface LockedOpportunityRow {
  id: string;
  workspaceId: string;
  stageId: string;
  stageVersion: number;
}

interface UpdatedBulkJobRow {
  status: BulkJobStatus;
  processedCount: number;
  movedCount: number;
  skippedCount: number;
  failedCount: number;
  matchedCount: number;
}

interface LeaseOwnershipRow {
  status: BulkJobStatus;
  leaseOwner: string | null;
  leaseGeneration: number;
}

export type RetryMetadataStatus =
  'recorded' | 'lease_lost' | 'item_not_pending' | 'failed';

export class RetryableBulkJobProcessingError extends Error {
  constructor(
    readonly itemId: bigint,
    readonly retryMetadataStatus: RetryMetadataStatus,
    originalError: unknown,
    readonly retryMetadataError?: unknown,
  ) {
    super(`A retryable conflict occurred while processing item ${itemId}.`, {
      cause: originalError,
    });
    this.name = 'RetryableBulkJobProcessingError';
  }
}

export type ProcessBulkJobBatchResult =
  | { kind: 'lease_lost' }
  | { kind: 'no_due_pending_items' }
  | {
      kind: 'processed';
      batchProcessedCount: number;
      movedCount: number;
      skippedCount: number;
      pendingCount: number;
      status: BulkJobStatus;
    };

export function parseBatchSize(value: string | undefined): number {
  if (value === undefined) {
    return defaultBatchSize;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error('BULK_JOB_BATCH_SIZE must be an integer number of items.');
  }

  const batchSize = Number(value);
  if (
    !Number.isSafeInteger(batchSize) ||
    batchSize < minimumBatchSize ||
    batchSize > maximumBatchSize
  ) {
    throw new Error(
      `BULK_JOB_BATCH_SIZE must be between ${minimumBatchSize} and ${maximumBatchSize}.`,
    );
  }
  return batchSize;
}

export function parseRetryBackoffMs(value: string | undefined): number {
  if (value === undefined) {
    return defaultRetryBackoffMs;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(
      'BULK_JOB_RETRY_BACKOFF_MS must be an integer number of milliseconds.',
    );
  }

  const backoffMs = Number(value);
  if (
    !Number.isSafeInteger(backoffMs) ||
    backoffMs < minimumRetryBackoffMs ||
    backoffMs > maximumRetryBackoffMs
  ) {
    throw new Error(
      `BULK_JOB_RETRY_BACKOFF_MS must be between ${minimumRetryBackoffMs} and ${maximumRetryBackoffMs}.`,
    );
  }
  return backoffMs;
}

function getRetryableDatabaseErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return undefined;
  }
  if (error.code === 'P2034') {
    return 'transaction_conflict';
  }

  const adapterError = error.meta?.driverAdapterError;
  const cause =
    adapterError && typeof adapterError === 'object'
      ? (adapterError as { cause?: unknown }).cause
      : undefined;
  const causeCode =
    cause && typeof cause === 'object'
      ? (cause as { code?: unknown }).code
      : undefined;
  const sqlState =
    typeof error.meta?.code === 'string'
      ? error.meta.code
      : typeof causeCode === 'string'
        ? causeCode
        : undefined;

  if (sqlState === '40001' || sqlState === '40P01') {
    return `postgres_${sqlState.toLowerCase()}`;
  }
  return undefined;
}

@Injectable()
export class BulkJobProcessingService {
  private readonly batchSize = parseBatchSize(process.env.BULK_JOB_BATCH_SIZE);
  private readonly retryBackoffMs = parseRetryBackoffMs(
    process.env.BULK_JOB_RETRY_BACKOFF_MS,
  );

  constructor(private readonly prisma: PrismaService) {}

  /** Processes one due batch and defers recognized transient failures by a finite interval. */
  async processBatch(
    token: BulkJobLeaseToken,
  ): Promise<ProcessBulkJobBatchResult> {
    validateBulkJobLeaseToken(token);

    let activeItem: PendingBulkJobItemRow | undefined;
    try {
      return await this.prisma.$transaction(
        async (transaction): Promise<ProcessBulkJobBatchResult> => {
          const lockedJobs = await transaction.$queryRaw<LockedBulkJobRow[]>(
            Prisma.sql`
            SELECT
              "id" AS "id",
              "workspaceId" AS "workspaceId",
              "status" AS "status",
              "leaseOwner" AS "leaseOwner",
              "leaseGeneration" AS "leaseGeneration",
              "targetStageId" AS "targetStageId",
              "matchedCount" AS "matchedCount",
              "processedCount" AS "processedCount",
              "movedCount" AS "movedCount",
              "skippedCount" AS "skippedCount",
              "failedCount" AS "failedCount"
            FROM "BulkJob"
            WHERE "id" = ${token.jobId}::uuid
            FOR UPDATE
          `,
          );
          const job = lockedJobs[0];
          if (
            !job ||
            job.status !== BulkJobStatus.running ||
            job.leaseOwner !== token.leaseOwner ||
            job.leaseGeneration !== token.leaseGeneration
          ) {
            return { kind: 'lease_lost' };
          }

          const leaseValidity = await transaction.$queryRaw<
            DatabaseBooleanRow[]
          >(Prisma.sql`
            SELECT "leaseExpiresAt" > clock_timestamp() AS "valid"
            FROM "BulkJob"
            WHERE "id" = ${token.jobId}::uuid
          `);
          if (!leaseValidity[0]?.valid) {
            return { kind: 'lease_lost' };
          }

          const items = await transaction.$queryRaw<PendingBulkJobItemRow[]>(
            Prisma.sql`
            WITH selection_time AS MATERIALIZED (
              SELECT clock_timestamp() AS "now"
            )
            SELECT
              item."itemId" AS "itemId",
              item."workspaceId" AS "workspaceId",
              item."opportunityId" AS "opportunityId",
              item."expectedStageId" AS "expectedStageId",
              item."expectedStageVersion" AS "expectedStageVersion",
              item."attemptCount" AS "attemptCount"
            FROM "BulkJobItem" AS item
            CROSS JOIN selection_time
            WHERE item."jobId" = ${job.id}::uuid
              AND item."workspaceId" = ${job.workspaceId}::uuid
              AND item."status" = 'pending'::"BulkJobItemStatus"
              AND (
                item."nextAttemptAt" IS NULL
                OR item."nextAttemptAt" <= selection_time."now"
              )
            ORDER BY item."itemId" ASC
            LIMIT ${this.batchSize}
            FOR UPDATE OF item SKIP LOCKED
          `,
          );
          if (items.length === 0) {
            return { kind: 'no_due_pending_items' };
          }

          let movedCount = 0;
          let skippedCount = 0;
          const opportunityLockOrder = [...items].sort((left, right) =>
            left.opportunityId < right.opportunityId
              ? -1
              : left.opportunityId > right.opportunityId
                ? 1
                : 0,
          );

          for (const item of opportunityLockOrder) {
            activeItem = item;
            const opportunities = await transaction.$queryRaw<
              LockedOpportunityRow[]
            >(
              Prisma.sql`
                SELECT
                  "id" AS "id",
                  "workspaceId" AS "workspaceId",
                  "stageId" AS "stageId",
                  "stageVersion" AS "stageVersion"
                FROM "Opportunity"
                WHERE "workspaceId" = ${item.workspaceId}::uuid
                  AND "id" = ${item.opportunityId}::uuid
                FOR UPDATE
              `,
            );
            const opportunity = opportunities[0];
            if (!opportunity) {
              throw new Error(
                'A bulk snapshot references a missing opportunity.',
              );
            }

            let itemStatus: BulkJobItemStatus;
            let outcomeReason: string;
            if (opportunity.stageId === job.targetStageId) {
              itemStatus = BulkJobItemStatus.skipped;
              outcomeReason = 'already_at_destination';
              skippedCount += 1;
            } else if (
              opportunity.stageId !== item.expectedStageId ||
              opportunity.stageVersion !== item.expectedStageVersion
            ) {
              itemStatus = BulkJobItemStatus.skipped;
              outcomeReason = 'stale_snapshot';
              skippedCount += 1;
            } else {
              const update = await transaction.opportunity.updateMany({
                where: {
                  workspaceId: item.workspaceId,
                  id: item.opportunityId,
                  stageId: item.expectedStageId,
                  stageVersion: item.expectedStageVersion,
                },
                data: {
                  stageId: job.targetStageId,
                  stageVersion: { increment: 1 },
                  updatedAt: new Date(),
                },
              });
              if (update.count !== 1) {
                throw new Error(
                  'A locked opportunity no longer matches its bulk snapshot.',
                );
              }

              await transaction.opportunityTransition.create({
                data: {
                  workspaceId: item.workspaceId,
                  opportunityId: item.opportunityId,
                  fromStageId: item.expectedStageId,
                  toStageId: job.targetStageId,
                  source: TransitionSource.bulk,
                  operationId: job.id,
                },
              });
              itemStatus = BulkJobItemStatus.moved;
              outcomeReason = 'moved';
              movedCount += 1;
            }

            const itemUpdate = await transaction.bulkJobItem.updateMany({
              where: {
                jobId: job.id,
                itemId: item.itemId,
                status: BulkJobItemStatus.pending,
              },
              data: {
                status: itemStatus,
                attemptCount: { increment: 1 },
                nextAttemptAt: null,
                outcomeReason,
                lastErrorCode: null,
                processedAt: new Date(),
              },
            });
            if (itemUpdate.count !== 1) {
              throw new Error(
                'A selected bulk snapshot item was no longer pending.',
              );
            }
            activeItem = undefined;
          }

          const pendingItems = await transaction.bulkJobItem.count({
            where: {
              jobId: job.id,
              status: BulkJobItemStatus.pending,
            },
          });
          const batchProcessedCount = movedCount + skippedCount;
          const processedCount = job.processedCount + batchProcessedCount;
          const totalTerminalOutcomes =
            job.movedCount +
            movedCount +
            job.skippedCount +
            skippedCount +
            job.failedCount;
          if (
            processedCount > job.matchedCount ||
            totalTerminalOutcomes !== processedCount
          ) {
            throw new Error('Bulk job progress counters are inconsistent.');
          }

          const isComplete =
            pendingItems === 0 && processedCount === job.matchedCount;
          const terminalStatus =
            job.failedCount > 0
              ? BulkJobStatus.completed_with_errors
              : BulkJobStatus.completed;
          const updatedJobs = await transaction.$queryRaw<UpdatedBulkJobRow[]>(
            Prisma.sql`
            UPDATE "BulkJob"
            SET
              "processedCount" = "processedCount" + ${batchProcessedCount},
              "movedCount" = "movedCount" + ${movedCount},
              "skippedCount" = "skippedCount" + ${skippedCount},
              "lastProgressAt" = clock_timestamp(),
              "status" = CASE
                WHEN ${isComplete} THEN ${terminalStatus}::"BulkJobStatus"
                ELSE "status"
              END,
              "completedAt" = CASE
                WHEN ${isComplete} THEN clock_timestamp()
                ELSE "completedAt"
              END,
              "leaseOwner" = CASE
                WHEN ${isComplete} THEN NULL
                ELSE "leaseOwner"
              END,
              "leaseExpiresAt" = CASE
                WHEN ${isComplete} THEN NULL
                ELSE "leaseExpiresAt"
              END
            WHERE "id" = ${job.id}::uuid
              AND "status" = 'running'::"BulkJobStatus"
              AND "leaseOwner" = ${token.leaseOwner}
              AND "leaseGeneration" = ${token.leaseGeneration}
            RETURNING
              "status" AS "status",
              "processedCount" AS "processedCount",
              "movedCount" AS "movedCount",
              "skippedCount" AS "skippedCount",
              "failedCount" AS "failedCount",
              "matchedCount" AS "matchedCount"
          `,
          );
          const updatedJob = updatedJobs[0];
          if (!updatedJob) {
            throw new Error(
              'The bulk job lease changed during batch processing.',
            );
          }

          return {
            kind: 'processed',
            batchProcessedCount,
            movedCount,
            skippedCount,
            pendingCount: updatedJob.matchedCount - updatedJob.processedCount,
            status: updatedJob.status,
          };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          maxWait: transactionMaxWaitMs,
          timeout: transactionTimeoutMs,
        },
      );
    } catch (error) {
      const errorCode = getRetryableDatabaseErrorCode(error);
      if (activeItem && errorCode) {
        let metadataStatus: RetryMetadataStatus;
        let metadataError: unknown;
        try {
          metadataStatus = await this.recordRetryableAttempt(
            token,
            activeItem.itemId,
            activeItem.attemptCount,
            errorCode,
          );
        } catch (recordingError) {
          metadataStatus = 'failed';
          metadataError = recordingError;
        }
        throw new RetryableBulkJobProcessingError(
          activeItem.itemId,
          metadataStatus,
          error,
          metadataError,
        );
      }
      throw error;
    }
  }

  protected async recordRetryableAttempt(
    token: BulkJobLeaseToken,
    itemId: bigint,
    previousAttemptCount: number,
    errorCode: string,
  ): Promise<RetryMetadataStatus> {
    return this.prisma.$transaction(
      async (transaction) => {
        const jobs = await transaction.$queryRaw<LeaseOwnershipRow[]>(
          Prisma.sql`
            SELECT
              "status" AS "status",
              "leaseOwner" AS "leaseOwner",
              "leaseGeneration" AS "leaseGeneration"
            FROM "BulkJob"
            WHERE "id" = ${token.jobId}::uuid
            FOR UPDATE
          `,
        );
        const job = jobs[0];
        if (
          !job ||
          job.status !== BulkJobStatus.running ||
          job.leaseOwner !== token.leaseOwner ||
          job.leaseGeneration !== token.leaseGeneration
        ) {
          return 'lease_lost';
        }

        const validity = await transaction.$queryRaw<{ valid: boolean }[]>(
          Prisma.sql`
            SELECT "leaseExpiresAt" > clock_timestamp() AS "valid"
            FROM "BulkJob"
            WHERE "id" = ${token.jobId}::uuid
          `,
        );
        if (!validity[0]?.valid) {
          return 'lease_lost';
        }

        const updatedItems = await transaction.$queryRaw<{ itemId: bigint }[]>(
          Prisma.sql`
            UPDATE "BulkJobItem" AS item
            SET
              "attemptCount" = item."attemptCount" + 1,
              "lastErrorCode" = ${errorCode},
              "nextAttemptAt" = clock_timestamp()
                + (${this.retryBackoffMs} * INTERVAL '1 millisecond')
            WHERE item."jobId" = ${token.jobId}::uuid
              AND item."itemId" = ${itemId}
              AND item."status" = 'pending'::"BulkJobItemStatus"
              AND item."attemptCount" = ${previousAttemptCount}
              AND item."attemptCount" < 2147483647
              AND EXISTS (
                SELECT 1
                FROM "BulkJob" AS job
                WHERE job."id" = item."jobId"
                  AND job."status" = 'running'::"BulkJobStatus"
                  AND job."leaseOwner" = ${token.leaseOwner}
                  AND job."leaseGeneration" = ${token.leaseGeneration}
                  AND job."leaseExpiresAt" > clock_timestamp()
              )
            RETURNING item."itemId" AS "itemId"
          `,
        );
        if (updatedItems.length === 1) {
          return 'recorded';
        }

        const stillValid = await transaction.$queryRaw<
          { valid: boolean }[]
        >(Prisma.sql`
          SELECT "leaseExpiresAt" > clock_timestamp() AS "valid"
          FROM "BulkJob"
          WHERE "id" = ${token.jobId}::uuid
        `);
        return stillValid[0]?.valid ? 'item_not_pending' : 'lease_lost';
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: transactionMaxWaitMs,
        timeout: transactionTimeoutMs,
      },
    );
  }
}
