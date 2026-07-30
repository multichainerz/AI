CREATE TYPE "PromptPurpose" AS ENUM ('CHAT_SYSTEM');
CREATE TYPE "PromptTemplateStatus" AS ENUM ('DRAFT', 'ACTIVE', 'SUSPENDED');

CREATE TABLE "PromptTemplate" (
  "id" UUID NOT NULL,
  "slug" VARCHAR(64) NOT NULL,
  "displayName" VARCHAR(120) NOT NULL,
  "description" VARCHAR(500) NOT NULL,
  "purpose" "PromptPurpose" NOT NULL,
  "version" VARCHAR(120) NOT NULL,
  "status" "PromptTemplateStatus" NOT NULL DEFAULT 'DRAFT',
  "content" TEXT NOT NULL,
  "contentChecksum" VARCHAR(64) NOT NULL,
  "activationEvaluationId" UUID,
  "firstActivatedAt" TIMESTAMPTZ(6),
  "revision" INTEGER NOT NULL DEFAULT 1,
  "createdBy" UUID,
  "updatedBy" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "PromptTemplate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PromptTemplate_content_check" CHECK (
    char_length(btrim("content")) BETWEEN 20 AND 20000
    AND "contentChecksum" ~ '^[a-f0-9]{64}$'
    AND "revision" > 0
  ),
  CONSTRAINT "PromptTemplate_activation_evidence_check" CHECK (
    "status" <> 'ACTIVE'::"PromptTemplateStatus"
    OR ("activationEvaluationId" IS NOT NULL AND "firstActivatedAt" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "PromptTemplate_slug_key" ON "PromptTemplate"("slug");
CREATE UNIQUE INDEX "PromptTemplate_single_active_purpose_key"
  ON "PromptTemplate"("purpose")
  WHERE "status" = 'ACTIVE'::"PromptTemplateStatus";
CREATE INDEX "PromptTemplate_purpose_status_idx" ON "PromptTemplate"("purpose", "status");
CREATE INDEX "PromptTemplate_activationEvaluationId_idx" ON "PromptTemplate"("activationEvaluationId");

ALTER TABLE "PromptTemplate"
  ADD CONSTRAINT "PromptTemplate_activationEvaluationId_fkey"
  FOREIGN KEY ("activationEvaluationId") REFERENCES "EvaluationRun"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
