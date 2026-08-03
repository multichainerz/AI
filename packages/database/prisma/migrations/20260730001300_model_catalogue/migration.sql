CREATE TYPE "ModelWorkload" AS ENUM ('CHAT', 'AGENT', 'EMBEDDING', 'OCR');
CREATE TYPE "ModelDeploymentStatus" AS ENUM ('DRAFT', 'ACTIVE', 'SUSPENDED');

CREATE TABLE "ModelDeployment" (
  "id" UUID NOT NULL,
  "slug" VARCHAR(64) NOT NULL,
  "displayName" VARCHAR(120) NOT NULL,
  "modelAlias" VARCHAR(200) NOT NULL,
  "workload" "ModelWorkload" NOT NULL,
  "status" "ModelDeploymentStatus" NOT NULL DEFAULT 'DRAFT',
  "connectionId" UUID NOT NULL,
  "version" VARCHAR(120) NOT NULL,
  "license" VARCHAR(160),
  "contextWindowTokens" INTEGER NOT NULL,
  "maxOutputTokens" INTEGER NOT NULL,
  "maxConcurrentRequests" INTEGER NOT NULL,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "activationEvaluationId" UUID,
  "firstActivatedAt" TIMESTAMPTZ(6),
  "revision" INTEGER NOT NULL DEFAULT 1,
  "createdBy" UUID,
  "updatedBy" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "ModelDeployment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ModelDeployment_limits_check" CHECK (
    "contextWindowTokens" BETWEEN 1024 AND 4194304
    AND "maxOutputTokens" BETWEEN 64 AND 131072
    AND "maxOutputTokens" <= "contextWindowTokens"
    AND "maxConcurrentRequests" BETWEEN 1 AND 1024
    AND "revision" > 0
  ),
  CONSTRAINT "ModelDeployment_activation_evidence_check" CHECK (
    "status" <> 'ACTIVE'::"ModelDeploymentStatus"
    OR ("activationEvaluationId" IS NOT NULL AND "firstActivatedAt" IS NOT NULL)
  ),
  CONSTRAINT "ModelDeployment_default_status_check" CHECK (
    "isDefault" = false OR "status" = 'ACTIVE'::"ModelDeploymentStatus"
  )
);

CREATE UNIQUE INDEX "ModelDeployment_slug_key" ON "ModelDeployment"("slug");
CREATE UNIQUE INDEX "ModelDeployment_workload_modelAlias_key" ON "ModelDeployment"("workload", "modelAlias");
CREATE UNIQUE INDEX "ModelDeployment_active_default_workload_key"
  ON "ModelDeployment"("workload")
  WHERE "status" = 'ACTIVE'::"ModelDeploymentStatus" AND "isDefault" = true;
CREATE INDEX "ModelDeployment_workload_status_idx" ON "ModelDeployment"("workload", "status");
CREATE INDEX "ModelDeployment_connectionId_idx" ON "ModelDeployment"("connectionId");
CREATE INDEX "ModelDeployment_activationEvaluationId_idx" ON "ModelDeployment"("activationEvaluationId");

ALTER TABLE "ModelDeployment"
  ADD CONSTRAINT "ModelDeployment_connectionId_fkey"
  FOREIGN KEY ("connectionId") REFERENCES "ServiceConnection"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ModelDeployment"
  ADD CONSTRAINT "ModelDeployment_activationEvaluationId_fkey"
  FOREIGN KEY ("activationEvaluationId") REFERENCES "EvaluationRun"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
