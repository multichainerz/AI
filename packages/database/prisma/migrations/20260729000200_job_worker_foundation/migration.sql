CREATE TYPE "WorkerLifecycleStatus" AS ENUM ('ONLINE', 'STOPPED');

CREATE TABLE "WorkerNode" (
    "id" VARCHAR(160) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "version" VARCHAR(40) NOT NULL,
    "status" "WorkerLifecycleStatus" NOT NULL DEFAULT 'ONLINE',
    "queues" TEXT[],
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "startedAt" TIMESTAMPTZ(6) NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(6) NOT NULL,
    "stoppedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "WorkerNode_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WorkerNode_status_lastSeenAt_idx" ON "WorkerNode"("status", "lastSeenAt");
