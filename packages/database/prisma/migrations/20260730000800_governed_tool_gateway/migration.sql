CREATE TYPE "ToolRisk" AS ENUM ('READ_ONLY', 'CONSEQUENTIAL');
CREATE TYPE "ToolStatus" AS ENUM ('ACTIVE', 'SUSPENDED');
CREATE TYPE "ToolCallStatus" AS ENUM ('REQUESTED', 'APPROVAL_PENDING', 'EXECUTING', 'COMPLETED', 'FAILED', 'DENIED', 'CANCELLED');
CREATE TYPE "ToolApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED');
CREATE TYPE "ToolResourceScope" AS ENUM ('OWNER_ONLY');

ALTER TABLE "AgentRun"
  ADD COLUMN "toolCapabilityTokenHash" BYTEA,
  ADD COLUMN "toolCapabilityExpiresAt" TIMESTAMPTZ(6),
  ADD CONSTRAINT "AgentRun_toolCapability_pair_check" CHECK (
    ("toolCapabilityTokenHash" IS NULL AND "toolCapabilityExpiresAt" IS NULL)
    OR (octet_length("toolCapabilityTokenHash") = 32 AND "toolCapabilityExpiresAt" IS NOT NULL)
  );

CREATE TABLE "GovernedTool" (
  "id" UUID NOT NULL,
  "slug" VARCHAR(80) NOT NULL,
  "displayName" VARCHAR(120) NOT NULL,
  "description" VARCHAR(1000) NOT NULL,
  "risk" "ToolRisk" NOT NULL,
  "status" "ToolStatus" NOT NULL DEFAULT 'ACTIVE',
  "handlerKey" VARCHAR(120) NOT NULL,
  "inputSchema" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "GovernedTool_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentToolGrant" (
  "id" UUID NOT NULL,
  "profileVersionId" UUID NOT NULL,
  "toolId" UUID NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "allowedGroups" TEXT[] NOT NULL,
  "allowedAdminRoles" "AdministratorRole"[] NOT NULL,
  "resourceScope" "ToolResourceScope" NOT NULL DEFAULT 'OWNER_ONLY',
  "createdBy" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "AgentToolGrant_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AgentToolGrant_principal_check" CHECK (
    cardinality("allowedGroups") > 0 OR cardinality("allowedAdminRoles") > 0
  )
);

CREATE TABLE "McpGatewayCredential" (
  "id" UUID NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "tokenPrefix" VARCHAR(32) NOT NULL,
  "tokenHash" BYTEA NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "lastUsedAt" TIMESTAMPTZ(6),
  "revokedAt" TIMESTAMPTZ(6),
  "createdBy" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "McpGatewayCredential_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "McpGatewayCredential_tokenHash_check" CHECK (octet_length("tokenHash") = 32)
);

CREATE TABLE "GovernedToolCall" (
  "id" UUID NOT NULL,
  "runId" UUID NOT NULL,
  "toolId" UUID NOT NULL,
  "grantId" UUID NOT NULL,
  "requestId" UUID NOT NULL,
  "status" "ToolCallStatus" NOT NULL DEFAULT 'REQUESTED',
  "arguments" JSONB NOT NULL,
  "result" JSONB,
  "errorCode" VARCHAR(80),
  "errorMessage" VARCHAR(500),
  "requestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMPTZ(6),
  "completedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "GovernedToolCall_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GovernedToolCall_arguments_object_check" CHECK (jsonb_typeof("arguments") = 'object')
);

CREATE TABLE "ToolApproval" (
  "id" UUID NOT NULL,
  "callId" UUID NOT NULL,
  "status" "ToolApprovalStatus" NOT NULL DEFAULT 'PENDING',
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "decisionReason" VARCHAR(1000),
  "decisionBy" UUID,
  "decidedAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "ToolApproval_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ToolRuntimeControl" (
  "id" VARCHAR(32) NOT NULL DEFAULT 'global',
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "reason" VARCHAR(500),
  "approvalTtlMinutes" INTEGER NOT NULL DEFAULT 15,
  "updatedBy" UUID,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "ToolRuntimeControl_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ToolRuntimeControl_approvalTtlMinutes_check" CHECK ("approvalTtlMinutes" BETWEEN 5 AND 1440)
);

CREATE UNIQUE INDEX "GovernedTool_slug_key" ON "GovernedTool"("slug");
CREATE INDEX "GovernedTool_status_risk_idx" ON "GovernedTool"("status", "risk");
CREATE UNIQUE INDEX "AgentToolGrant_profileVersionId_toolId_key" ON "AgentToolGrant"("profileVersionId", "toolId");
CREATE INDEX "AgentToolGrant_toolId_enabled_idx" ON "AgentToolGrant"("toolId", "enabled");
CREATE UNIQUE INDEX "McpGatewayCredential_tokenPrefix_key" ON "McpGatewayCredential"("tokenPrefix");
CREATE UNIQUE INDEX "McpGatewayCredential_tokenHash_key" ON "McpGatewayCredential"("tokenHash");
CREATE INDEX "McpGatewayCredential_enabled_revokedAt_idx" ON "McpGatewayCredential"("enabled", "revokedAt");
CREATE UNIQUE INDEX "GovernedToolCall_runId_requestId_key" ON "GovernedToolCall"("runId", "requestId");
CREATE INDEX "GovernedToolCall_runId_createdAt_idx" ON "GovernedToolCall"("runId", "createdAt");
CREATE INDEX "GovernedToolCall_toolId_status_createdAt_idx" ON "GovernedToolCall"("toolId", "status", "createdAt");
CREATE INDEX "GovernedToolCall_status_requestedAt_idx" ON "GovernedToolCall"("status", "requestedAt");
CREATE UNIQUE INDEX "ToolApproval_callId_key" ON "ToolApproval"("callId");
CREATE INDEX "ToolApproval_status_expiresAt_idx" ON "ToolApproval"("status", "expiresAt");

ALTER TABLE "AgentToolGrant" ADD CONSTRAINT "AgentToolGrant_profileVersionId_fkey" FOREIGN KEY ("profileVersionId") REFERENCES "AgentProfileVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentToolGrant" ADD CONSTRAINT "AgentToolGrant_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "GovernedTool"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GovernedToolCall" ADD CONSTRAINT "GovernedToolCall_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GovernedToolCall" ADD CONSTRAINT "GovernedToolCall_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "GovernedTool"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GovernedToolCall" ADD CONSTRAINT "GovernedToolCall_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "AgentToolGrant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ToolApproval" ADD CONSTRAINT "ToolApproval_callId_fkey" FOREIGN KEY ("callId") REFERENCES "GovernedToolCall"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "GovernedTool" ("id", "slug", "displayName", "description", "risk", "status", "handlerKey", "inputSchema", "updatedAt") VALUES
  ('d160a1a0-7218-48a4-8a9f-7e1681280fe4', 'document_metadata_read', 'Read document metadata', 'Read lifecycle and memory-publication metadata for one document owned by the requesting user.', 'READ_ONLY', 'ACTIVE', 'builtin.document_metadata_read', '{"type":"object","properties":{"documentId":{"type":"string","format":"uuid"}},"required":["documentId"],"additionalProperties":false}'::jsonb, CURRENT_TIMESTAMP),
  ('d260a1a0-7218-48a4-8a9f-7e1681280fe4', 'document_memory_resync', 'Resynchronize document memory', 'Queue a new Supermemory publication generation for one ready document owned by the requesting user. Human approval is mandatory.', 'CONSEQUENTIAL', 'ACTIVE', 'builtin.document_memory_resync', '{"type":"object","properties":{"documentId":{"type":"string","format":"uuid"}},"required":["documentId"],"additionalProperties":false}'::jsonb, CURRENT_TIMESTAMP);

INSERT INTO "ToolRuntimeControl" ("id", "enabled", "reason", "approvalTtlMinutes", "updatedAt")
VALUES ('global', false, 'Phase 6 gateway acceptance is pending.', 15, CURRENT_TIMESTAMP);
