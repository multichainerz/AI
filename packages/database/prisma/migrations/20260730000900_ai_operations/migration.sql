CREATE TYPE "OperationalIncidentSeverity" AS ENUM ('WARNING', 'CRITICAL');
CREATE TYPE "OperationalIncidentStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED');
CREATE TYPE "EvaluationTargetType" AS ENUM ('MODEL', 'PROMPT', 'POLICY', 'AGENT');
CREATE TYPE "EvaluationRunStatus" AS ENUM ('DRAFT', 'PASSED', 'FAILED', 'PROMOTED');

CREATE TABLE "OperationalIncident" (
  "id" UUID NOT NULL,
  "activeFingerprint" VARCHAR(160),
  "title" VARCHAR(160) NOT NULL,
  "severity" "OperationalIncidentSeverity" NOT NULL,
  "status" "OperationalIncidentStatus" NOT NULL DEFAULT 'OPEN',
  "component" VARCHAR(80) NOT NULL,
  "summary" VARCHAR(1000) NOT NULL,
  "owner" VARCHAR(160),
  "automated" BOOLEAN NOT NULL DEFAULT false,
  "detectedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastObservedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "acknowledgedBy" UUID,
  "acknowledgedAt" TIMESTAMPTZ(6),
  "resolvedBy" UUID,
  "resolvedAt" TIMESTAMPTZ(6),
  "resolutionNote" VARCHAR(1000),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "OperationalIncident_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OperationalIncident_lifecycle_check" CHECK (
    ("status" = 'OPEN' AND "acknowledgedAt" IS NULL AND "resolvedAt" IS NULL)
    OR ("status" = 'ACKNOWLEDGED' AND "acknowledgedAt" IS NOT NULL AND "resolvedAt" IS NULL)
    OR ("status" = 'RESOLVED' AND "resolvedAt" IS NOT NULL AND "activeFingerprint" IS NULL)
  )
);

CREATE TABLE "EvaluationRun" (
  "id" UUID NOT NULL,
  "name" VARCHAR(160) NOT NULL,
  "targetType" "EvaluationTargetType" NOT NULL,
  "targetReference" VARCHAR(240) NOT NULL,
  "targetVersion" VARCHAR(120) NOT NULL,
  "status" "EvaluationRunStatus" NOT NULL DEFAULT 'DRAFT',
  "minimumPassRate" DOUBLE PRECISION NOT NULL,
  "requiredCategories" TEXT[] NOT NULL,
  "categoryResults" JSONB NOT NULL DEFAULT '[]',
  "totalCases" INTEGER NOT NULL DEFAULT 0,
  "passedCases" INTEGER NOT NULL DEFAULT 0,
  "criticalFailures" INTEGER NOT NULL DEFAULT 0,
  "createdBy" UUID,
  "completedAt" TIMESTAMPTZ(6),
  "promotedBy" UUID,
  "promotedAt" TIMESTAMPTZ(6),
  "promotionReason" VARCHAR(1000),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "EvaluationRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EvaluationRun_threshold_check" CHECK ("minimumPassRate" >= 0.5 AND "minimumPassRate" <= 1),
  CONSTRAINT "EvaluationRun_categories_check" CHECK (cardinality("requiredCategories") BETWEEN 1 AND 6),
  CONSTRAINT "EvaluationRun_results_shape_check" CHECK (jsonb_typeof("categoryResults") = 'array'),
  CONSTRAINT "EvaluationRun_counts_check" CHECK (
    "totalCases" >= 0 AND "passedCases" >= 0 AND "passedCases" <= "totalCases"
    AND "criticalFailures" >= 0 AND "criticalFailures" <= ("totalCases" - "passedCases")
  ),
  CONSTRAINT "EvaluationRun_evidence_check" CHECK (
    ("status" = 'DRAFT' AND "completedAt" IS NULL AND "promotedAt" IS NULL AND "promotionReason" IS NULL)
    OR ("status" IN ('PASSED', 'FAILED') AND "completedAt" IS NOT NULL AND "promotedAt" IS NULL AND "promotionReason" IS NULL AND jsonb_array_length("categoryResults") > 0)
    OR ("status" = 'PROMOTED' AND "completedAt" IS NOT NULL AND "promotedAt" IS NOT NULL AND length(btrim("promotionReason")) >= 3 AND jsonb_array_length("categoryResults") > 0)
  ),
  CONSTRAINT "EvaluationRun_quality_check" CHECK (
    "status" IN ('DRAFT', 'FAILED')
    OR (
      "totalCases" > 0 AND "criticalFailures" = 0
      AND ("passedCases"::DOUBLE PRECISION / "totalCases"::DOUBLE PRECISION) >= "minimumPassRate"
    )
  )
);

CREATE UNIQUE INDEX "OperationalIncident_activeFingerprint_key" ON "OperationalIncident"("activeFingerprint");
CREATE INDEX "OperationalIncident_status_severity_detectedAt_idx" ON "OperationalIncident"("status", "severity", "detectedAt");
CREATE INDEX "OperationalIncident_component_status_idx" ON "OperationalIncident"("component", "status");
CREATE INDEX "OperationalIncident_owner_status_idx" ON "OperationalIncident"("owner", "status");
CREATE INDEX "EvaluationRun_status_createdAt_idx" ON "EvaluationRun"("status", "createdAt");
CREATE INDEX "EvaluationRun_targetType_targetReference_targetVersion_idx" ON "EvaluationRun"("targetType", "targetReference", "targetVersion");
