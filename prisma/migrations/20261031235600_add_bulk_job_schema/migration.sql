-- CreateEnum
CREATE TYPE "BulkJobStatus" AS ENUM ('queued', 'running', 'recovering', 'completed', 'completed_with_errors', 'failed');

-- CreateEnum
CREATE TYPE "BulkJobHealthStatus" AS ENUM ('healthy', 'slow', 'stuck');

-- CreateEnum
CREATE TYPE "BulkJobItemStatus" AS ENUM ('pending', 'moved', 'skipped', 'failed');

-- CreateTable
CREATE TABLE "BulkJob" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "canonicalRequestHash" TEXT NOT NULL,
    "normalizedRequest" JSONB NOT NULL,
    "targetStageId" UUID NOT NULL,
    "status" "BulkJobStatus" NOT NULL DEFAULT 'queued',
    "healthStatus" "BulkJobHealthStatus" NOT NULL DEFAULT 'healthy',
    "matchedCount" INTEGER NOT NULL DEFAULT 0,
    "processedCount" INTEGER NOT NULL DEFAULT 0,
    "movedCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "cursorItemId" BIGINT,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMPTZ(6),
    "leaseGeneration" INTEGER NOT NULL DEFAULT 0,
    "heartbeatAt" TIMESTAMPTZ(6),
    "lastProgressAt" TIMESTAMPTZ(6),
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(6),
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "startedAt" TIMESTAMPTZ(6),
    "completedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BulkJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BulkJobItem" (
    "itemId" BIGSERIAL NOT NULL,
    "jobId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "opportunityId" UUID NOT NULL,
    "expectedStageId" UUID NOT NULL,
    "expectedStageVersion" INTEGER NOT NULL,
    "status" "BulkJobItemStatus" NOT NULL DEFAULT 'pending',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(6),
    "outcomeReason" TEXT,
    "lastErrorCode" TEXT,
    "processedAt" TIMESTAMPTZ(6),

    CONSTRAINT "BulkJobItem_pkey" PRIMARY KEY ("itemId")
);

-- CreateIndex
CREATE INDEX "BulkJob_status_nextAttemptAt_createdAt_idx" ON "BulkJob"("status", "nextAttemptAt", "createdAt");

-- CreateIndex
CREATE INDEX "BulkJob_status_leaseExpiresAt_idx" ON "BulkJob"("status", "leaseExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "BulkJob_workspaceId_id_key" ON "BulkJob"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "BulkJob_workspaceId_idempotencyKey_key" ON "BulkJob"("workspaceId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "BulkJobItem_jobId_status_nextAttemptAt_itemId_idx" ON "BulkJobItem"("jobId", "status", "nextAttemptAt", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "BulkJobItem_jobId_opportunityId_key" ON "BulkJobItem"("jobId", "opportunityId");

-- CreateIndex
CREATE UNIQUE INDEX "BulkJobItem_jobId_itemId_key" ON "BulkJobItem"("jobId", "itemId");

-- AddForeignKey
ALTER TABLE "OpportunityTransition" ADD CONSTRAINT "OpportunityTransition_workspaceId_operationId_fkey" FOREIGN KEY ("workspaceId", "operationId") REFERENCES "BulkJob"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BulkJob" ADD CONSTRAINT "BulkJob_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BulkJob" ADD CONSTRAINT "BulkJob_workspaceId_targetStageId_fkey" FOREIGN KEY ("workspaceId", "targetStageId") REFERENCES "Stage"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BulkJob" ADD CONSTRAINT "BulkJob_id_cursorItemId_fkey" FOREIGN KEY ("id", "cursorItemId") REFERENCES "BulkJobItem"("jobId", "itemId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BulkJobItem" ADD CONSTRAINT "BulkJobItem_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BulkJobItem" ADD CONSTRAINT "BulkJobItem_workspaceId_jobId_fkey" FOREIGN KEY ("workspaceId", "jobId") REFERENCES "BulkJob"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BulkJobItem" ADD CONSTRAINT "BulkJobItem_workspaceId_opportunityId_fkey" FOREIGN KEY ("workspaceId", "opportunityId") REFERENCES "Opportunity"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BulkJobItem" ADD CONSTRAINT "BulkJobItem_workspaceId_expectedStageId_fkey" FOREIGN KEY ("workspaceId", "expectedStageId") REFERENCES "Stage"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BulkJob"
ADD CONSTRAINT "BulkJob_counts_check"
CHECK (
    "matchedCount" BETWEEN 0 AND 50000
    AND "processedCount" >= 0
    AND "movedCount" BETWEEN 0 AND 50000
    AND "skippedCount" BETWEEN 0 AND 50000
    AND "failedCount" BETWEEN 0 AND 50000
    AND "processedCount" = "movedCount" + "skippedCount" + "failedCount"
    AND "matchedCount" >= "processedCount"
);

ALTER TABLE "BulkJob"
ADD CONSTRAINT "BulkJob_leaseGeneration_nonnegative_check"
CHECK ("leaseGeneration" >= 0);

ALTER TABLE "BulkJob"
ADD CONSTRAINT "BulkJob_retryCount_nonnegative_check"
CHECK ("retryCount" >= 0);

ALTER TABLE "BulkJobItem"
ADD CONSTRAINT "BulkJobItem_attemptCount_nonnegative_check"
CHECK ("attemptCount" >= 0);

ALTER TABLE "BulkJobItem"
ADD CONSTRAINT "BulkJobItem_expectedStageVersion_positive_check"
CHECK ("expectedStageVersion" > 0);
