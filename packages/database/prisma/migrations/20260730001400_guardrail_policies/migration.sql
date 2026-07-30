CREATE TYPE "GuardrailPolicyStatus" AS ENUM ('DRAFT', 'ACTIVE', 'SUSPENDED');

CREATE TABLE "GuardrailPolicy" (
  "id" UUID NOT NULL,
  "slug" VARCHAR(64) NOT NULL,
  "displayName" VARCHAR(120) NOT NULL,
  "description" VARCHAR(500) NOT NULL,
  "version" VARCHAR(120) NOT NULL,
  "status" "GuardrailPolicyStatus" NOT NULL DEFAULT 'DRAFT',
  "liteLLMGuardrails" TEXT[] NOT NULL,
  "maxInputCharacters" INTEGER NOT NULL,
  "activationEvaluationId" UUID,
  "firstActivatedAt" TIMESTAMPTZ(6),
  "revision" INTEGER NOT NULL DEFAULT 1,
  "createdBy" UUID,
  "updatedBy" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "GuardrailPolicy_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GuardrailPolicy_limits_check" CHECK (
    cardinality("liteLLMGuardrails") BETWEEN 1 AND 20
    AND "maxInputCharacters" BETWEEN 256 AND 32000
    AND "revision" > 0
  ),
  CONSTRAINT "GuardrailPolicy_activation_evidence_check" CHECK (
    "status" <> 'ACTIVE'::"GuardrailPolicyStatus"
    OR ("activationEvaluationId" IS NOT NULL AND "firstActivatedAt" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "GuardrailPolicy_slug_key" ON "GuardrailPolicy"("slug");
CREATE UNIQUE INDEX "GuardrailPolicy_single_active_key"
  ON "GuardrailPolicy"((true))
  WHERE "status" = 'ACTIVE'::"GuardrailPolicyStatus";
CREATE INDEX "GuardrailPolicy_status_updatedAt_idx" ON "GuardrailPolicy"("status", "updatedAt");
CREATE INDEX "GuardrailPolicy_activationEvaluationId_idx" ON "GuardrailPolicy"("activationEvaluationId");

ALTER TABLE "GuardrailPolicy"
  ADD CONSTRAINT "GuardrailPolicy_activationEvaluationId_fkey"
  FOREIGN KEY ("activationEvaluationId") REFERENCES "EvaluationRun"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
