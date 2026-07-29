ALTER TYPE "ServiceKind" ADD VALUE IF NOT EXISTS 'HERMES';

CREATE TYPE "AgentProfileStatus" AS ENUM ('DRAFT', 'ACTIVE', 'SUSPENDED');
CREATE TYPE "AgentRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'CANCEL_REQUESTED', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'DENIED');

CREATE TABLE "AgentProfile" (
  "id" UUID NOT NULL,
  "slug" VARCHAR(64) NOT NULL,
  "status" "AgentProfileStatus" NOT NULL DEFAULT 'DRAFT',
  "currentVersion" INTEGER NOT NULL DEFAULT 1,
  "activeVersion" INTEGER,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "AgentProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentProfileVersion" (
  "id" UUID NOT NULL,
  "profileId" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "displayName" VARCHAR(120) NOT NULL,
  "purpose" VARCHAR(500) NOT NULL,
  "instructions" TEXT NOT NULL,
  "modelAlias" VARCHAR(200) NOT NULL,
  "maxTurns" INTEGER NOT NULL,
  "timeoutSeconds" INTEGER NOT NULL,
  "maxConcurrentRuns" INTEGER NOT NULL,
  "allowPrivateKnowledge" BOOLEAN NOT NULL DEFAULT false,
  "safeMode" BOOLEAN NOT NULL DEFAULT true,
  "createdBy" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentProfileVersion_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AgentProfileVersion"
ADD CONSTRAINT "AgentProfileVersion_phase5_boundary_check"
CHECK ("maxTurns" = 1 AND "safeMode" = true);

CREATE TABLE "AgentRun" (
  "id" UUID NOT NULL,
  "profileId" UUID NOT NULL,
  "profileVersionId" UUID NOT NULL,
  "profileVersion" INTEGER NOT NULL,
  "ownerSubject" VARCHAR(200) NOT NULL,
  "requestedBy" UUID NOT NULL,
  "status" "AgentRunStatus" NOT NULL DEFAULT 'QUEUED',
  "input" TEXT NOT NULL,
  "output" TEXT,
  "effectiveCapabilities" JSONB NOT NULL DEFAULT '[]',
  "sources" JSONB NOT NULL DEFAULT '[]',
  "externalRunId" VARCHAR(255),
  "jobId" UUID,
  "failureCode" VARCHAR(80),
  "failureMessage" VARCHAR(500),
  "queuedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMPTZ(6),
  "completedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentRuntimeControl" (
  "id" VARCHAR(32) NOT NULL DEFAULT 'global',
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "reason" VARCHAR(500),
  "updatedBy" UUID,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "AgentRuntimeControl_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgentProfile_slug_key" ON "AgentProfile"("slug");
CREATE INDEX "AgentProfile_status_updatedAt_idx" ON "AgentProfile"("status", "updatedAt");
CREATE UNIQUE INDEX "AgentProfileVersion_profileId_version_key" ON "AgentProfileVersion"("profileId", "version");
CREATE INDEX "AgentProfileVersion_profileId_createdAt_idx" ON "AgentProfileVersion"("profileId", "createdAt");
CREATE INDEX "AgentRun_ownerSubject_createdAt_idx" ON "AgentRun"("ownerSubject", "createdAt");
CREATE INDEX "AgentRun_profileId_status_createdAt_idx" ON "AgentRun"("profileId", "status", "createdAt");
CREATE INDEX "AgentRun_status_queuedAt_idx" ON "AgentRun"("status", "queuedAt");

ALTER TABLE "AgentProfileVersion" ADD CONSTRAINT "AgentProfileVersion_profileId_fkey"
FOREIGN KEY ("profileId") REFERENCES "AgentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_profileId_fkey"
FOREIGN KEY ("profileId") REFERENCES "AgentProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_profileVersionId_fkey"
FOREIGN KEY ("profileVersionId") REFERENCES "AgentProfileVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "AgentRuntimeControl" ("id", "enabled", "reason", "updatedAt")
VALUES ('global', false, 'Agent execution is disabled until an administrator completes Hermes acceptance.', CURRENT_TIMESTAMP);
