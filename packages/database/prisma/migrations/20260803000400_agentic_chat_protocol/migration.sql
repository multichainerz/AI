ALTER TYPE "AgentRunStatus" ADD VALUE IF NOT EXISTS 'WAITING_FOR_APPROVAL' AFTER 'RUNNING';

CREATE TYPE "AgentRunApprovalStatus" AS ENUM (
  'PENDING',
  'APPROVED',
  'DENIED',
  'EXPIRED',
  'CANCELLED'
);

ALTER TABLE "ChatConversation"
  ADD COLUMN "hermesMemoryKey" VARCHAR(200);

UPDATE "ChatConversation"
SET "hermesMemoryKey" = gen_random_uuid()::text
WHERE "hermesMemoryKey" IS NULL;

ALTER TABLE "ChatConversation"
  ALTER COLUMN "hermesMemoryKey" SET NOT NULL;

ALTER TABLE "AgentRun"
  ADD COLUMN "memorySessionKey" VARCHAR(200),
  ADD COLUMN "conversationHistory" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "partialOutput" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "lastEventCursor" BIGINT,
  ADD COLUMN "outputCharacterLimit" INTEGER NOT NULL DEFAULT 200000,
  ADD COLUMN "modelAlias" VARCHAR(200),
  ADD COLUMN "inputTokens" INTEGER,
  ADD COLUMN "outputTokens" INTEGER,
  ADD COLUMN "reasoningTokens" INTEGER,
  ADD COLUMN "totalTokens" INTEGER,
  ADD COLUMN "finishReason" VARCHAR(120),
  ADD COLUMN "firstTokenAt" TIMESTAMPTZ(6);

ALTER TABLE "ChatMessage"
  ADD COLUMN "reasoningTokens" INTEGER,
  ADD COLUMN "firstTokenLatencyMs" INTEGER;

UPDATE "AgentRun"
SET "memorySessionKey" = "sessionId"
WHERE "memorySessionKey" IS NULL;

ALTER TABLE "AgentRun"
  ALTER COLUMN "memorySessionKey" SET NOT NULL;

ALTER TABLE "AgentRunEvent"
  ADD COLUMN "cursor" BIGSERIAL,
  ADD COLUMN "delta" TEXT,
  ADD COLUMN "preview" VARCHAR(1000),
  ADD COLUMN "errorCode" VARCHAR(80),
  ADD COLUMN "approvalId" UUID,
  ADD COLUMN "reasoningTokens" INTEGER;

CREATE UNIQUE INDEX "AgentRunEvent_cursor_key" ON "AgentRunEvent"("cursor");
CREATE INDEX "AgentRunEvent_runId_cursor_idx" ON "AgentRunEvent"("runId", "cursor");

CREATE TABLE "AgentRunApproval" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "runId" UUID NOT NULL,
  "externalApprovalId" VARCHAR(255),
  "status" "AgentRunApprovalStatus" NOT NULL DEFAULT 'PENDING',
  "command" VARCHAR(1000),
  "summary" VARCHAR(1000),
  "choices" JSONB NOT NULL DEFAULT '[]',
  "requestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "decidedAt" TIMESTAMPTZ(6),
  "decidedBy" UUID,
  "decision" VARCHAR(40),
  "forwardedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "AgentRunApproval_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AgentRunApproval_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "AgentRunApproval_runId_status_requestedAt_idx"
  ON "AgentRunApproval"("runId", "status", "requestedAt");
CREATE INDEX "AgentRunApproval_status_expiresAt_idx"
  ON "AgentRunApproval"("status", "expiresAt");
