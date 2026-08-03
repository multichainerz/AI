CREATE TYPE "AdministratorRole" AS ENUM (
    'PLATFORM_ADMIN',
    'SECURITY_ADMIN',
    'OPERATIONS_ADMIN',
    'AUDITOR'
);

CREATE TABLE "AdministratorSession" (
    "id" UUID NOT NULL,
    "tokenHash" BYTEA NOT NULL,
    "subject" VARCHAR(160) NOT NULL,
    "role" "AdministratorRole" NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(6) NOT NULL,
    "idleExpiresAt" TIMESTAMPTZ(6) NOT NULL,
    "absoluteExpiresAt" TIMESTAMPTZ(6) NOT NULL,
    "revokedAt" TIMESTAMPTZ(6),
    "sourceIp" INET,
    "userAgentHash" VARCHAR(64),

    CONSTRAINT "AdministratorSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdministratorSession_tokenHash_key"
ON "AdministratorSession"("tokenHash");

CREATE INDEX "AdministratorSession_revokedAt_idleExpiresAt_idx"
ON "AdministratorSession"("revokedAt", "idleExpiresAt");

CREATE INDEX "AdministratorSession_absoluteExpiresAt_idx"
ON "AdministratorSession"("absoluteExpiresAt");

CREATE INDEX "AdministratorSession_subject_createdAt_idx"
ON "AdministratorSession"("subject", "createdAt");

CREATE INDEX "WorkerNode_lastSeenAt_idx"
ON "WorkerNode"("lastSeenAt");
