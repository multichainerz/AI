-- Normalize legacy deployment selections before constraining the public contract.
UPDATE "PlatformArchitectureDecision"
SET "installMethod" = 'SIGNED_INSTALLER'
WHERE "installMethod"::text <> 'SIGNED_INSTALLER';

ALTER TABLE "PlatformArchitectureDecision"
  ALTER COLUMN "installMethod" DROP DEFAULT;

ALTER TYPE "DeploymentInstallMethod" RENAME TO "DeploymentInstallMethod_legacy";
CREATE TYPE "DeploymentInstallMethod" AS ENUM ('SIGNED_INSTALLER');

ALTER TABLE "PlatformArchitectureDecision"
  ALTER COLUMN "installMethod" TYPE "DeploymentInstallMethod"
  USING ("installMethod"::text::"DeploymentInstallMethod");

ALTER TABLE "PlatformArchitectureDecision"
  ALTER COLUMN "installMethod" SET DEFAULT 'SIGNED_INSTALLER';

DROP TYPE "DeploymentInstallMethod_legacy";

UPDATE "ProductionReadinessControl"
SET
  "key" = 'infrastructure-installer-network-tls',
  "title" = 'Installer, network, DNS, and TLS validation',
  "description" = 'The signed installation path, production topology, internal DNS, TLS termination, segmentation, ingress, egress, and persistent storage are verified.',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'infrastructure-coolify-network-tls';
