CREATE TYPE "ToolActionDispatchStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED');

CREATE TABLE "ToolActionDispatch" (
  "id" UUID NOT NULL,
  "callId" UUID NOT NULL,
  "status" "ToolActionDispatchStatus" NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimedAt" TIMESTAMPTZ(6),
  "claimedBy" VARCHAR(200),
  "claimToken" UUID,
  "submittedJobId" UUID,
  "lastError" VARCHAR(500),
  "completedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "ToolActionDispatch_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ToolActionDispatch_attemptCount_check" CHECK ("attemptCount" >= 0),
  CONSTRAINT "ToolActionDispatch_claim_check" CHECK (
    (
      "status" = 'PROCESSING'
      AND "claimedAt" IS NOT NULL
      AND "claimedBy" IS NOT NULL
      AND "claimToken" IS NOT NULL
    ) OR (
      "status" <> 'PROCESSING'
      AND "claimedAt" IS NULL
      AND "claimedBy" IS NULL
      AND "claimToken" IS NULL
    )
  ),
  CONSTRAINT "ToolActionDispatch_completion_check" CHECK (
    ("status" IN ('COMPLETED', 'FAILED', 'CANCELLED') AND "completedAt" IS NOT NULL)
    OR ("status" IN ('PENDING', 'PROCESSING') AND "completedAt" IS NULL)
  )
);

ALTER TABLE "DocumentMemoryPublication"
  ADD COLUMN "sourceToolDispatchId" UUID;

CREATE UNIQUE INDEX "ToolActionDispatch_callId_key" ON "ToolActionDispatch"("callId");
CREATE INDEX "ToolActionDispatch_status_nextAttemptAt_idx" ON "ToolActionDispatch"("status", "nextAttemptAt");
CREATE INDEX "ToolActionDispatch_claimedAt_idx" ON "ToolActionDispatch"("claimedAt");
CREATE INDEX "DocumentMemoryPublication_sourceToolDispatchId_idx" ON "DocumentMemoryPublication"("sourceToolDispatchId");

ALTER TABLE "ToolActionDispatch"
  ADD CONSTRAINT "ToolActionDispatch_callId_fkey"
  FOREIGN KEY ("callId") REFERENCES "GovernedToolCall"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Recover approvals that may have reached EXECUTING before this outbox existed.
INSERT INTO "ToolActionDispatch" (
  "id", "callId", "status", "attemptCount", "nextAttemptAt", "createdAt", "updatedAt"
)
SELECT
  gen_random_uuid(), call."id", 'PENDING', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "GovernedToolCall" AS call
INNER JOIN "ToolApproval" AS approval ON approval."callId" = call."id"
WHERE call."status" = 'EXECUTING'
  AND approval."status" = 'APPROVED'
ON CONFLICT ("callId") DO NOTHING;
