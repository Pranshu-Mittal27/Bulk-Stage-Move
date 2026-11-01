import { Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { Prisma } from '../generated/prisma/client.js';
import { BulkJobStatus } from '../generated/prisma/enums.js';
import { PrismaService } from '../database/prisma.service.js';

const defaultLeaseDurationMs = 30_000;
const minimumLeaseDurationMs = 1_000;
const maximumLeaseDurationMs = 300_000;
const maximumWorkerIdLength = 128;
const leaseTransactionTimeoutMs = 70_000;
const leaseTransactionMaxWaitMs = 10_000;

export interface BulkJobLeaseToken {
  jobId: string;
  leaseOwner: string;
  leaseGeneration: number;
}

export interface ClaimedBulkJob {
  id: string;
  workspaceId: string;
  status: typeof BulkJobStatus.running;
  leaseOwner: string;
  leaseGeneration: number;
  leaseExpiresAt: Date;
  heartbeatAt: Date;
  startedAt: Date;
}

export type ClaimBulkJobResult =
  | { kind: 'claimed'; token: BulkJobLeaseToken; job: ClaimedBulkJob }
  | { kind: 'empty' };

export type RenewBulkJobLeaseResult =
  | { kind: 'renewed'; leaseExpiresAt: Date; heartbeatAt: Date }
  | { kind: 'lease_lost' };

export type DeferBulkJobResult =
  | { kind: 'deferred' }
  | { kind: 'lease_lost' }
  | { kind: 'due_items_remain' }
  | { kind: 'no_pending_items' };

export interface BulkJobWithoutPendingItems {
  id: string;
  status: BulkJobStatus;
}

interface ClaimedBulkJobRow {
  // The PostgreSQL adapter maps TIMESTAMPTZ to Date and INTEGER to number.
  id: string;
  workspaceId: string;
  status: typeof BulkJobStatus.running;
  leaseOwner: string;
  leaseGeneration: number;
  leaseExpiresAt: Date;
  heartbeatAt: Date;
  startedAt: Date;
}

interface RenewedLeaseRow {
  leaseExpiresAt: Date;
  heartbeatAt: Date;
}

interface CurrentLeaseRow {
  status: string;
  leaseOwner: string | null;
  leaseGeneration: number;
}

interface PendingItemClassificationRow {
  pendingCount: number;
  dueCount: number;
  earliestPendingAt: Date | null;
}

interface UpdatedJobRow {
  id: string;
}

export function parseLeaseDurationMs(value: string | undefined): number {
  if (value === undefined) {
    return defaultLeaseDurationMs;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error(
      'BULK_JOB_LEASE_DURATION_MS must be an integer number of milliseconds.',
    );
  }

  const durationMs = Number(value);
  if (
    !Number.isSafeInteger(durationMs) ||
    durationMs < minimumLeaseDurationMs ||
    durationMs > maximumLeaseDurationMs
  ) {
    throw new Error(
      `BULK_JOB_LEASE_DURATION_MS must be between ${minimumLeaseDurationMs} and ${maximumLeaseDurationMs}.`,
    );
  }
  return durationMs;
}

function validateWorkerId(workerId: string): string {
  if (
    typeof workerId !== 'string' ||
    workerId.trim().length === 0 ||
    workerId.length > maximumWorkerIdLength
  ) {
    throw new TypeError(
      `Worker ID must contain 1 to ${maximumWorkerIdLength} characters.`,
    );
  }
  return workerId;
}

export function validateBulkJobLeaseToken(token: BulkJobLeaseToken): void {
  if (!token || !isUUID(token.jobId)) {
    throw new TypeError('Lease token job ID must be a valid UUID.');
  }
  validateWorkerId(token.leaseOwner);
  if (
    !Number.isSafeInteger(token.leaseGeneration) ||
    token.leaseGeneration < 1
  ) {
    throw new TypeError('Lease token generation must be a positive integer.');
  }
}

@Injectable()
export class BulkJobLeaseService {
  private readonly leaseDurationMs = parseLeaseDurationMs(
    process.env.BULK_JOB_LEASE_DURATION_MS,
  );

  constructor(private readonly prisma: PrismaService) {}

  async claimNext(workerId: string): Promise<ClaimBulkJobResult> {
    const leaseOwner = validateWorkerId(workerId);
    const row = await this.prisma.$transaction(
      async (transaction): Promise<ClaimedBulkJobRow | null> => {
        const candidates = await transaction.$queryRaw<{ id: string }[]>(
          Prisma.sql`
            WITH candidate_time AS MATERIALIZED (
              SELECT clock_timestamp() AS "now"
            )
            SELECT job."id" AS "id"
            FROM "BulkJob" AS job
            CROSS JOIN candidate_time
            WHERE (
              job."status" = 'queued'::"BulkJobStatus"
              OR (
                job."status" = 'running'::"BulkJobStatus"
                AND job."leaseExpiresAt" IS NOT NULL
                AND job."leaseExpiresAt" <= candidate_time."now"
              )
            )
              AND EXISTS (
                SELECT 1
                FROM "BulkJobItem" AS item
                WHERE item."jobId" = job."id"
                  AND item."status" = 'pending'::"BulkJobItemStatus"
                  AND (
                    item."nextAttemptAt" IS NULL
                    OR item."nextAttemptAt" <= candidate_time."now"
                  )
              )
            ORDER BY job."createdAt" ASC, job."id" ASC
            LIMIT 1
            FOR UPDATE OF job SKIP LOCKED
          `,
        );
        const candidate = candidates[0];
        if (!candidate) {
          return null;
        }

        const eligibility = await transaction.$queryRaw<
          { eligible: boolean }[]
        >(
          Prisma.sql`
            WITH eligibility_time AS MATERIALIZED (
              SELECT clock_timestamp() AS "now"
            )
            SELECT EXISTS (
              SELECT 1
              FROM "BulkJob" AS job
              CROSS JOIN eligibility_time
              WHERE job."id" = ${candidate.id}::uuid
                AND (
                  job."status" = 'queued'::"BulkJobStatus"
                  OR (
                    job."status" = 'running'::"BulkJobStatus"
                    AND job."leaseExpiresAt" IS NOT NULL
                    AND job."leaseExpiresAt" <= eligibility_time."now"
                  )
                )
                AND EXISTS (
                  SELECT 1
                  FROM "BulkJobItem" AS item
                  WHERE item."jobId" = job."id"
                    AND item."status" = 'pending'::"BulkJobItemStatus"
                    AND (
                      item."nextAttemptAt" IS NULL
                      OR item."nextAttemptAt" <= eligibility_time."now"
                    )
                )
            ) AS "eligible"
          `,
        );
        if (!eligibility[0]?.eligible) {
          return null;
        }

        const claimed = await transaction.$queryRaw<ClaimedBulkJobRow[]>(
          Prisma.sql`
            WITH claim_time AS MATERIALIZED (
              SELECT clock_timestamp() AS "now"
            )
            UPDATE "BulkJob" AS job
            SET
              "status" = 'running'::"BulkJobStatus",
              "leaseOwner" = ${leaseOwner},
              "leaseExpiresAt" = claim_time."now"
                + (${this.leaseDurationMs} * INTERVAL '1 millisecond'),
              "heartbeatAt" = claim_time."now",
              "leaseGeneration" = job."leaseGeneration" + 1,
              "startedAt" = COALESCE(job."startedAt", claim_time."now"),
              "nextAttemptAt" = NULL
            FROM claim_time
            WHERE job."id" = ${candidate.id}::uuid
              AND (
                job."status" = 'queued'::"BulkJobStatus"
                OR (
                  job."status" = 'running'::"BulkJobStatus"
                  AND job."leaseExpiresAt" IS NOT NULL
                  AND job."leaseExpiresAt" <= claim_time."now"
                )
              )
              AND EXISTS (
                SELECT 1
                FROM "BulkJobItem" AS item
                WHERE item."jobId" = job."id"
                  AND item."status" = 'pending'::"BulkJobItemStatus"
                  AND (
                    item."nextAttemptAt" IS NULL
                    OR item."nextAttemptAt" <= claim_time."now"
                  )
              )
            RETURNING
              job."id" AS "id",
              job."workspaceId" AS "workspaceId",
              job."status" AS "status",
              job."leaseOwner" AS "leaseOwner",
              job."leaseGeneration" AS "leaseGeneration",
              job."leaseExpiresAt" AS "leaseExpiresAt",
              job."heartbeatAt" AS "heartbeatAt",
              job."startedAt" AS "startedAt"
          `,
        );
        return claimed[0] ?? null;
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: leaseTransactionMaxWaitMs,
        timeout: leaseTransactionTimeoutMs,
      },
    );

    if (!row) {
      return { kind: 'empty' };
    }

    const job: ClaimedBulkJob = {
      id: row.id,
      workspaceId: row.workspaceId,
      status: row.status,
      leaseOwner: row.leaseOwner,
      leaseGeneration: row.leaseGeneration,
      leaseExpiresAt: row.leaseExpiresAt,
      heartbeatAt: row.heartbeatAt,
      startedAt: row.startedAt,
    };
    return {
      kind: 'claimed',
      job,
      token: {
        jobId: job.id,
        leaseOwner: job.leaseOwner,
        leaseGeneration: job.leaseGeneration,
      },
    };
  }

  async renew(token: BulkJobLeaseToken): Promise<RenewBulkJobLeaseResult> {
    validateBulkJobLeaseToken(token);
    return this.prisma.$transaction(
      async (transaction) => {
        const currentJobs = await transaction.$queryRaw<CurrentLeaseRow[]>(
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
        const current = currentJobs[0];
        if (
          !current ||
          current.status !== BulkJobStatus.running ||
          current.leaseOwner !== token.leaseOwner ||
          current.leaseGeneration !== token.leaseGeneration
        ) {
          return { kind: 'lease_lost' };
        }

        const validity = await transaction.$queryRaw<{ valid: boolean }[]>(
          Prisma.sql`
          SELECT "leaseExpiresAt" > clock_timestamp() AS "valid"
          FROM "BulkJob"
          WHERE "id" = ${token.jobId}::uuid
        `,
        );
        if (!validity[0]?.valid) {
          return { kind: 'lease_lost' };
        }

        const renewedRows = await transaction.$queryRaw<RenewedLeaseRow[]>(
          Prisma.sql`
          UPDATE "BulkJob" AS job
          SET
            "leaseExpiresAt" = clock_timestamp()
              + (${this.leaseDurationMs} * INTERVAL '1 millisecond'),
            "heartbeatAt" = clock_timestamp()
          WHERE job."id" = ${token.jobId}::uuid
            AND job."leaseOwner" = ${token.leaseOwner}
            AND job."leaseGeneration" = ${token.leaseGeneration}
            AND job."status" = 'running'::"BulkJobStatus"
            AND job."leaseExpiresAt" > clock_timestamp()
          RETURNING
            job."leaseExpiresAt" AS "leaseExpiresAt",
            job."heartbeatAt" AS "heartbeatAt"
        `,
        );
        const renewed = renewedRows[0];
        if (!renewed) {
          return { kind: 'lease_lost' };
        }
        return {
          kind: 'renewed',
          leaseExpiresAt: renewed.leaseExpiresAt,
          heartbeatAt: renewed.heartbeatAt,
        };
      },
      {
        maxWait: leaseTransactionMaxWaitMs,
        timeout: leaseTransactionTimeoutMs,
      },
    );
  }

  async deferIfNoDueItems(
    token: BulkJobLeaseToken,
  ): Promise<DeferBulkJobResult> {
    validateBulkJobLeaseToken(token);
    return this.prisma.$transaction(
      async (transaction): Promise<DeferBulkJobResult> => {
        const currentJobs = await transaction.$queryRaw<CurrentLeaseRow[]>(
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
        const current = currentJobs[0];
        if (
          !current ||
          current.status !== BulkJobStatus.running ||
          current.leaseOwner !== token.leaseOwner ||
          current.leaseGeneration !== token.leaseGeneration
        ) {
          return { kind: 'lease_lost' };
        }

        const validity = await transaction.$queryRaw<{ valid: boolean }[]>(
          Prisma.sql`
            SELECT "leaseExpiresAt" > clock_timestamp() AS "valid"
            FROM "BulkJob"
            WHERE "id" = ${token.jobId}::uuid
          `,
        );
        if (!validity[0]?.valid) {
          return { kind: 'lease_lost' };
        }

        const classifications = await transaction.$queryRaw<
          PendingItemClassificationRow[]
        >(
          Prisma.sql`
              WITH classification_time AS MATERIALIZED (
                SELECT clock_timestamp() AS "now"
              )
              SELECT
                COUNT(*)::int AS "pendingCount",
                COUNT(*) FILTER (
                  WHERE item."nextAttemptAt" IS NULL
                    OR item."nextAttemptAt" <= classification_time."now"
                )::int AS "dueCount",
                MIN(item."nextAttemptAt") AS "earliestPendingAt"
              FROM "BulkJobItem" AS item
              CROSS JOIN classification_time
              WHERE item."jobId" = ${token.jobId}::uuid
                AND item."status" = 'pending'::"BulkJobItemStatus"
            `,
        );
        const classification = classifications[0];
        if (!classification || classification.pendingCount === 0) {
          return { kind: 'no_pending_items' };
        }
        if (classification.dueCount > 0) {
          return { kind: 'due_items_remain' };
        }
        if (classification.earliestPendingAt === null) {
          throw new Error(
            'Future-only pending items must have a non-null nextAttemptAt.',
          );
        }

        const updated = await transaction.$queryRaw<UpdatedJobRow[]>(
          Prisma.sql`
            UPDATE "BulkJob"
            SET
              "status" = 'queued'::"BulkJobStatus",
              "nextAttemptAt" = ${classification.earliestPendingAt},
              "leaseOwner" = NULL,
              "leaseExpiresAt" = NULL
            WHERE "id" = ${token.jobId}::uuid
              AND "status" = 'running'::"BulkJobStatus"
              AND "leaseOwner" = ${token.leaseOwner}
              AND "leaseGeneration" = ${token.leaseGeneration}
              AND "leaseExpiresAt" > clock_timestamp()
            RETURNING "id" AS "id"
          `,
        );
        if (updated.length !== 1) {
          return { kind: 'lease_lost' };
        }

        return { kind: 'deferred' };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: leaseTransactionMaxWaitMs,
        timeout: leaseTransactionTimeoutMs,
      },
    );
  }

  async findJobsWithoutPendingItems(): Promise<BulkJobWithoutPendingItems[]> {
    return this.prisma.$queryRaw<BulkJobWithoutPendingItems[]>(
      Prisma.sql`
        SELECT job."id" AS "id", job."status" AS "status"
        FROM "BulkJob" AS job
        WHERE job."status" IN (
          'queued'::"BulkJobStatus",
          'running'::"BulkJobStatus"
        )
          AND NOT EXISTS (
            SELECT 1
            FROM "BulkJobItem" AS item
            WHERE item."jobId" = job."id"
              AND item."status" = 'pending'::"BulkJobItemStatus"
          )
        ORDER BY job."createdAt" ASC, job."id" ASC
        LIMIT 20
      `,
    );
  }
}
