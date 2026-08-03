CREATE TYPE "HermesRuntimeNodeStatus" AS ENUM ('PENDING', 'ONLINE', 'DEGRADED', 'DRAINING', 'SUSPENDED', 'REVOKED', 'OFFLINE');
CREATE TYPE "HermesNodeEnrollmentStatus" AS ENUM ('ISSUED', 'CONSUMED', 'REVOKED', 'EXPIRED');

CREATE TABLE "HermesRuntimeNode" (
  "id" UUID NOT NULL,
  "slug" VARCHAR(64) NOT NULL,
  "displayName" VARCHAR(120) NOT NULL,
  "baseUrl" TEXT NOT NULL,
  "expectedHostname" VARCHAR(253),
  "hostname" VARCHAR(253),
  "status" "HermesRuntimeNodeStatus" NOT NULL DEFAULT 'PENDING',
  "identityPublicKeyPem" TEXT,
  "identityFingerprint" VARCHAR(64),
  "hermesVersion" VARCHAR(120),
  "installerVersion" VARCHAR(120),
  "capabilities" JSONB NOT NULL DEFAULT '[]',
  "serviceConnectionId" UUID,
  "lastSeenAt" TIMESTAMPTZ(6),
  "enrolledAt" TIMESTAMPTZ(6),
  "revokedAt" TIMESTAMPTZ(6),
  "revision" INTEGER NOT NULL DEFAULT 0,
  "createdBy" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "HermesRuntimeNode_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HermesNodeEnrollment" (
  "id" UUID NOT NULL,
  "nodeId" UUID NOT NULL,
  "tokenHash" BYTEA NOT NULL,
  "status" "HermesNodeEnrollmentStatus" NOT NULL DEFAULT 'ISSUED',
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "consumedAt" TIMESTAMPTZ(6),
  "revokedAt" TIMESTAMPTZ(6),
  "consumedSourceIp" INET,
  "createdBy" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "HermesNodeEnrollment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HermesNodeRequestNonce" (
  "id" UUID NOT NULL,
  "nodeId" UUID NOT NULL,
  "nonce" UUID NOT NULL,
  "receivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HermesNodeRequestNonce_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HermesRuntimeNode_slug_key" ON "HermesRuntimeNode"("slug");
CREATE UNIQUE INDEX "HermesRuntimeNode_identityFingerprint_key" ON "HermesRuntimeNode"("identityFingerprint");
CREATE UNIQUE INDEX "HermesRuntimeNode_serviceConnectionId_key" ON "HermesRuntimeNode"("serviceConnectionId");
CREATE INDEX "HermesRuntimeNode_status_lastSeenAt_idx" ON "HermesRuntimeNode"("status", "lastSeenAt");
CREATE INDEX "HermesRuntimeNode_createdAt_idx" ON "HermesRuntimeNode"("createdAt");
CREATE UNIQUE INDEX "HermesNodeEnrollment_tokenHash_key" ON "HermesNodeEnrollment"("tokenHash");
CREATE INDEX "HermesNodeEnrollment_nodeId_status_idx" ON "HermesNodeEnrollment"("nodeId", "status");
CREATE INDEX "HermesNodeEnrollment_status_expiresAt_idx" ON "HermesNodeEnrollment"("status", "expiresAt");
CREATE UNIQUE INDEX "HermesNodeRequestNonce_nodeId_nonce_key" ON "HermesNodeRequestNonce"("nodeId", "nonce");
CREATE INDEX "HermesNodeRequestNonce_receivedAt_idx" ON "HermesNodeRequestNonce"("receivedAt");

ALTER TABLE "HermesRuntimeNode" ADD CONSTRAINT "HermesRuntimeNode_serviceConnectionId_fkey" FOREIGN KEY ("serviceConnectionId") REFERENCES "ServiceConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "HermesNodeEnrollment" ADD CONSTRAINT "HermesNodeEnrollment_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "HermesRuntimeNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HermesNodeRequestNonce" ADD CONSTRAINT "HermesNodeRequestNonce_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "HermesRuntimeNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
