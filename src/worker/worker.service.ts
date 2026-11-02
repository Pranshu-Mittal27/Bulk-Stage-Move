import { Injectable, Logger } from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import {
  BulkJobLeaseService,
  type ClaimBulkJobResult,
  type BulkJobLeaseToken,
} from '../bulk-stage-moves/bulk-job-lease.service.js';
import {
  type ProcessBulkJobBatchResult,
  BulkJobProcessingService,
  RetryableBulkJobProcessingError,
} from '../bulk-stage-moves/bulk-job-processing.service.js';
import { BulkJobStatus } from '../generated/prisma/enums.js';
import type { WorkerConfig } from './worker.config.js';

const maximumClaimBackoffMs = 30_000;
const jitterRatio = 0.2;
const anomalyDiagnosticIntervalMs = 60_000;
const maximumBatchesPerClaim = 5;

@Injectable()
export class BulkJobWorkerService {
  private readonly logger = new Logger(BulkJobWorkerService.name);
  private readonly shutdownController = new AbortController();
  private shutdownRequested = false;
  private lastAnomalyDiagnosticAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly leases: BulkJobLeaseService,
    private readonly processing: BulkJobProcessingService,
    private readonly config: WorkerConfig,
  ) {}

  requestShutdown(): void {
    if (this.shutdownRequested) {
      return;
    }
    this.shutdownRequested = true;
    this.shutdownController.abort();
    this.log('shutdown_requested');
  }

  async run(): Promise<void> {
    let consecutiveClaimFailures = 0;
    this.log('worker_started');

    while (!this.shutdownRequested) {
      await this.runAnomalyDiagnosticIfDue();
      if (this.shutdownRequested) {
        break;
      }

      let claim: ClaimBulkJobResult;
      try {
        claim = await this.leases.claimNext(this.config.workerId);
        consecutiveClaimFailures = 0;
      } catch (error) {
        consecutiveClaimFailures += 1;
        this.log('claim_failed', {
          errorName: error instanceof Error ? error.name : 'UnknownError',
          consecutiveFailures: consecutiveClaimFailures,
        });
        const backoffMs = Math.min(
          maximumClaimBackoffMs,
          this.config.pollIntervalMs *
            2 ** Math.min(consecutiveClaimFailures - 1, 10),
        );
        await this.waitWithJitter(backoffMs);
        continue;
      }

      if (this.shutdownRequested) {
        break;
      }
      if (claim.kind === 'empty') {
        await this.waitWithJitter(this.config.pollIntervalMs);
        continue;
      }

      this.log('job_claimed', {
        jobId: claim.job.id,
        leaseGeneration: claim.token.leaseGeneration,
      });
      await this.processClaim(claim.token);
    }

    this.log('worker_stopped');
  }

  private async processClaim(token: BulkJobLeaseToken): Promise<void> {
    const renewalIntervalMs = this.config.leaseDurationMs / 3;
    let lastRenewalAt = performance.now();
    let quantumAttempts = 0;

    while (!this.shutdownRequested) {
      await this.runAnomalyDiagnosticIfDue();
      if (this.shutdownRequested) {
        return;
      }

      let result: ProcessBulkJobBatchResult;
      try {
        result = await this.processing.processBatch(token);
      } catch (error) {
        if (error instanceof RetryableBulkJobProcessingError) {
          quantumAttempts += 1;
          this.log('retryable_batch_error', {
            jobId: token.jobId,
            itemId: error.itemId.toString(),
            retryMetadataStatus: error.retryMetadataStatus,
          });
          if (
            error.retryMetadataStatus !== 'recorded' ||
            this.shutdownRequested
          ) {
            return;
          }
          if (quantumAttempts >= maximumBatchesPerClaim) {
            await this.yieldClaim(token);
            return;
          }
        } else {
          this.log('batch_failed', {
            jobId: token.jobId,
            errorName: error instanceof Error ? error.name : 'UnknownError',
          });
          return;
        }

        const renewed = await this.renew(token);
        if (!renewed) {
          return;
        }
        lastRenewalAt = performance.now();
        continue;
      }

      if (result.kind === 'lease_lost') {
        this.log('lease_lost', { jobId: token.jobId });
        return;
      }

      if (result.kind === 'processed') {
        quantumAttempts += 1;
        this.log('batch_processed', {
          jobId: token.jobId,
          batchProcessedCount: result.batchProcessedCount,
          movedCount: result.movedCount,
          pendingCount: result.pendingCount,
          status: result.status,
        });
        if (
          result.status === BulkJobStatus.completed ||
          result.status === BulkJobStatus.completed_with_errors ||
          result.status === BulkJobStatus.failed
        ) {
          return;
        }
        if (this.shutdownRequested) {
          return;
        }
        if (quantumAttempts >= maximumBatchesPerClaim) {
          await this.yieldClaim(token);
          return;
        }
        const renewed = await this.renew(token);
        if (!renewed) {
          return;
        }
        lastRenewalAt = performance.now();
        continue;
      }

      this.log('no_due_pending_items', { jobId: token.jobId });
      let deferral: Awaited<
        ReturnType<BulkJobLeaseService['deferIfNoDueItems']>
      >;
      try {
        deferral = await this.leases.deferIfNoDueItems(token);
      } catch (error) {
        this.log('job_deferral_failed', {
          jobId: token.jobId,
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
        await this.waitWithJitter(this.config.pollIntervalMs);
        return;
      }

      if (deferral.kind === 'deferred') {
        this.log('job_deferred', { jobId: token.jobId });
        return;
      }
      if (deferral.kind === 'lease_lost') {
        this.log('lease_lost', { jobId: token.jobId, operation: 'defer' });
        return;
      }
      if (deferral.kind === 'no_pending_items') {
        this.logWarning('job_has_no_pending_items', { jobId: token.jobId });
        return;
      }

      this.log('due_items_remain', { jobId: token.jobId });
      await this.waitWithJitter(this.config.pollIntervalMs);
      if (this.shutdownRequested) {
        return;
      }
      if (this.shouldRenew(lastRenewalAt, renewalIntervalMs)) {
        const renewed = await this.renew(token);
        if (!renewed) {
          return;
        }
        lastRenewalAt = performance.now();
      }
    }
  }

  private async yieldClaim(token: BulkJobLeaseToken): Promise<void> {
    let result: Awaited<ReturnType<BulkJobLeaseService['yieldAfterQuantum']>>;
    try {
      result = await this.leases.yieldAfterQuantum(token);
    } catch (error) {
      this.log('job_yield_failed', {
        jobId: token.jobId,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      return;
    }

    if (result.kind === 'yielded') {
      this.log('job_yielded', { jobId: token.jobId });
      return;
    }
    if (result.kind === 'deferred') {
      this.log('job_deferred', { jobId: token.jobId, reason: 'future_items' });
      return;
    }
    if (result.kind === 'lease_lost') {
      this.log('lease_lost', { jobId: token.jobId, operation: 'yield' });
      return;
    }
    this.logWarning('job_has_no_pending_items', {
      jobId: token.jobId,
      operation: 'yield',
    });
  }

  private async runAnomalyDiagnosticIfDue(): Promise<void> {
    const now = performance.now();
    if (now - this.lastAnomalyDiagnosticAt < anomalyDiagnosticIntervalMs) {
      return;
    }
    this.lastAnomalyDiagnosticAt = now;

    try {
      const jobs = await this.leases.findJobsWithoutPendingItems();
      if (jobs.length > 0) {
        this.logWarning('jobs_without_pending_items', {
          jobs: jobs.map(({ id, status }) => ({ id, status })),
        });
      }
    } catch (error) {
      this.logError('job_anomaly_diagnostic_failed', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  }

  private shouldRenew(lastRenewalAt: number, intervalMs: number): boolean {
    return performance.now() - lastRenewalAt >= intervalMs;
  }

  private async renew(token: BulkJobLeaseToken): Promise<boolean> {
    try {
      const result = await this.leases.renew(token);
      if (result.kind === 'lease_lost') {
        this.log('lease_lost', { jobId: token.jobId, operation: 'renew' });
        return false;
      }
      this.log('lease_renewed', { jobId: token.jobId });
      return true;
    } catch (error) {
      this.log('renewal_failed', {
        jobId: token.jobId,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      return false;
    }
  }

  private async waitWithJitter(baseMs: number): Promise<void> {
    const factor = 1 - jitterRatio + Math.random() * jitterRatio * 2;
    const delayMs = Math.max(1, Math.round(baseMs * factor));
    await new Promise<void>((resolve) => {
      if (this.shutdownController.signal.aborted) {
        resolve();
        return;
      }
      const timeout = setTimeout(() => {
        this.shutdownController.signal.removeEventListener('abort', abort);
        resolve();
      }, delayMs);
      const abort = (): void => {
        clearTimeout(timeout);
        this.shutdownController.signal.removeEventListener('abort', abort);
        resolve();
      };
      this.shutdownController.signal.addEventListener('abort', abort, {
        once: true,
      });
    });
  }

  private log(event: string, fields: Record<string, unknown> = {}): void {
    this.logger.log(
      JSON.stringify({ event, workerId: this.config.workerId, ...fields }),
    );
  }

  private logWarning(
    event: string,
    fields: Record<string, unknown> = {},
  ): void {
    this.logger.warn(
      JSON.stringify({ event, workerId: this.config.workerId, ...fields }),
    );
  }

  private logError(event: string, fields: Record<string, unknown> = {}): void {
    this.logger.error(
      JSON.stringify({ event, workerId: this.config.workerId, ...fields }),
    );
  }
}
