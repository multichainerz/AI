-- Retire the optional extraction pipeline before narrowing its enums.
UPDATE "Document"
SET
  "status" = 'FAILED',
  "failureCode" = 'EXTRACTOR_REMOVED',
  "failureMessage" = 'Rich-document extraction is not available in this AIHub release.',
  "completedAt" = NULL
WHERE "status" IN ('OCR_PENDING', 'OCR_PROCESSING');

UPDATE "DocumentProcessingRun"
SET
  "failedAt" = COALESCE("failedAt", CURRENT_TIMESTAMP),
  "failureCode" = 'EXTRACTOR_REMOVED'
WHERE "ocrJobId" IS NOT NULL AND "completedAt" IS NULL;

-- Evidence containing the retired category can no longer authorize an active
-- route or policy. Suspend dependants before the evidence row is removed.
UPDATE "ModelDeployment"
SET "status" = 'SUSPENDED', "isDefault" = false, "revision" = "revision" + 1
WHERE "activationEvaluationId" IN (
  SELECT "id" FROM "EvaluationRun" WHERE 'OCR' = ANY("requiredCategories")
);

UPDATE "GuardrailPolicy"
SET "status" = 'SUSPENDED', "revision" = "revision" + 1
WHERE "activationEvaluationId" IN (
  SELECT "id" FROM "EvaluationRun" WHERE 'OCR' = ANY("requiredCategories")
);

UPDATE "PromptTemplate"
SET "status" = 'SUSPENDED', "revision" = "revision" + 1
WHERE "activationEvaluationId" IN (
  SELECT "id" FROM "EvaluationRun" WHERE 'OCR' = ANY("requiredCategories")
);

DELETE FROM "EvaluationRun" WHERE 'OCR' = ANY("requiredCategories");
DELETE FROM "ModelDeployment" WHERE "workload" = 'OCR';
DELETE FROM "ServiceConnection" WHERE "kind" = 'OCR';
DELETE FROM "OnboardingEvidence" WHERE "componentKey" IN ('document-conversion', 'unlimited-ocr');
DELETE FROM "ComponentCompatibility" WHERE "key" IN ('document-conversion', 'unlimited-ocr');

UPDATE "OnboardingStep"
SET
  "description" = 'Validate UTF-8 TXT normalization, Supermemory publication, authorization, and deletion.',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'knowledge-workflow';

DROP INDEX "DocumentProcessingRun_ocrJobId_idx";
ALTER TABLE "DocumentProcessingRun" DROP COLUMN "ocrJobId";

CREATE TYPE "ServiceKind_new" AS ENUM (
  'VLLM', 'HERMES', 'SUPERMEMORY', 'MCP', 'OIDC', 'SIEM', 'NOTIFICATION', 'OTHER'
);
ALTER TABLE "ServiceConnection"
  ALTER COLUMN "kind" TYPE "ServiceKind_new"
  USING ("kind"::text::"ServiceKind_new");
DROP TYPE "ServiceKind";
ALTER TYPE "ServiceKind_new" RENAME TO "ServiceKind";

CREATE TYPE "ModelWorkload_new" AS ENUM ('CHAT', 'AGENT');
ALTER TABLE "ModelDeployment"
  ALTER COLUMN "workload" TYPE "ModelWorkload_new"
  USING ("workload"::text::"ModelWorkload_new");
DROP TYPE "ModelWorkload";
ALTER TYPE "ModelWorkload_new" RENAME TO "ModelWorkload";

CREATE TYPE "DocumentStatus_new" AS ENUM (
  'QUARANTINED', 'QUEUED', 'CONVERTING', 'READY', 'FAILED', 'REJECTED', 'DELETING', 'DELETED'
);
ALTER TABLE "Document"
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" TYPE "DocumentStatus_new"
  USING ("status"::text::"DocumentStatus_new"),
  ALTER COLUMN "status" SET DEFAULT 'QUARANTINED';
DROP TYPE "DocumentStatus";
ALTER TYPE "DocumentStatus_new" RENAME TO "DocumentStatus";
