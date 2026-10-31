-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "OpportunityStatus" AS ENUM ('open', 'won', 'lost', 'abandoned');

-- CreateEnum
CREATE TYPE "TransitionSource" AS ENUM ('manual', 'bulk');

-- CreateTable
CREATE TABLE "Workspace" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Stage" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Stage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Opportunity" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "stageId" UUID NOT NULL,
    "ownerId" UUID,
    "name" TEXT NOT NULL,
    "value" DECIMAL(19,4) NOT NULL DEFAULT 0,
    "status" "OpportunityStatus" NOT NULL DEFAULT 'open',
    "stageVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Opportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpportunityTransition" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "opportunityId" UUID NOT NULL,
    "fromStageId" UUID,
    "toStageId" UUID NOT NULL,
    "source" "TransitionSource" NOT NULL,
    "operationId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpportunityTransition_pkey" PRIMARY KEY ("id")
);

-- Prisma schema does not currently express PostgreSQL CHECK constraints.
ALTER TABLE "Opportunity"
ADD CONSTRAINT "Opportunity_value_nonnegative_check"
CHECK ("value" >= 0 AND "value" <> 'NaN'::numeric);

ALTER TABLE "Opportunity"
ADD CONSTRAINT "Opportunity_stageVersion_positive_check"
CHECK ("stageVersion" > 0);

-- CreateIndex
CREATE UNIQUE INDEX "Stage_workspaceId_position_key" ON "Stage"("workspaceId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "Stage_workspaceId_id_key" ON "Stage"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "Opportunity_workspaceId_stageId_id_idx" ON "Opportunity"("workspaceId", "stageId", "id");

-- CreateIndex
CREATE INDEX "Opportunity_workspaceId_ownerId_status_id_idx" ON "Opportunity"("workspaceId", "ownerId", "status", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Opportunity_workspaceId_id_key" ON "Opportunity"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "OpportunityTransition_workspaceId_opportunityId_createdAt_idx" ON "OpportunityTransition"("workspaceId", "opportunityId", "createdAt");

-- AddForeignKey
ALTER TABLE "Stage" ADD CONSTRAINT "Stage_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_workspaceId_stageId_fkey" FOREIGN KEY ("workspaceId", "stageId") REFERENCES "Stage"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpportunityTransition" ADD CONSTRAINT "OpportunityTransition_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpportunityTransition" ADD CONSTRAINT "OpportunityTransition_workspaceId_opportunityId_fkey" FOREIGN KEY ("workspaceId", "opportunityId") REFERENCES "Opportunity"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpportunityTransition" ADD CONSTRAINT "OpportunityTransition_workspaceId_fromStageId_fkey" FOREIGN KEY ("workspaceId", "fromStageId") REFERENCES "Stage"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpportunityTransition" ADD CONSTRAINT "OpportunityTransition_workspaceId_toStageId_fkey" FOREIGN KEY ("workspaceId", "toStageId") REFERENCES "Stage"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
