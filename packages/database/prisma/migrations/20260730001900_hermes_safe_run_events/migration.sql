ALTER TYPE "AgentProfileStatus" ADD VALUE IF NOT EXISTS 'STANDBY';

CREATE TABLE "AgentRunEvent" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "sourceEventId" VARCHAR(255),
    "type" VARCHAR(80) NOT NULL,
    "summary" VARCHAR(1000),
    "status" VARCHAR(80),
    "toolName" VARCHAR(160),
    "childSessionId" VARCHAR(255),
    "durationMs" INTEGER,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "costUsd" DECIMAL(18,8),
    "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentRunEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AgentRunEvent_runId_sourceEventId_key" ON "AgentRunEvent"("runId", "sourceEventId");
CREATE INDEX "AgentRunEvent_runId_occurredAt_id_idx" ON "AgentRunEvent"("runId", "occurredAt", "id");

ALTER TABLE "AgentRunEvent"
ADD CONSTRAINT "AgentRunEvent_runId_fkey"
FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
