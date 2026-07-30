CREATE TYPE "DeploymentTopologyMode" AS ENUM ('COMPACT', 'CONTROL_PLANE', 'SEGMENTED_PRODUCTION');
CREATE TYPE "OnboardingTargetEnvironment" AS ENUM ('DEVELOPMENT', 'PILOT', 'PRODUCTION');
CREATE TYPE "DeploymentInstallMethod" AS ENUM ('SIGNED_INSTALLER', 'COOLIFY', 'CUSTOM_COMPOSE');
CREATE TYPE "OnboardingEvidenceSource" AS ENUM ('AUTOMATED', 'EXTERNAL_ATTESTATION');
CREATE TYPE "OnboardingEvidenceOutcome" AS ENUM ('PASSED', 'FAILED', 'WARNING');

ALTER TABLE "PlatformArchitectureDecision"
  ADD COLUMN "topologyMode" "DeploymentTopologyMode" NOT NULL DEFAULT 'CONTROL_PLANE',
  ADD COLUMN "targetEnvironment" "OnboardingTargetEnvironment" NOT NULL DEFAULT 'DEVELOPMENT',
  ADD COLUMN "installMethod" "DeploymentInstallMethod" NOT NULL DEFAULT 'SIGNED_INSTALLER',
  ADD COLUMN "localInference" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "OnboardingJourney"
  ADD COLUMN "activatedEnvironment" "OnboardingTargetEnvironment";

CREATE TABLE "InstallationClaim" (
  "id" VARCHAR(32) NOT NULL DEFAULT 'initial',
  "tokenHash" BYTEA NOT NULL,
  "expiresAt" TIMESTAMPTZ(6),
  "redeemedAt" TIMESTAMPTZ(6),
  "redeemedSessionId" UUID,
  "sourceIp" INET,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "InstallationClaim_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InstallationClaim_tokenHash_key" ON "InstallationClaim"("tokenHash");
CREATE INDEX "InstallationClaim_redeemedAt_expiresAt_idx" ON "InstallationClaim"("redeemedAt", "expiresAt");

CREATE TABLE "CredentialRecoveryControl" (
  "id" VARCHAR(32) NOT NULL DEFAULT 'global',
  "keyFingerprint" VARCHAR(64),
  "kitChecksum" VARCHAR(64),
  "recoveryOwner" VARCHAR(160),
  "exportedAt" TIMESTAMPTZ(6),
  "exportedBy" UUID,
  "verifiedAt" TIMESTAMPTZ(6),
  "verifiedBy" UUID,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "CredentialRecoveryControl_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OnboardingEvidence" (
  "id" UUID NOT NULL,
  "stageKey" VARCHAR(80) NOT NULL,
  "componentKey" VARCHAR(80),
  "source" "OnboardingEvidenceSource" NOT NULL,
  "outcome" "OnboardingEvidenceOutcome" NOT NULL,
  "code" VARCHAR(120) NOT NULL,
  "summary" VARCHAR(1000) NOT NULL,
  "observedVersion" VARCHAR(240),
  "details" JSONB NOT NULL DEFAULT '{}',
  "createdBy" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMPTZ(6),
  CONSTRAINT "OnboardingEvidence_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OnboardingEvidence_stageKey_createdAt_idx" ON "OnboardingEvidence"("stageKey", "createdAt");
CREATE INDEX "OnboardingEvidence_componentKey_createdAt_idx" ON "OnboardingEvidence"("componentKey", "createdAt");
CREATE INDEX "OnboardingEvidence_source_outcome_createdAt_idx" ON "OnboardingEvidence"("source", "outcome", "createdAt");

INSERT INTO "OnboardingStep" ("key", "ordinal", "title", "description", "required", "status", "evidenceRefs", "revision", "createdAt", "updatedAt") VALUES
  ('claim-installation', 1, 'Claim installation', 'Confirm the single-use installation claim, installed release, and host identity.', true, 'NOT_STARTED', ARRAY[]::TEXT[], 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('system-topology', 2, 'System and topology', 'Validate the host and select Compact, Control-plane only, or Segmented production.', true, 'NOT_STARTED', ARRAY[]::TEXT[], 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('identity-recovery', 3, 'Identity and recovery', 'Configure final trust, enterprise identity, recovery ownership, and a verified encrypted recovery kit.', true, 'NOT_STARTED', ARRAY[]::TEXT[], 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('ai-services', 4, 'AI services', 'Connect and validate LiteLLM, Unlimited-OCR, Supermemory, and Hermes.', true, 'NOT_STARTED', ARRAY[]::TEXT[], 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('knowledge-workflow', 5, 'Knowledge workflow', 'Validate transient extraction, publication, authorized retrieval/deletion, and scratch purge.', true, 'NOT_STARTED', ARRAY[]::TEXT[], 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('hermes-profiles', 6, 'Hermes and Profiles', 'Validate the Hermes boundary and move an immutable Profile Distribution into standby.', true, 'NOT_STARTED', ARRAY[]::TEXT[], 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('guardrails-tools', 7, 'Guardrails and tools', 'Prove conservative policy, zero-tool operation, approvals, and bounded governed tools.', true, 'NOT_STARTED', ARRAY[]::TEXT[], 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('validate-activate', 8, 'Validate and activate', 'Run the target-environment gate and record Development, Pilot, or Production activation.', true, 'NOT_STARTED', ARRAY[]::TEXT[], 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO UPDATE SET
  "ordinal" = EXCLUDED."ordinal",
  "title" = EXCLUDED."title",
  "description" = EXCLUDED."description",
  "required" = EXCLUDED."required",
  "updatedAt" = CURRENT_TIMESTAMP;

UPDATE "OnboardingStep"
SET "required" = false, "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" IN ('deployment-preflight', 'root-of-trust', 'administrator-identity', 'core-connections', 'hermes-enrollment', 'profile-setup', 'guardrail-baseline', 'readiness-tests', 'handover');

UPDATE "OnboardingJourney"
SET "status" = 'IN_PROGRESS',
    "currentStepKey" = 'claim-installation',
    "completedAt" = NULL,
    "activatedEnvironment" = NULL,
    "revision" = "revision" + 1,
    "updatedAt" = CURRENT_TIMESTAMP;
