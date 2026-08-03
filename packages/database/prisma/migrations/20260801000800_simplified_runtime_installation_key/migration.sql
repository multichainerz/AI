ALTER TABLE "InstallationClaim" RENAME TO "InstallationCredential";
ALTER TABLE "InstallationCredential" RENAME COLUMN "tokenHash" TO "keyHash";
ALTER TABLE "InstallationCredential" RENAME COLUMN "redeemedAt" TO "activatedAt";
ALTER TABLE "InstallationCredential" RENAME COLUMN "redeemedSessionId" TO "lastSessionId";
ALTER TABLE "InstallationCredential" RENAME COLUMN "sourceIp" TO "lastSourceIp";
ALTER TABLE "InstallationCredential" DROP COLUMN "expiresAt";
UPDATE "InstallationCredential" SET "id" = 'primary' WHERE "id" = 'initial';
ALTER TABLE "InstallationCredential" RENAME CONSTRAINT "InstallationClaim_pkey" TO "InstallationCredential_pkey";
ALTER INDEX "InstallationClaim_tokenHash_key" RENAME TO "InstallationCredential_keyHash_key";
CREATE INDEX "InstallationCredential_activatedAt_idx" ON "InstallationCredential"("activatedAt");

DELETE FROM "ComponentCompatibility" WHERE "key" = 'pg-boss';
INSERT INTO "ComponentCompatibility" (
  "key", "displayName", "category", "required", "expectedContract", "status", "createdAt", "updatedAt"
) VALUES (
  'postgresql-runtime', 'PostgreSQL runtime state', 'Data', true,
  'Durable domain state, compare-and-set claims, restart reconciliation, and executor heartbeats pass without a separate queue broker.',
  'NOT_TESTED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
)
ON CONFLICT ("key") DO UPDATE SET
  "displayName" = EXCLUDED."displayName",
  "category" = EXCLUDED."category",
  "required" = EXCLUDED."required",
  "expectedContract" = EXCLUDED."expectedContract",
  "updatedAt" = CURRENT_TIMESTAMP;

UPDATE "OnboardingStep"
SET "title" = 'Activate installation',
    "description" = 'Confirm the permanent Installation Key, installed release, and host identity.',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'claim-installation';
