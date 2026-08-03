-- Collapse the retired scratch/conversion/republication pipeline into the
-- verified Supermemory-native knowledge contract. PostgreSQL retains only
-- ownership, classification, lifecycle, external identity, and audit state.

UPDATE "Document"
SET
  "status" = 'FAILED'::"DocumentStatus",
  "failureCode" = 'LEGACY_PIPELINE_REMOVED',
  "failureMessage" = 'Re-upload this source through the direct Supermemory knowledge workflow.',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "deletedAt" IS NULL
  AND "status" IN ('QUARANTINED'::"DocumentStatus", 'CONVERTING'::"DocumentStatus")
  AND NOT EXISTS (
    SELECT 1
    FROM "DocumentMemoryPublication" AS publication
    WHERE publication."documentId" = "Document"."id"
      AND publication."externalDocumentId" IS NOT NULL
  );

UPDATE "ToolActionDispatch" AS dispatch
SET
  "status" = 'CANCELLED'::"ToolActionDispatchStatus",
  "lastError" = 'The legacy document-memory resynchronization handler was removed.',
  "completedAt" = CURRENT_TIMESTAMP,
  "updatedAt" = CURRENT_TIMESTAMP
FROM "GovernedToolCall" AS call,
     "GovernedTool" AS tool
WHERE dispatch."callId" = call."id"
  AND call."toolId" = tool."id"
  AND tool."handlerKey" = 'builtin.document_memory_resync'
  AND dispatch."status" IN ('PENDING'::"ToolActionDispatchStatus", 'PROCESSING'::"ToolActionDispatchStatus");

UPDATE "ToolApproval" AS approval
SET
  "status" = 'CANCELLED'::"ToolApprovalStatus",
  "decisionReason" = 'The legacy document-memory resynchronization handler was removed.',
  "decidedAt" = CURRENT_TIMESTAMP,
  "updatedAt" = CURRENT_TIMESTAMP
FROM "GovernedToolCall" AS call,
     "GovernedTool" AS tool
WHERE approval."callId" = call."id"
  AND call."toolId" = tool."id"
  AND tool."handlerKey" = 'builtin.document_memory_resync'
  AND approval."status" = 'PENDING'::"ToolApprovalStatus";

UPDATE "GovernedToolCall" AS call
SET
  "status" = 'CANCELLED'::"ToolCallStatus",
  "errorCode" = 'HANDLER_RETIRED',
  "errorMessage" = 'The legacy document-memory resynchronization handler was removed.',
  "completedAt" = CURRENT_TIMESTAMP,
  "updatedAt" = CURRENT_TIMESTAMP
FROM "GovernedTool" AS tool
WHERE call."toolId" = tool."id"
  AND tool."handlerKey" = 'builtin.document_memory_resync'
  AND call."status" IN (
    'REQUESTED'::"ToolCallStatus",
    'APPROVAL_PENDING'::"ToolCallStatus",
    'EXECUTING'::"ToolCallStatus"
  );

UPDATE "AgentToolGrant"
SET "enabled" = false, "updatedAt" = CURRENT_TIMESTAMP
WHERE "toolId" IN (
  SELECT "id" FROM "GovernedTool" WHERE "handlerKey" = 'builtin.document_memory_resync'
);

UPDATE "GovernedTool"
SET "status" = 'SUSPENDED'::"ToolStatus", "updatedAt" = CURRENT_TIMESTAMP
WHERE "handlerKey" = 'builtin.document_memory_resync';

UPDATE "OnboardingStep"
SET
  "description" = 'Validate direct Supermemory ingestion, indexing, authorized retrieval, and deletion.',
  "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'knowledge-workflow';

DROP TABLE "DocumentProcessingRun";

DROP INDEX "Document_stagingExpiresAt_stagingPurgedAt_idx";
DROP INDEX "DocumentMemoryPublication_sourceToolDispatchId_idx";

ALTER TABLE "Document"
  ALTER COLUMN "status" SET DEFAULT 'QUEUED'::"DocumentStatus",
  DROP COLUMN "stagingKey",
  DROP COLUMN "stagingExpiresAt",
  DROP COLUMN "stagingPurgedAt",
  DROP COLUMN "pageCount",
  DROP COLUMN "processingGeneration",
  DROP COLUMN "approvedAt",
  DROP COLUMN "approvedBy";

ALTER TABLE "DocumentMemoryPublication"
  DROP COLUMN "generation",
  DROP COLUMN "jobId",
  DROP COLUMN "sourceToolDispatchId";

-- Chat is now a Hermes Agent Run client rather than a second inference path.
-- A stable session identifier preserves conversation continuity while every
-- run retains a distinct idempotency key.
ALTER TABLE "ChatConversation"
  ADD COLUMN "profileId" UUID,
  ADD COLUMN "profileName" VARCHAR(120);

ALTER TABLE "AgentRun" ADD COLUMN "sessionId" VARCHAR(200);
UPDATE "AgentRun" SET "sessionId" = "id"::TEXT WHERE "sessionId" IS NULL;
ALTER TABLE "AgentRun" ALTER COLUMN "sessionId" SET NOT NULL;

ALTER TABLE "ChatMessage" ADD COLUMN "agentRunId" UUID;
CREATE UNIQUE INDEX "ChatMessage_agentRunId_key" ON "ChatMessage"("agentRunId");
ALTER TABLE "ChatMessage"
  ADD CONSTRAINT "ChatMessage_agentRunId_fkey"
  FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
