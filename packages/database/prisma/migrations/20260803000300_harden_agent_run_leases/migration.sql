ALTER TABLE "AgentRun"
ADD COLUMN "processorLeaseOwner" VARCHAR(160),
ADD COLUMN "processorLeaseExpiresAt" TIMESTAMPTZ(6);

CREATE INDEX "AgentRun_status_processorLeaseExpiresAt_idx"
ON "AgentRun"("status", "processorLeaseExpiresAt");
