CREATE TYPE "ComponentCompatibilityStatus" AS ENUM ('NOT_TESTED', 'IN_PROGRESS', 'PASSED', 'FAILED', 'BLOCKED');
CREATE TYPE "OnboardingJourneyStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'BLOCKED', 'COMPLETED');
CREATE TYPE "OnboardingStepStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'BLOCKED', 'COMPLETED');
CREATE TYPE "LiteLlmOwnershipMode" AS ENUM ('EXTERNAL_VALIDATED', 'PINNED_API_RECONCILED');
CREATE TYPE "SupermemoryStorageMode" AS ENUM ('EMBEDDED', 'SUPPORTED_EXTERNAL_POSTGRES');
CREATE TYPE "SupermemoryEmbeddingMode" AS ENUM ('LOCAL', 'OPENAI_COMPATIBLE');
CREATE TYPE "HermesMemoryMode" AS ENUM ('MEDIATED', 'NATIVE_SUPERMEMORY');
CREATE TYPE "GpuSchedulingMode" AS ENUM ('DEDICATED_LLM', 'MEASURED_CO_RESIDENCY', 'SERIALIZED_DEGRADED');

CREATE TABLE "PlatformArchitectureDecision" (
  "id" VARCHAR(32) NOT NULL DEFAULT 'global',
  "liteLlmOwnershipMode" "LiteLlmOwnershipMode" NOT NULL DEFAULT 'EXTERNAL_VALIDATED',
  "supermemoryStorageMode" "SupermemoryStorageMode" NOT NULL DEFAULT 'EMBEDDED',
  "supermemoryEmbeddingMode" "SupermemoryEmbeddingMode" NOT NULL DEFAULT 'LOCAL',
  "hermesMemoryMode" "HermesMemoryMode" NOT NULL DEFAULT 'MEDIATED',
  "gpuSchedulingMode" "GpuSchedulingMode" NOT NULL DEFAULT 'DEDICATED_LLM',
  "reason" VARCHAR(1000),
  "revision" INTEGER NOT NULL DEFAULT 0,
  "updatedBy" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "PlatformArchitectureDecision_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ComponentCompatibility" (
  "key" VARCHAR(80) NOT NULL,
  "displayName" VARCHAR(160) NOT NULL,
  "category" VARCHAR(80) NOT NULL,
  "required" BOOLEAN NOT NULL DEFAULT true,
  "expectedContract" VARCHAR(1000) NOT NULL,
  "status" "ComponentCompatibilityStatus" NOT NULL DEFAULT 'NOT_TESTED',
  "observedVersion" VARCHAR(240),
  "evidenceRef" VARCHAR(500),
  "note" VARCHAR(1000),
  "testedAt" TIMESTAMPTZ(6),
  "updatedBy" UUID,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "ComponentCompatibility_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "OnboardingJourney" (
  "id" VARCHAR(32) NOT NULL DEFAULT 'global',
  "status" "OnboardingJourneyStatus" NOT NULL DEFAULT 'NOT_STARTED',
  "currentStepKey" VARCHAR(80),
  "reason" VARCHAR(1000),
  "revision" INTEGER NOT NULL DEFAULT 0,
  "startedAt" TIMESTAMPTZ(6),
  "completedAt" TIMESTAMPTZ(6),
  "updatedBy" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "OnboardingJourney_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OnboardingStep" (
  "key" VARCHAR(80) NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "title" VARCHAR(160) NOT NULL,
  "description" VARCHAR(1000) NOT NULL,
  "required" BOOLEAN NOT NULL DEFAULT true,
  "status" "OnboardingStepStatus" NOT NULL DEFAULT 'NOT_STARTED',
  "evidenceRefs" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "note" VARCHAR(1000),
  "revision" INTEGER NOT NULL DEFAULT 0,
  "updatedBy" UUID,
  "completedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "OnboardingStep_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "ComponentCompatibility_required_status_idx" ON "ComponentCompatibility"("required", "status");
CREATE INDEX "ComponentCompatibility_category_status_idx" ON "ComponentCompatibility"("category", "status");
CREATE UNIQUE INDEX "OnboardingStep_ordinal_key" ON "OnboardingStep"("ordinal");
CREATE INDEX "OnboardingStep_status_ordinal_idx" ON "OnboardingStep"("status", "ordinal");
