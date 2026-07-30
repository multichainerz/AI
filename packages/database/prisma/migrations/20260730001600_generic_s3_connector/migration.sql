-- Preserve the addressing behavior of existing SeaweedFS-backed records
-- before changing the application default to virtual-hosted S3 URLs.
UPDATE "ServiceConnection"
SET "configuration" = jsonb_set("configuration", '{forcePathStyle}', 'true'::jsonb, true)
WHERE "kind" = 'SEAWEEDFS'
  AND NOT ("configuration" ? 'forcePathStyle');

ALTER TYPE "ServiceKind" RENAME VALUE 'SEAWEEDFS' TO 'S3';

UPDATE "ProductionReadinessControl"
SET
  "key" = 'recovery-s3-restore',
  "title" = 'S3 object-store restore exercise',
  "description" = 'Document objects and metadata are restored from the configured S3-compatible service and reconciled against PostgreSQL without silent loss or split-brain state.',
  "updatedAt" = CURRENT_TIMESTAMP,
  "revision" = "revision" + 1
WHERE "key" = 'recovery-seaweedfs-restore';
