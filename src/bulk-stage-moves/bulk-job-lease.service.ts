import { Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { Prisma } from '../generated/prisma/client.js';
import { BulkJobStatus } from '../generated/prisma/enums.js';
import { PrismaService } from '../database/prisma.service.js';

const defaultLeaseDurationMs = 30_000;
const minimumLeaseDurationMs = 1_000;
const maximumLeaseDurationMs = 300_000;
const maximumWorkerIdLength = 128;

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

function validateToken(token: BulkJobLeaseToken): void {
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
    const rows = await this.prisma.$queryRaw<ClaimedBulkJobRow[]>(
      Prisma.sql`
        WITH claim_time AS MATERIALIZED (
          SELECT clock_timestamp() AS "now"
        ),
        candidate AS MATERIALIZED (
          SELECT job."id", claim_time."now"
          FROM "BulkJob" AS job
          CROSS JOIN claim_time
          WHERE (
            job."status" = 'queued'::"BulkJobStatus"
            AND (
              job."nextAttemptAt" IS NULL
              OR job."nextAttemptAt" <= claim_time."now"
            )
          ) OR (
            job."status" = 'running'::"BulkJobStatus"
            AND job."leaseExpiresAt" IS NOT NULL
            AND job."leaseExpiresAt" <= claim_time."now"
          )
          ORDER BY job."createdAt" ASC, job."id" ASC
          FOR UPDATE OF job SKIP LOCKED
          LIMIT 1
        )
        UPDATE "BulkJob" AS job
        SET
          "status" = 'running'::"BulkJobStatus",
          "leaseOwner" = ${leaseOwner},
          "leaseExpiresAt" = candidate."now"
            + (${this.leaseDurationMs} * INTERVAL '1 millisecond'),
          "heartbeatAt" = candidate."now",
          "leaseGeneration" = job."leaseGeneration" + 1,
          "startedAt" = COALESCE(job."startedAt", candidate."now")
        FROM candidate
        WHERE job."id" = candidate."id"
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

    const row = rows[0];
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
    validateToken(token);
    const rows = await this.prisma.$queryRaw<RenewedLeaseRow[]>(
      Prisma.sql`
        WITH renewal_time AS MATERIALIZED (
          SELECT clock_timestamp() AS "now"
        )
        UPDATE "BulkJob" AS job
        SET
          "leaseExpiresAt" = renewal_time."now"
            + (${this.leaseDurationMs} * INTERVAL '1 millisecond'),
          "heartbeatAt" = renewal_time."now"
        FROM renewal_time
        WHERE job."id" = ${token.jobId}::uuid
          AND job."leaseOwner" = ${token.leaseOwner}
          AND job."leaseGeneration" = ${token.leaseGeneration}
          AND job."status" = 'running'::"BulkJobStatus"
          AND job."leaseExpiresAt" > renewal_time."now"
        RETURNING
          job."leaseExpiresAt" AS "leaseExpiresAt",
          job."heartbeatAt" AS "heartbeatAt"
      `,
    );

    const renewed = rows[0];
    if (!renewed) {
      return { kind: 'lease_lost' };
    }
    return {
      kind: 'renewed',
      leaseExpiresAt: renewed.leaseExpiresAt,
      heartbeatAt: renewed.heartbeatAt,
    };
  }
}
