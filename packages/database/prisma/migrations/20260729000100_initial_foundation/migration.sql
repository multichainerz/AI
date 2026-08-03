-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ServiceKind" AS ENUM ('LITELLM', 'VLLM', 'SUPERMEMORY', 'SEAWEEDFS', 'OCR', 'MCP', 'OIDC', 'SIEM', 'NOTIFICATION', 'OTHER');

-- CreateEnum
CREATE TYPE "DeploymentEnvironment" AS ENUM ('DEVELOPMENT', 'STAGING', 'PRODUCTION');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('NOT_TESTED', 'HEALTHY', 'DEGRADED', 'UNREACHABLE', 'DISABLED');

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('USER', 'SERVICE', 'SYSTEM');

-- CreateTable
CREATE TABLE "ServiceConnection" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(64) NOT NULL,
    "displayName" VARCHAR(120) NOT NULL,
    "kind" "ServiceKind" NOT NULL,
    "environment" "DeploymentEnvironment" NOT NULL,
    "baseUrl" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'NOT_TESTED',
    "configuration" JSONB NOT NULL DEFAULT '{}',
    "activeRevision" INTEGER NOT NULL DEFAULT 1,
    "lastHealthcheckAt" TIMESTAMPTZ(6),
    "lastHealthcheckMessage" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ServiceConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecretRecord" (
    "id" UUID NOT NULL,
    "serviceConnectionId" UUID NOT NULL,
    "fieldName" VARCHAR(120) NOT NULL,
    "encryptedValue" BYTEA NOT NULL,
    "valueNonce" BYTEA NOT NULL,
    "valueAuthTag" BYTEA NOT NULL,
    "wrappedDataKey" BYTEA NOT NULL,
    "keyNonce" BYTEA NOT NULL,
    "keyAuthTag" BYTEA NOT NULL,
    "encryptionVersion" INTEGER NOT NULL DEFAULT 1,
    "masterKeyVersion" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt" TIMESTAMPTZ(6),

    CONSTRAINT "SecretRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConfigurationRevision" (
    "id" UUID NOT NULL,
    "serviceConnectionId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "configuration" JSONB NOT NULL,
    "secretFieldNames" TEXT[],
    "checksum" VARCHAR(64) NOT NULL,
    "createdBy" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMPTZ(6),

    CONSTRAINT "ConfigurationRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" UUID NOT NULL,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorType" "AuditActorType" NOT NULL,
    "actorId" UUID,
    "action" VARCHAR(160) NOT NULL,
    "resourceType" VARCHAR(120) NOT NULL,
    "resourceId" VARCHAR(160),
    "outcome" VARCHAR(40) NOT NULL,
    "correlationId" UUID,
    "sourceIp" INET,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ServiceConnection_slug_key" ON "ServiceConnection"("slug");
CREATE INDEX "ServiceConnection_kind_environment_idx" ON "ServiceConnection"("kind", "environment");
CREATE INDEX "ServiceConnection_enabled_status_idx" ON "ServiceConnection"("enabled", "status");
CREATE INDEX "SecretRecord_serviceConnectionId_fieldName_active_idx" ON "SecretRecord"("serviceConnectionId", "fieldName", "active");
CREATE INDEX "SecretRecord_createdAt_idx" ON "SecretRecord"("createdAt");
CREATE INDEX "ConfigurationRevision_createdAt_idx" ON "ConfigurationRevision"("createdAt");
CREATE UNIQUE INDEX "ConfigurationRevision_serviceConnectionId_revision_key" ON "ConfigurationRevision"("serviceConnectionId", "revision");
CREATE INDEX "AuditEvent_occurredAt_idx" ON "AuditEvent"("occurredAt");
CREATE INDEX "AuditEvent_resourceType_resourceId_idx" ON "AuditEvent"("resourceType", "resourceId");
CREATE INDEX "AuditEvent_actorId_occurredAt_idx" ON "AuditEvent"("actorId", "occurredAt");
CREATE INDEX "AuditEvent_correlationId_idx" ON "AuditEvent"("correlationId");

-- AddForeignKey
ALTER TABLE "SecretRecord" ADD CONSTRAINT "SecretRecord_serviceConnectionId_fkey" FOREIGN KEY ("serviceConnectionId") REFERENCES "ServiceConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConfigurationRevision" ADD CONSTRAINT "ConfigurationRevision_serviceConnectionId_fkey" FOREIGN KEY ("serviceConnectionId") REFERENCES "ServiceConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
