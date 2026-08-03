DELETE FROM "ModelDeployment" WHERE "workload" = 'EMBEDDING';
DELETE FROM "ComponentCompatibility" WHERE "key" IN ('supermemory-external-backend', 'qwen3-embedding');

CREATE TYPE "ModelWorkload_new" AS ENUM ('CHAT', 'AGENT', 'OCR');

ALTER TABLE "ModelDeployment"
  ALTER COLUMN "workload" TYPE "ModelWorkload_new"
  USING ("workload"::text::"ModelWorkload_new");

DROP TYPE "ModelWorkload";
ALTER TYPE "ModelWorkload_new" RENAME TO "ModelWorkload";
