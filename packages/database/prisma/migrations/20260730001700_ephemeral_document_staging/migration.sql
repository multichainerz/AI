-- OrcaSynapse no longer owns a durable document object store. Existing object-store
-- references cannot be carried into encrypted transient staging, so preserve
-- already-published knowledge and require a fresh source for anything else.
ALTER TABLE "Document"
  ADD COLUMN "stagingKey" VARCHAR(1024),
  ADD COLUMN "stagingExpiresAt" TIMESTAMPTZ(6),
  ADD COLUMN "stagingPurgedAt" TIMESTAMPTZ(6);

UPDATE "Document" AS d
SET
  "stagingPurgedAt" = CURRENT_TIMESTAMP,
  "failureCode" = CASE
    WHEN p."status" = 'READY' OR d."status" IN ('REJECTED', 'DELETED') THEN d."failureCode"
    ELSE 'SOURCE_REUPLOAD_REQUIRED'
  END,
  "failureMessage" = CASE
    WHEN p."status" = 'READY' OR d."status" IN ('REJECTED', 'DELETED') THEN d."failureMessage"
    ELSE 'The previous durable document object is not migrated into transient staging. Re-upload or re-fetch the enterprise source.'
  END,
  "status" = CASE
    WHEN p."status" = 'READY' OR d."status" IN ('REJECTED', 'DELETED') THEN d."status"
    ELSE 'FAILED'::"DocumentStatus"
  END
FROM "DocumentMemoryPublication" AS p
WHERE p."documentId" = d."id";

UPDATE "Document" AS d
SET
  "stagingPurgedAt" = CURRENT_TIMESTAMP,
  "failureCode" = CASE
    WHEN d."status" IN ('REJECTED', 'DELETED') THEN d."failureCode"
    ELSE 'SOURCE_REUPLOAD_REQUIRED'
  END,
  "failureMessage" = CASE
    WHEN d."status" IN ('REJECTED', 'DELETED') THEN d."failureMessage"
    ELSE 'The previous durable document object is not migrated into transient staging. Re-upload or re-fetch the enterprise source.'
  END,
  "status" = CASE
    WHEN d."status" IN ('REJECTED', 'DELETED') THEN d."status"
    ELSE 'FAILED'::"DocumentStatus"
  END
WHERE NOT EXISTS (
  SELECT 1 FROM "DocumentMemoryPublication" AS p WHERE p."documentId" = d."id"
);

DROP TABLE "DocumentArtifact";
DROP TYPE "DocumentArtifactKind";

ALTER TABLE "Document"
  DROP COLUMN "originalObjectKey",
  DROP COLUMN "normalizedText",
  DROP COLUMN "normalizedMarkdown",
  DROP COLUMN "ocrMetadata";

CREATE INDEX "Document_stagingExpiresAt_stagingPurgedAt_idx"
  ON "Document"("stagingExpiresAt", "stagingPurgedAt");

-- Remove the retired object-store connector before rebuilding the enum without
-- its value. Historical migration files remain immutable for safe upgrades.
DELETE FROM "ModelDeployment"
WHERE "connectionId" IN (SELECT "id" FROM "ServiceConnection" WHERE "kind" = 'S3');

DELETE FROM "ServiceConnection" WHERE "kind" = 'S3';

ALTER TYPE "ServiceKind" RENAME TO "ServiceKind_retired_object_store";
CREATE TYPE "ServiceKind" AS ENUM (
  'LITELLM',
  'VLLM',
  'HERMES',
  'SUPERMEMORY',
  'OCR',
  'MCP',
  'OIDC',
  'SIEM',
  'NOTIFICATION',
  'OTHER'
);
ALTER TABLE "ServiceConnection"
  ALTER COLUMN "kind" TYPE "ServiceKind"
  USING ("kind"::text::"ServiceKind");
DROP TYPE "ServiceKind_retired_object_store";

UPDATE "ProductionReadinessControl"
SET
  "key" = 'recovery-supermemory-restore',
  "title" = 'Supermemory knowledge restore exercise',
  "description" = 'Durable normalized knowledge is restored in Supermemory and reconciled against PostgreSQL provenance without relying on OrcaSynapse transient document staging.',
  "updatedAt" = CURRENT_TIMESTAMP,
  "revision" = "revision" + 1
WHERE "key" = 'recovery-s3-restore';
