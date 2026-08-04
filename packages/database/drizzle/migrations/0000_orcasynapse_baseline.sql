CREATE TYPE "public"."AdministratorAuthenticationMethod" AS ENUM('LOCAL_PASSWORD', 'INSTALLATION_KEY_RECOVERY', 'OIDC');--> statement-breakpoint
CREATE TYPE "public"."AdministratorRole" AS ENUM('PLATFORM_ADMIN', 'SECURITY_ADMIN', 'OPERATIONS_ADMIN', 'AUDITOR');--> statement-breakpoint
CREATE TYPE "public"."AgentProfileStatus" AS ENUM('DRAFT', 'ACTIVE', 'SUSPENDED', 'STANDBY');--> statement-breakpoint
CREATE TYPE "public"."AgentRunApprovalStatus" AS ENUM('PENDING', 'APPROVED', 'DENIED', 'EXPIRED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."AgentRunStatus" AS ENUM('QUEUED', 'RUNNING', 'WAITING_FOR_APPROVAL', 'CANCEL_REQUESTED', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'DENIED');--> statement-breakpoint
CREATE TYPE "public"."AuditActorType" AS ENUM('USER', 'SERVICE', 'SYSTEM');--> statement-breakpoint
CREATE TYPE "public"."ChatConversationStatus" AS ENUM('ACTIVE', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."ChatFeedbackRating" AS ENUM('HELPFUL', 'NOT_HELPFUL');--> statement-breakpoint
CREATE TYPE "public"."ChatMessageRole" AS ENUM('USER', 'ASSISTANT');--> statement-breakpoint
CREATE TYPE "public"."ChatMessageStatus" AS ENUM('PENDING', 'COMPLETED', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."ComponentCompatibilityStatus" AS ENUM('NOT_TESTED', 'IN_PROGRESS', 'PASSED', 'FAILED', 'BLOCKED');--> statement-breakpoint
CREATE TYPE "public"."ConnectionStatus" AS ENUM('NOT_TESTED', 'HEALTHY', 'DEGRADED', 'UNREACHABLE', 'DISABLED');--> statement-breakpoint
CREATE TYPE "public"."DeploymentEnvironment" AS ENUM('DEVELOPMENT', 'STAGING', 'PRODUCTION');--> statement-breakpoint
CREATE TYPE "public"."DeploymentTopologyMode" AS ENUM('COMPACT', 'CONTROL_PLANE', 'SEGMENTED_PRODUCTION');--> statement-breakpoint
CREATE TYPE "public"."DocumentClassification" AS ENUM('INTERNAL', 'CONFIDENTIAL', 'RESTRICTED');--> statement-breakpoint
CREATE TYPE "public"."DocumentStatus" AS ENUM('QUARANTINED', 'QUEUED', 'CONVERTING', 'READY', 'FAILED', 'REJECTED', 'DELETING', 'DELETED');--> statement-breakpoint
CREATE TYPE "public"."EvaluationRunStatus" AS ENUM('DRAFT', 'PASSED', 'FAILED', 'PROMOTED');--> statement-breakpoint
CREATE TYPE "public"."EvaluationTargetType" AS ENUM('MODEL', 'PROMPT', 'POLICY', 'AGENT');--> statement-breakpoint
CREATE TYPE "public"."GuardrailPolicyStatus" AS ENUM('DRAFT', 'ACTIVE', 'SUSPENDED');--> statement-breakpoint
CREATE TYPE "public"."HermesNodeEnrollmentStatus" AS ENUM('ISSUED', 'CONSUMED', 'REVOKED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."HermesRuntimeNodeStatus" AS ENUM('PENDING', 'ONLINE', 'DEGRADED', 'DRAINING', 'SUSPENDED', 'REVOKED', 'OFFLINE');--> statement-breakpoint
CREATE TYPE "public"."MemorySyncStatus" AS ENUM('NOT_INDEXED', 'QUEUED', 'PROCESSING', 'READY', 'FAILED', 'DELETE_PENDING', 'DELETED');--> statement-breakpoint
CREATE TYPE "public"."ModelDeploymentStatus" AS ENUM('DRAFT', 'ACTIVE', 'SUSPENDED');--> statement-breakpoint
CREATE TYPE "public"."ModelWorkload" AS ENUM('CHAT', 'AGENT');--> statement-breakpoint
CREATE TYPE "public"."OnboardingEvidenceOutcome" AS ENUM('PASSED', 'FAILED', 'WARNING');--> statement-breakpoint
CREATE TYPE "public"."OnboardingEvidenceSource" AS ENUM('AUTOMATED', 'EXTERNAL_ATTESTATION');--> statement-breakpoint
CREATE TYPE "public"."OnboardingJourneyStatus" AS ENUM('NOT_STARTED', 'IN_PROGRESS', 'BLOCKED', 'COMPLETED');--> statement-breakpoint
CREATE TYPE "public"."OnboardingStepStatus" AS ENUM('NOT_STARTED', 'IN_PROGRESS', 'BLOCKED', 'COMPLETED');--> statement-breakpoint
CREATE TYPE "public"."OnboardingTargetEnvironment" AS ENUM('DEVELOPMENT', 'PILOT', 'PRODUCTION');--> statement-breakpoint
CREATE TYPE "public"."OperationalIncidentSeverity" AS ENUM('WARNING', 'CRITICAL');--> statement-breakpoint
CREATE TYPE "public"."OperationalIncidentStatus" AS ENUM('OPEN', 'ACKNOWLEDGED', 'RESOLVED');--> statement-breakpoint
CREATE TYPE "public"."ProductionReadinessApprovalDecision" AS ENUM('APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."ProductionReadinessApprovalRole" AS ENUM('SECURITY', 'INFRASTRUCTURE', 'PRODUCT', 'BUSINESS');--> statement-breakpoint
CREATE TYPE "public"."ProductionReadinessControlStatus" AS ENUM('NOT_STARTED', 'IN_PROGRESS', 'BLOCKED', 'VERIFIED', 'WAIVED');--> statement-breakpoint
CREATE TYPE "public"."ProductionReadinessDomain" AS ENUM('SECURITY', 'INFRASTRUCTURE', 'RECOVERY', 'OPERATIONS', 'TRAINING', 'BUSINESS');--> statement-breakpoint
CREATE TYPE "public"."PromptPurpose" AS ENUM('CHAT_SYSTEM');--> statement-breakpoint
CREATE TYPE "public"."PromptTemplateStatus" AS ENUM('DRAFT', 'ACTIVE', 'SUSPENDED');--> statement-breakpoint
CREATE TYPE "public"."ServiceKind" AS ENUM('INFERENCE', 'HERMES', 'SUPERMEMORY', 'MCP', 'OIDC', 'SIEM', 'NOTIFICATION', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."ToolActionDispatchStatus" AS ENUM('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."ToolApprovalStatus" AS ENUM('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."ToolCallStatus" AS ENUM('REQUESTED', 'APPROVAL_PENDING', 'EXECUTING', 'COMPLETED', 'FAILED', 'DENIED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."ToolResourceScope" AS ENUM('OWNER_ONLY');--> statement-breakpoint
CREATE TYPE "public"."ToolRisk" AS ENUM('READ_ONLY', 'CONSEQUENTIAL');--> statement-breakpoint
CREATE TYPE "public"."ToolStatus" AS ENUM('ACTIVE', 'SUSPENDED');--> statement-breakpoint
CREATE TYPE "public"."WorkerLifecycleStatus" AS ENUM('ONLINE', 'STOPPED');--> statement-breakpoint
CREATE TABLE "AdministratorSession" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tokenHash" "bytea" NOT NULL,
	"subject" varchar(160) NOT NULL,
	"role" "AdministratorRole" NOT NULL,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"lastSeenAt" timestamp (6) with time zone NOT NULL,
	"idleExpiresAt" timestamp (6) with time zone NOT NULL,
	"absoluteExpiresAt" timestamp (6) with time zone NOT NULL,
	"revokedAt" timestamp (6) with time zone,
	"sourceIp" "inet",
	"userAgentHash" varchar(64),
	"authenticationMethod" "AdministratorAuthenticationMethod" DEFAULT 'LOCAL_PASSWORD' NOT NULL,
	"passwordChangeRequired" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "AgentProfile" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(64) NOT NULL,
	"status" "AgentProfileStatus" DEFAULT 'DRAFT' NOT NULL,
	"currentVersion" integer DEFAULT 1 NOT NULL,
	"activeVersion" integer,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (6) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "AgentProfileVersion" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profileId" uuid NOT NULL,
	"version" integer NOT NULL,
	"displayName" varchar(120) NOT NULL,
	"purpose" varchar(500) NOT NULL,
	"instructions" text NOT NULL,
	"modelAlias" varchar(200) NOT NULL,
	"maxTurns" integer NOT NULL,
	"timeoutSeconds" integer NOT NULL,
	"maxConcurrentRuns" integer NOT NULL,
	"allowPrivateKnowledge" boolean DEFAULT false NOT NULL,
	"safeMode" boolean DEFAULT true NOT NULL,
	"createdBy" uuid,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"soulMd" text DEFAULT '' NOT NULL,
	"skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"distributionDigest" varchar(64),
	CONSTRAINT "AgentProfileVersion_phase5_boundary_check" CHECK (("maxTurns" = 1) AND ("safeMode" = true))
);
--> statement-breakpoint
CREATE TABLE "AgentRun" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profileId" uuid NOT NULL,
	"profileVersionId" uuid NOT NULL,
	"profileVersion" integer NOT NULL,
	"ownerSubject" varchar(200) NOT NULL,
	"requestedBy" uuid NOT NULL,
	"status" "AgentRunStatus" DEFAULT 'QUEUED' NOT NULL,
	"input" text NOT NULL,
	"output" text,
	"effectiveCapabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"externalRunId" varchar(255),
	"jobId" uuid,
	"failureCode" varchar(80),
	"failureMessage" varchar(500),
	"queuedAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"startedAt" timestamp (6) with time zone,
	"completedAt" timestamp (6) with time zone,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (6) with time zone NOT NULL,
	"toolCapabilityTokenHash" "bytea",
	"toolCapabilityExpiresAt" timestamp (6) with time zone,
	"profileDistributionDigest" varchar(64),
	"sessionId" varchar(200) NOT NULL,
	"processorLeaseOwner" varchar(160),
	"processorLeaseExpiresAt" timestamp (6) with time zone,
	"memorySessionKey" varchar(200) NOT NULL,
	"conversationHistory" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"partialOutput" text DEFAULT '' NOT NULL,
	"lastEventCursor" bigint,
	"outputCharacterLimit" integer DEFAULT 200000 NOT NULL,
	"modelAlias" varchar(200),
	"inputTokens" integer,
	"outputTokens" integer,
	"reasoningTokens" integer,
	"totalTokens" integer,
	"finishReason" varchar(120),
	"firstTokenAt" timestamp (6) with time zone,
	CONSTRAINT "AgentRun_toolCapability_pair_check" CHECK ((("toolCapabilityTokenHash" IS NULL) AND ("toolCapabilityExpiresAt" IS NULL)) OR ((octet_length("toolCapabilityTokenHash") = 32) AND ("toolCapabilityExpiresAt" IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "AgentRunApproval" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"runId" uuid NOT NULL,
	"externalApprovalId" varchar(255),
	"status" "AgentRunApprovalStatus" DEFAULT 'PENDING' NOT NULL,
	"command" varchar(1000),
	"summary" varchar(1000),
	"choices" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requestedAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"expiresAt" timestamp (6) with time zone NOT NULL,
	"decidedAt" timestamp (6) with time zone,
	"decidedBy" uuid,
	"decision" varchar(40),
	"forwardedAt" timestamp (6) with time zone,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (6) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "AgentRunEvent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"runId" uuid NOT NULL,
	"sourceEventId" varchar(255),
	"type" varchar(80) NOT NULL,
	"summary" varchar(1000),
	"status" varchar(80),
	"toolName" varchar(160),
	"childSessionId" varchar(255),
	"durationMs" integer,
	"inputTokens" integer,
	"outputTokens" integer,
	"costUsd" numeric(18, 8),
	"occurredAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"cursor" bigserial NOT NULL,
	"delta" text,
	"preview" varchar(1000),
	"errorCode" varchar(80),
	"approvalId" uuid,
	"reasoningTokens" integer
);
--> statement-breakpoint
CREATE TABLE "AgentRuntimeControl" (
	"id" varchar(32) PRIMARY KEY DEFAULT 'global' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"reason" varchar(500),
	"updatedBy" uuid,
	"updatedAt" timestamp (6) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "AgentToolGrant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profileVersionId" uuid NOT NULL,
	"toolId" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"allowedGroups" text[] NOT NULL,
	"allowedAdminRoles" "bytea"[] NOT NULL,
	"resourceScope" "ToolResourceScope" DEFAULT 'OWNER_ONLY' NOT NULL,
	"createdBy" uuid,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (6) with time zone NOT NULL,
	CONSTRAINT "AgentToolGrant_principal_check" CHECK ((cardinality("allowedGroups") > 0) OR (cardinality("allowedAdminRoles") > 0))
);
--> statement-breakpoint
CREATE TABLE "AuditEvent" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurredAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"actorType" "AuditActorType" NOT NULL,
	"actorId" uuid,
	"action" varchar(160) NOT NULL,
	"resourceType" varchar(120) NOT NULL,
	"resourceId" varchar(160),
	"outcome" varchar(40) NOT NULL,
	"correlationId" uuid,
	"sourceIp" "inet",
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ChatConversation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ownerSubject" varchar(200) NOT NULL,
	"title" varchar(160) NOT NULL,
	"modelAlias" varchar(200) NOT NULL,
	"status" "ChatConversationStatus" DEFAULT 'ACTIVE' NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"lastMessageAt" timestamp (6) with time zone,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (6) with time zone NOT NULL,
	"profileId" uuid,
	"profileName" varchar(120),
	"hermesMemoryKey" varchar(200) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ChatFeedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"messageId" uuid NOT NULL,
	"ownerSubject" varchar(200) NOT NULL,
	"rating" "ChatFeedbackRating" NOT NULL,
	"comment" varchar(1000),
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (6) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ChatMessage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversationId" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"role" "ChatMessageRole" NOT NULL,
	"status" "ChatMessageStatus" NOT NULL,
	"content" text NOT NULL,
	"modelAlias" varchar(200),
	"inputTokens" integer,
	"outputTokens" integer,
	"totalTokens" integer,
	"latencyMs" integer,
	"finishReason" varchar(120),
	"providerRequestId" varchar(200),
	"errorCode" varchar(80),
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"completedAt" timestamp (6) with time zone,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"agentRunId" uuid,
	"reasoningTokens" integer,
	"firstTokenLatencyMs" integer
);
--> statement-breakpoint
CREATE TABLE "ComponentCompatibility" (
	"key" varchar(80) PRIMARY KEY NOT NULL,
	"displayName" varchar(160) NOT NULL,
	"category" varchar(80) NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"expectedContract" varchar(1000) NOT NULL,
	"status" "ComponentCompatibilityStatus" DEFAULT 'NOT_TESTED' NOT NULL,
	"observedVersion" varchar(240),
	"evidenceRef" varchar(500),
	"note" varchar(1000),
	"testedAt" timestamp (6) with time zone,
	"updatedBy" uuid,
	"revision" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (6) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ConfigurationRevision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"serviceConnectionId" uuid NOT NULL,
	"revision" integer NOT NULL,
	"configuration" jsonb NOT NULL,
	"secretFieldNames" text[],
	"checksum" varchar(64) NOT NULL,
	"createdBy" uuid,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"activatedAt" timestamp (6) with time zone
);
--> statement-breakpoint
CREATE TABLE "ConnectionMonitoringControl" (
	"id" varchar(32) PRIMARY KEY DEFAULT 'global' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"intervalSeconds" integer DEFAULT 300 NOT NULL,
	"reason" varchar(500),
	"updatedBy" uuid,
	"updatedAt" timestamp (6) with time zone NOT NULL,
	CONSTRAINT "ConnectionMonitoringControl_intervalSeconds_check" CHECK (("intervalSeconds" >= 30) AND ("intervalSeconds" <= 86400))
);
--> statement-breakpoint
CREATE TABLE "CredentialRecoveryControl" (
	"id" varchar(32) PRIMARY KEY DEFAULT 'global' NOT NULL,
	"keyFingerprint" varchar(64),
	"kitChecksum" varchar(64),
	"recoveryOwner" varchar(160),
	"exportedAt" timestamp (6) with time zone,
	"exportedBy" uuid,
	"verifiedAt" timestamp (6) with time zone,
	"verifiedBy" uuid,
	"revision" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (6) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ownerSubject" varchar(200) NOT NULL,
	"fileName" varchar(255) NOT NULL,
	"mediaType" varchar(160) NOT NULL,
	"sizeBytes" bigint NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"classification" "DocumentClassification" NOT NULL,
	"status" "DocumentStatus" DEFAULT 'QUEUED' NOT NULL,
	"failureCode" varchar(80),
	"failureMessage" varchar(500),
	"retentionUntil" timestamp (6) with time zone NOT NULL,
	"completedAt" timestamp (6) with time zone,
	"deletedAt" timestamp (6) with time zone,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (6) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "DocumentChunk" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"documentId" uuid NOT NULL,
	"ownerSubject" varchar(200) NOT NULL,
	"ordinal" integer NOT NULL,
	"content" text NOT NULL,
	"characterCount" integer NOT NULL,
	"embeddingModel" varchar(120) NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"contentSearch" text,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "DocumentMemoryPublication" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"documentId" uuid NOT NULL,
	"ownerSubject" varchar(200) NOT NULL,
	"scopeTag" varchar(100) NOT NULL,
	"status" "MemorySyncStatus" DEFAULT 'NOT_INDEXED' NOT NULL,
	"externalDocumentId" varchar(255),
	"failureCode" varchar(80),
	"failureMessage" varchar(500),
	"queuedAt" timestamp (6) with time zone,
	"syncedAt" timestamp (6) with time zone,
	"deletedAt" timestamp (6) with time zone,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (6) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "EnterpriseUser" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issuer" varchar(512) NOT NULL,
	"subject" varchar(255) NOT NULL,
	"email" varchar(320),
	"displayName" varchar(200) NOT NULL,
	"groups" text[],
	"enabled" boolean DEFAULT true NOT NULL,
	"lastLoginAt" timestamp (6) with time zone NOT NULL,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (6) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "EnterpriseUserSession" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tokenHash" "bytea" NOT NULL,
	"userId" uuid NOT NULL,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"lastSeenAt" timestamp (6) with time zone NOT NULL,
	"idleExpiresAt" timestamp (6) with time zone NOT NULL,
	"absoluteExpiresAt" timestamp (6) with time zone NOT NULL,
	"revokedAt" timestamp (6) with time zone,
	"sourceIp" "inet",
	"userAgentHash" varchar(64)
);
--> statement-breakpoint
CREATE TABLE "EvaluationRun" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(160) NOT NULL,
	"targetType" "EvaluationTargetType" NOT NULL,
	"targetReference" varchar(240) NOT NULL,
	"targetVersion" varchar(120) NOT NULL,
	"status" "EvaluationRunStatus" DEFAULT 'DRAFT' NOT NULL,
	"minimumPassRate" double precision NOT NULL,
	"requiredCategories" text[] NOT NULL,
	"categoryResults" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"totalCases" integer DEFAULT 0 NOT NULL,
	"passedCases" integer DEFAULT 0 NOT NULL,
	"criticalFailures" integer DEFAULT 0 NOT NULL,
	"createdBy" uuid,
	"completedAt" timestamp (6) with time zone,
	"promotedBy" uuid,
	"promotedAt" timestamp (6) with time zone,
	"promotionReason" varchar(1000),
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (6) with time zone NOT NULL,
	CONSTRAINT "EvaluationRun_threshold_check" CHECK (("minimumPassRate" >= (0.5)::double precision) AND ("minimumPassRate" <= (1)::double precision)),
	CONSTRAINT "EvaluationRun_categories_check" CHECK ((cardinality("requiredCategories") >= 1) AND (cardinality("requiredCategories") <= 6)),
	CONSTRAINT "EvaluationRun_results_shape_check" CHECK (jsonb_typeof("categoryResults") = 'array'::text),
	CONSTRAINT "EvaluationRun_counts_check" CHECK (("totalCases" >= 0) AND ("passedCases" >= 0) AND ("passedCases" <= "totalCases") AND ("criticalFailures" >= 0) AND ("criticalFailures" <= ("totalCases" - "passedCases"))),
	CONSTRAINT "EvaluationRun_evidence_check" CHECK (((status = 'DRAFT'::"EvaluationRunStatus") AND ("completedAt" IS NULL) AND ("promotedAt" IS NULL) AND ("promotionReason" IS NULL)) OR ((status = ANY (ARRAY['PASSED'::"EvaluationRunStatus", 'FAILED'::"EvaluationRunStatus"])) AND ("completedAt" IS NOT NULL) AND ("promotedAt" IS NULL) AND ("promotionReason" IS NULL) AND (jsonb_array_length("categoryResults") > 0)) OR ((status = 'PROMOTED'::"EvaluationRunStatus") AND ("completedAt" IS NOT NULL) AND ("promotedAt" IS NOT NULL) AND (length(btrim(("promotionReason")::text)) >= 3) AND (jsonb_array_length("categoryResults") > 0))),
	CONSTRAINT "EvaluationRun_quality_check" CHECK ((status = ANY (ARRAY['DRAFT'::"EvaluationRunStatus", 'FAILED'::"EvaluationRunStatus"])) OR (("totalCases" > 0) AND ("criticalFailures" = 0) AND ((("passedCases")::double precision / ("totalCases")::double precision) >= "minimumPassRate")))
);
--> statement-breakpoint
CREATE TABLE "GovernedTool" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(80) NOT NULL,
	"displayName" varchar(120) NOT NULL,
	"description" varchar(1000) NOT NULL,
	"risk" "ToolRisk" NOT NULL,
	"status" "ToolStatus" DEFAULT 'ACTIVE' NOT NULL,
	"handlerKey" varchar(120) NOT NULL,
	"inputSchema" jsonb NOT NULL,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (6) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "GovernedToolCall" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"runId" uuid NOT NULL,
	"toolId" uuid NOT NULL,
	"grantId" uuid NOT NULL,
	"requestId" uuid NOT NULL,
	"status" "ToolCallStatus" DEFAULT 'REQUESTED' NOT NULL,
	"arguments" jsonb NOT NULL,
	"result" jsonb,
	"errorCode" varchar(80),
	"errorMessage" varchar(500),
	"requestedAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"startedAt" timestamp (6) with time zone,
	"completedAt" timestamp (6) with time zone,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (6) with time zone NOT NULL,
	CONSTRAINT "GovernedToolCall_arguments_object_check" CHECK (jsonb_typeof(arguments) = 'object'::text)
);
--> statement-breakpoint
CREATE TABLE "GuardrailPolicy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(64) NOT NULL,
	"displayName" varchar(120) NOT NULL,
	"description" varchar(500) NOT NULL,
	"version" varchar(120) NOT NULL,
	"status" "GuardrailPolicyStatus" DEFAULT 'DRAFT' NOT NULL,
	"maxInputCharacters" integer NOT NULL,
	"activationEvaluationId" uuid,
	"firstActivatedAt" timestamp (6) with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"createdBy" uuid,
	"updatedBy" uuid,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (6) with time zone NOT NULL,
	"maxOutputCharacters" integer DEFAULT 200000 NOT NULL,
	"blockControlCharacters" boolean DEFAULT true NOT NULL,
	"blockCredentialPatterns" boolean DEFAULT true NOT NULL,
	CONSTRAINT "GuardrailPolicy_activation_evidence_check" CHECK ((status <> 'ACTIVE'::"GuardrailPolicyStatus") OR (("activationEvaluationId" IS NOT NULL) AND ("firstActivatedAt" IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "HermesNodeEnrollment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nodeId" uuid NOT NULL,
	"tokenHash" "bytea" NOT NULL,
	"status" "HermesNodeEnrollmentStatus" DEFAULT 'ISSUED' NOT NULL,
	"expiresAt" timestamp (6) with time zone NOT NULL,
	"consumedAt" timestamp (6) with time zone,
	"revokedAt" timestamp (6) with time zone,
	"consumedSourceIp" "inet",
	"createdBy" uuid,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (6) with time zone NOT NULL,
	"controlPlaneUrl" text,
	"hermesImage" text,
	"supermemoryVersion" varchar(120) DEFAULT '0.0.7-rc.2' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "HermesNodeRequestNonce" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nodeId" uuid NOT NULL,
	"nonce" uuid NOT NULL,
	"receivedAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "HermesRuntimeNode" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(64) NOT NULL,
	"displayName" varchar(120) NOT NULL,
	"baseUrl" text NOT NULL,
	"expectedHostname" varchar(253),
	"hostname" varchar(253),
	"status" "HermesRuntimeNodeStatus" DEFAULT 'PENDING' NOT NULL,
	"identityPublicKeyPem" text,
	"identityFingerprint" varchar(64),
	"hermesVersion" varchar(120),
	"installerVersion" varchar(120),
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"serviceConnectionId" uuid,
	"lastSeenAt" timestamp (6) with time zone,
	"enrolledAt" timestamp (6) with time zone,
	"revokedAt" timestamp (6) with time zone,
	"revision" integer DEFAULT 0 NOT NULL,
	"createdBy" uuid,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (6) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "InstallationCredential" (
	"id" varchar(32) PRIMARY KEY DEFAULT 'initial' NOT NULL,
	"keyHash" "bytea" NOT NULL,
	"activatedAt" timestamp (6) with time zone,
	"lastSessionId" uuid,
	"lastSourceIp" "inet",
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (6) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "LocalAdministrator" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" varchar(64) NOT NULL,
	"displayName" varchar(120) NOT NULL,
	"passwordHash" text NOT NULL,
	"role" "AdministratorRole" DEFAULT 'PLATFORM_ADMIN' NOT NULL,
	"passwordChangeRequired" boolean DEFAULT true NOT NULL,
	"failedLoginCount" integer DEFAULT 0 NOT NULL,
	"lockedUntil" timestamp (6) with time zone,
	"lastLoginAt" timestamp (6) with time zone,
	"passwordChangedAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"disabledAt" timestamp (6) with time zone,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (6) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "McpGatewayCredential" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120) NOT NULL,
	"tokenPrefix" varchar(32) NOT NULL,
	"tokenHash" "bytea" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"lastUsedAt" timestamp (6) with time zone,
	"revokedAt" timestamp (6) with time zone,
	"createdBy" uuid,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "McpGatewayCredential_tokenHash_check" CHECK (octet_length("tokenHash") = 32)
);
--> statement-breakpoint
CREATE TABLE "ModelDeployment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(64) NOT NULL,
	"displayName" varchar(120) NOT NULL,
	"modelAlias" varchar(200) NOT NULL,
	"workload" "ModelWorkload" NOT NULL,
	"status" "ModelDeploymentStatus" DEFAULT 'DRAFT' NOT NULL,
	"connectionId" uuid NOT NULL,
	"version" varchar(120) NOT NULL,
	"license" varchar(160),
	"contextWindowTokens" integer NOT NULL,
	"maxOutputTokens" integer NOT NULL,
	"maxConcurrentRequests" integer NOT NULL,
	"isDefault" boolean DEFAULT false NOT NULL,
	"activationEvaluationId" uuid,
	"firstActivatedAt" timestamp (6) with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"createdBy" uuid,
	"updatedBy" uuid,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (6) with time zone NOT NULL,
	CONSTRAINT "ModelDeployment_limits_check" CHECK ((("contextWindowTokens" >= 1024) AND ("contextWindowTokens" <= 4194304)) AND (("maxOutputTokens" >= 64) AND ("maxOutputTokens" <= 131072)) AND ("maxOutputTokens" <= "contextWindowTokens") AND (("maxConcurrentRequests" >= 1) AND ("maxConcurrentRequests" <= 1024)) AND (revision > 0)),
	CONSTRAINT "ModelDeployment_activation_evidence_check" CHECK ((status <> 'ACTIVE'::"ModelDeploymentStatus") OR (("activationEvaluationId" IS NOT NULL) AND ("firstActivatedAt" IS NOT NULL))),
	CONSTRAINT "ModelDeployment_default_status_check" CHECK (("isDefault" = false) OR (status = 'ACTIVE'::"ModelDeploymentStatus"))
);
--> statement-breakpoint
CREATE TABLE "OidcAuthorizationRequest" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"serviceConnectionId" uuid NOT NULL,
	"stateHash" "bytea" NOT NULL,
	"nonce" varchar(86) NOT NULL,
	"returnTo" varchar(500) NOT NULL,
	"issuer" varchar(512) NOT NULL,
	"tokenEndpoint" varchar(2048) NOT NULL,
	"jwksUri" varchar(2048) NOT NULL,
	"clientId" varchar(256) NOT NULL,
	"redirectUri" varchar(2048) NOT NULL,
	"codeVerifierEncryptedValue" "bytea" NOT NULL,
	"codeVerifierValueNonce" "bytea" NOT NULL,
	"codeVerifierValueAuthTag" "bytea" NOT NULL,
	"codeVerifierWrappedDataKey" "bytea" NOT NULL,
	"codeVerifierKeyNonce" "bytea" NOT NULL,
	"codeVerifierKeyAuthTag" "bytea" NOT NULL,
	"encryptionVersion" integer DEFAULT 1 NOT NULL,
	"masterKeyVersion" integer DEFAULT 1 NOT NULL,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"expiresAt" timestamp (6) with time zone NOT NULL,
	"consumedAt" timestamp (6) with time zone
);
--> statement-breakpoint
CREATE TABLE "OnboardingEvidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stageKey" varchar(80) NOT NULL,
	"componentKey" varchar(80),
	"source" "OnboardingEvidenceSource" NOT NULL,
	"outcome" "OnboardingEvidenceOutcome" NOT NULL,
	"code" varchar(120) NOT NULL,
	"summary" varchar(1000) NOT NULL,
	"observedVersion" varchar(240),
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"createdBy" uuid,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"expiresAt" timestamp (6) with time zone
);
--> statement-breakpoint
CREATE TABLE "OnboardingJourney" (
	"id" varchar(32) PRIMARY KEY DEFAULT 'global' NOT NULL,
	"status" "OnboardingJourneyStatus" DEFAULT 'NOT_STARTED' NOT NULL,
	"currentStepKey" varchar(80),
	"reason" varchar(1000),
	"revision" integer DEFAULT 0 NOT NULL,
	"startedAt" timestamp (6) with time zone,
	"completedAt" timestamp (6) with time zone,
	"updatedBy" uuid,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (6) with time zone NOT NULL,
	"activatedEnvironment" "OnboardingTargetEnvironment"
);
--> statement-breakpoint
CREATE TABLE "OnboardingStep" (
	"key" varchar(80) PRIMARY KEY NOT NULL,
	"ordinal" integer NOT NULL,
	"title" varchar(160) NOT NULL,
	"description" varchar(1000) NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"status" "OnboardingStepStatus" DEFAULT 'NOT_STARTED' NOT NULL,
	"evidenceRefs" text[] DEFAULT '{}',
	"note" varchar(1000),
	"revision" integer DEFAULT 0 NOT NULL,
	"updatedBy" uuid,
	"completedAt" timestamp (6) with time zone,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (6) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "OperationalIncident" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"activeFingerprint" varchar(160),
	"title" varchar(160) NOT NULL,
	"severity" "OperationalIncidentSeverity" NOT NULL,
	"status" "OperationalIncidentStatus" DEFAULT 'OPEN' NOT NULL,
	"component" varchar(80) NOT NULL,
	"summary" varchar(1000) NOT NULL,
	"owner" varchar(160),
	"automated" boolean DEFAULT false NOT NULL,
	"detectedAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"lastObservedAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"acknowledgedBy" uuid,
	"acknowledgedAt" timestamp (6) with time zone,
	"resolvedBy" uuid,
	"resolvedAt" timestamp (6) with time zone,
	"resolutionNote" varchar(1000),
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (6) with time zone NOT NULL,
	CONSTRAINT "OperationalIncident_lifecycle_check" CHECK (((status = 'OPEN'::"OperationalIncidentStatus") AND ("acknowledgedAt" IS NULL) AND ("resolvedAt" IS NULL)) OR ((status = 'ACKNOWLEDGED'::"OperationalIncidentStatus") AND ("acknowledgedAt" IS NOT NULL) AND ("resolvedAt" IS NULL)) OR ((status = 'RESOLVED'::"OperationalIncidentStatus") AND ("resolvedAt" IS NOT NULL) AND ("activeFingerprint" IS NULL)))
);
--> statement-breakpoint
CREATE TABLE "PlatformArchitectureDecision" (
	"id" varchar(32) PRIMARY KEY DEFAULT 'global' NOT NULL,
	"reason" varchar(1000),
	"revision" integer DEFAULT 0 NOT NULL,
	"updatedBy" uuid,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (6) with time zone NOT NULL,
	"topologyMode" "DeploymentTopologyMode" DEFAULT 'CONTROL_PLANE' NOT NULL,
	"targetEnvironment" "OnboardingTargetEnvironment" DEFAULT 'DEVELOPMENT' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ProductionReadinessApproval" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role" "ProductionReadinessApprovalRole" NOT NULL,
	"decision" "ProductionReadinessApprovalDecision" NOT NULL,
	"authority" varchar(160) NOT NULL,
	"evidenceRef" varchar(500) NOT NULL,
	"reason" varchar(1000) NOT NULL,
	"recordedBy" varchar(160) NOT NULL,
	"recordedAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"controlRevisions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "ProductionReadinessApproval_content_check" CHECK ((length(btrim((authority)::text)) > 0) AND (length(btrim(("evidenceRef")::text)) > 0) AND (length(btrim((reason)::text)) >= 3) AND (length(btrim(("recordedBy")::text)) > 0)),
	CONSTRAINT "ProductionReadinessApproval_snapshot_check" CHECK (jsonb_typeof("controlRevisions") = 'object'::text)
);
--> statement-breakpoint
CREATE TABLE "ProductionReadinessControl" (
	"key" varchar(80) PRIMARY KEY NOT NULL,
	"title" varchar(160) NOT NULL,
	"domain" "ProductionReadinessDomain" NOT NULL,
	"description" varchar(1000) NOT NULL,
	"status" "ProductionReadinessControlStatus" DEFAULT 'NOT_STARTED' NOT NULL,
	"owner" varchar(160),
	"evidenceRefs" text[] DEFAULT '{}' NOT NULL,
	"note" varchar(1000),
	"lastUpdatedBy" varchar(160),
	"verifiedAt" timestamp (6) with time zone,
	"revision" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (6) with time zone NOT NULL,
	CONSTRAINT "ProductionReadinessControl_key_check" CHECK ((key)::text ~ '^[a-z][a-z0-9-]{2,79}$'::text),
	CONSTRAINT "ProductionReadinessControl_owner_check" CHECK ((status = 'NOT_STARTED'::"ProductionReadinessControlStatus") OR ((owner IS NOT NULL) AND (length(btrim((owner)::text)) > 0))),
	CONSTRAINT "ProductionReadinessControl_note_check" CHECK ((status <> ALL (ARRAY['BLOCKED'::"ProductionReadinessControlStatus", 'VERIFIED'::"ProductionReadinessControlStatus", 'WAIVED'::"ProductionReadinessControlStatus"])) OR ((note IS NOT NULL) AND (length(btrim((note)::text)) >= 3))),
	CONSTRAINT "ProductionReadinessControl_evidence_check" CHECK ((status <> ALL (ARRAY['VERIFIED'::"ProductionReadinessControlStatus", 'WAIVED'::"ProductionReadinessControlStatus"])) OR (cardinality("evidenceRefs") > 0)),
	CONSTRAINT "ProductionReadinessControl_verification_check" CHECK (((status = ANY (ARRAY['VERIFIED'::"ProductionReadinessControlStatus", 'WAIVED'::"ProductionReadinessControlStatus"])) AND ("verifiedAt" IS NOT NULL)) OR ((status <> ALL (ARRAY['VERIFIED'::"ProductionReadinessControlStatus", 'WAIVED'::"ProductionReadinessControlStatus"])) AND ("verifiedAt" IS NULL)))
);
--> statement-breakpoint
CREATE TABLE "PromptTemplate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(64) NOT NULL,
	"displayName" varchar(120) NOT NULL,
	"description" varchar(500) NOT NULL,
	"purpose" "PromptPurpose" NOT NULL,
	"version" varchar(120) NOT NULL,
	"status" "PromptTemplateStatus" DEFAULT 'DRAFT' NOT NULL,
	"content" text NOT NULL,
	"contentChecksum" varchar(64) NOT NULL,
	"activationEvaluationId" uuid,
	"firstActivatedAt" timestamp (6) with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"createdBy" uuid,
	"updatedBy" uuid,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (6) with time zone NOT NULL,
	CONSTRAINT "PromptTemplate_content_check" CHECK (((char_length(btrim(content)) >= 20) AND (char_length(btrim(content)) <= 20000)) AND (("contentChecksum")::text ~ '^[a-f0-9]{64}$'::text) AND (revision > 0)),
	CONSTRAINT "PromptTemplate_activation_evidence_check" CHECK ((status <> 'ACTIVE'::"PromptTemplateStatus") OR (("activationEvaluationId" IS NOT NULL) AND ("firstActivatedAt" IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "SecretRecord" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"serviceConnectionId" uuid NOT NULL,
	"fieldName" varchar(120) NOT NULL,
	"encryptedValue" "bytea" NOT NULL,
	"valueNonce" "bytea" NOT NULL,
	"valueAuthTag" "bytea" NOT NULL,
	"wrappedDataKey" "bytea" NOT NULL,
	"keyNonce" "bytea" NOT NULL,
	"keyAuthTag" "bytea" NOT NULL,
	"encryptionVersion" integer DEFAULT 1 NOT NULL,
	"masterKeyVersion" integer DEFAULT 1 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"createdBy" uuid,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"retiredAt" timestamp (6) with time zone
);
--> statement-breakpoint
CREATE TABLE "ServiceConnection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(64) NOT NULL,
	"displayName" varchar(120) NOT NULL,
	"kind" "ServiceKind" NOT NULL,
	"environment" "DeploymentEnvironment" NOT NULL,
	"baseUrl" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"status" "ConnectionStatus" DEFAULT 'NOT_TESTED' NOT NULL,
	"configuration" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"activeRevision" integer DEFAULT 1 NOT NULL,
	"lastHealthcheckAt" timestamp (6) with time zone,
	"lastHealthcheckMessage" text,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (6) with time zone NOT NULL,
	"monitoringClaimedAt" timestamp (6) with time zone,
	"monitoringClaimedBy" varchar(200),
	"monitoringClaimToken" uuid,
	CONSTRAINT "ServiceConnection_monitoringClaim_check" CHECK ((("monitoringClaimedAt" IS NULL) AND ("monitoringClaimedBy" IS NULL) AND ("monitoringClaimToken" IS NULL)) OR (("monitoringClaimedAt" IS NOT NULL) AND ("monitoringClaimedBy" IS NOT NULL) AND ("monitoringClaimToken" IS NOT NULL)))
);
--> statement-breakpoint
CREATE TABLE "ToolActionDispatch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"callId" uuid NOT NULL,
	"status" "ToolActionDispatchStatus" DEFAULT 'PENDING' NOT NULL,
	"attemptCount" integer DEFAULT 0 NOT NULL,
	"nextAttemptAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"claimedAt" timestamp (6) with time zone,
	"claimedBy" varchar(200),
	"claimToken" uuid,
	"submittedJobId" uuid,
	"lastError" varchar(500),
	"completedAt" timestamp (6) with time zone,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (6) with time zone NOT NULL,
	CONSTRAINT "ToolActionDispatch_attemptCount_check" CHECK ("attemptCount" >= 0),
	CONSTRAINT "ToolActionDispatch_claim_check" CHECK (((status = 'PROCESSING'::"ToolActionDispatchStatus") AND ("claimedAt" IS NOT NULL) AND ("claimedBy" IS NOT NULL) AND ("claimToken" IS NOT NULL)) OR ((status <> 'PROCESSING'::"ToolActionDispatchStatus") AND ("claimedAt" IS NULL) AND ("claimedBy" IS NULL) AND ("claimToken" IS NULL))),
	CONSTRAINT "ToolActionDispatch_completion_check" CHECK (((status = ANY (ARRAY['COMPLETED'::"ToolActionDispatchStatus", 'FAILED'::"ToolActionDispatchStatus", 'CANCELLED'::"ToolActionDispatchStatus"])) AND ("completedAt" IS NOT NULL)) OR ((status = ANY (ARRAY['PENDING'::"ToolActionDispatchStatus", 'PROCESSING'::"ToolActionDispatchStatus"])) AND ("completedAt" IS NULL)))
);
--> statement-breakpoint
CREATE TABLE "ToolApproval" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"callId" uuid NOT NULL,
	"status" "ToolApprovalStatus" DEFAULT 'PENDING' NOT NULL,
	"expiresAt" timestamp (6) with time zone NOT NULL,
	"decisionReason" varchar(1000),
	"decisionBy" uuid,
	"decidedAt" timestamp (6) with time zone,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (6) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ToolRuntimeControl" (
	"id" varchar(32) PRIMARY KEY DEFAULT 'global' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"reason" varchar(500),
	"approvalTtlMinutes" integer DEFAULT 15 NOT NULL,
	"updatedBy" uuid,
	"updatedAt" timestamp (6) with time zone NOT NULL,
	CONSTRAINT "ToolRuntimeControl_approvalTtlMinutes_check" CHECK (("approvalTtlMinutes" >= 5) AND ("approvalTtlMinutes" <= 1440))
);
--> statement-breakpoint
CREATE TABLE "WorkerNode" (
	"id" varchar(160) PRIMARY KEY NOT NULL,
	"name" varchar(160) NOT NULL,
	"version" varchar(40) NOT NULL,
	"status" "WorkerLifecycleStatus" DEFAULT 'ONLINE' NOT NULL,
	"workloads" text[],
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"startedAt" timestamp (6) with time zone NOT NULL,
	"lastSeenAt" timestamp (6) with time zone NOT NULL,
	"stoppedAt" timestamp (6) with time zone,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (6) with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "AgentProfileVersion" ADD CONSTRAINT "AgentProfileVersion_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "public"."AgentProfile"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "public"."AgentProfile"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_profileVersionId_fkey" FOREIGN KEY ("profileVersionId") REFERENCES "public"."AgentProfileVersion"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "AgentRunApproval" ADD CONSTRAINT "AgentRunApproval_runId_fkey" FOREIGN KEY ("runId") REFERENCES "public"."AgentRun"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "AgentRunEvent" ADD CONSTRAINT "AgentRunEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "public"."AgentRun"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "AgentToolGrant" ADD CONSTRAINT "AgentToolGrant_profileVersionId_fkey" FOREIGN KEY ("profileVersionId") REFERENCES "public"."AgentProfileVersion"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "AgentToolGrant" ADD CONSTRAINT "AgentToolGrant_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "public"."GovernedTool"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ChatFeedback" ADD CONSTRAINT "ChatFeedback_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "public"."ChatMessage"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "public"."ChatConversation"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "public"."AgentRun"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ConfigurationRevision" ADD CONSTRAINT "ConfigurationRevision_serviceConnectionId_fkey" FOREIGN KEY ("serviceConnectionId") REFERENCES "public"."ServiceConnection"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "DocumentChunk" ADD CONSTRAINT "DocumentChunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "public"."Document"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "DocumentMemoryPublication" ADD CONSTRAINT "DocumentMemoryPublication_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "public"."Document"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "EnterpriseUserSession" ADD CONSTRAINT "EnterpriseUserSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."EnterpriseUser"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "GovernedToolCall" ADD CONSTRAINT "GovernedToolCall_runId_fkey" FOREIGN KEY ("runId") REFERENCES "public"."AgentRun"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "GovernedToolCall" ADD CONSTRAINT "GovernedToolCall_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "public"."GovernedTool"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "GovernedToolCall" ADD CONSTRAINT "GovernedToolCall_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "public"."AgentToolGrant"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "GuardrailPolicy" ADD CONSTRAINT "GuardrailPolicy_activationEvaluationId_fkey" FOREIGN KEY ("activationEvaluationId") REFERENCES "public"."EvaluationRun"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "HermesNodeEnrollment" ADD CONSTRAINT "HermesNodeEnrollment_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "public"."HermesRuntimeNode"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "HermesNodeRequestNonce" ADD CONSTRAINT "HermesNodeRequestNonce_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "public"."HermesRuntimeNode"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "HermesRuntimeNode" ADD CONSTRAINT "HermesRuntimeNode_serviceConnectionId_fkey" FOREIGN KEY ("serviceConnectionId") REFERENCES "public"."ServiceConnection"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ModelDeployment" ADD CONSTRAINT "ModelDeployment_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "public"."ServiceConnection"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ModelDeployment" ADD CONSTRAINT "ModelDeployment_activationEvaluationId_fkey" FOREIGN KEY ("activationEvaluationId") REFERENCES "public"."EvaluationRun"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "OidcAuthorizationRequest" ADD CONSTRAINT "OidcAuthorizationRequest_serviceConnectionId_fkey" FOREIGN KEY ("serviceConnectionId") REFERENCES "public"."ServiceConnection"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "PromptTemplate" ADD CONSTRAINT "PromptTemplate_activationEvaluationId_fkey" FOREIGN KEY ("activationEvaluationId") REFERENCES "public"."EvaluationRun"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "SecretRecord" ADD CONSTRAINT "SecretRecord_serviceConnectionId_fkey" FOREIGN KEY ("serviceConnectionId") REFERENCES "public"."ServiceConnection"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ToolActionDispatch" ADD CONSTRAINT "ToolActionDispatch_callId_fkey" FOREIGN KEY ("callId") REFERENCES "public"."GovernedToolCall"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ToolApproval" ADD CONSTRAINT "ToolApproval_callId_fkey" FOREIGN KEY ("callId") REFERENCES "public"."GovernedToolCall"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "AdministratorSession_absoluteExpiresAt_idx" ON "AdministratorSession" USING btree ("absoluteExpiresAt");--> statement-breakpoint
CREATE INDEX "AdministratorSession_revokedAt_idleExpiresAt_idx" ON "AdministratorSession" USING btree ("revokedAt","idleExpiresAt");--> statement-breakpoint
CREATE INDEX "AdministratorSession_subject_createdAt_idx" ON "AdministratorSession" USING btree ("subject","createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "AdministratorSession_tokenHash_key" ON "AdministratorSession" USING btree ("tokenHash");--> statement-breakpoint
CREATE UNIQUE INDEX "AgentProfile_slug_key" ON "AgentProfile" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "AgentProfile_status_updatedAt_idx" ON "AgentProfile" USING btree ("status","updatedAt");--> statement-breakpoint
CREATE INDEX "AgentProfileVersion_profileId_createdAt_idx" ON "AgentProfileVersion" USING btree ("profileId","createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "AgentProfileVersion_profileId_version_key" ON "AgentProfileVersion" USING btree ("profileId","version");--> statement-breakpoint
CREATE INDEX "AgentRun_ownerSubject_createdAt_idx" ON "AgentRun" USING btree ("ownerSubject","createdAt");--> statement-breakpoint
CREATE INDEX "AgentRun_profileId_status_createdAt_idx" ON "AgentRun" USING btree ("profileId","status","createdAt");--> statement-breakpoint
CREATE INDEX "AgentRun_status_processorLeaseExpiresAt_idx" ON "AgentRun" USING btree ("status","processorLeaseExpiresAt");--> statement-breakpoint
CREATE INDEX "AgentRun_status_queuedAt_idx" ON "AgentRun" USING btree ("status","queuedAt");--> statement-breakpoint
CREATE INDEX "AgentRunApproval_runId_status_requestedAt_idx" ON "AgentRunApproval" USING btree ("runId","status","requestedAt");--> statement-breakpoint
CREATE INDEX "AgentRunApproval_status_expiresAt_idx" ON "AgentRunApproval" USING btree ("status","expiresAt");--> statement-breakpoint
CREATE UNIQUE INDEX "AgentRunEvent_cursor_key" ON "AgentRunEvent" USING btree ("cursor");--> statement-breakpoint
CREATE INDEX "AgentRunEvent_runId_cursor_idx" ON "AgentRunEvent" USING btree ("runId","cursor");--> statement-breakpoint
CREATE INDEX "AgentRunEvent_runId_occurredAt_id_idx" ON "AgentRunEvent" USING btree ("runId","occurredAt","id");--> statement-breakpoint
CREATE UNIQUE INDEX "AgentRunEvent_runId_sourceEventId_key" ON "AgentRunEvent" USING btree ("runId","sourceEventId");--> statement-breakpoint
CREATE UNIQUE INDEX "AgentToolGrant_profileVersionId_toolId_key" ON "AgentToolGrant" USING btree ("profileVersionId","toolId");--> statement-breakpoint
CREATE INDEX "AgentToolGrant_toolId_enabled_idx" ON "AgentToolGrant" USING btree ("toolId","enabled");--> statement-breakpoint
CREATE INDEX "AuditEvent_actorId_occurredAt_idx" ON "AuditEvent" USING btree ("actorId","occurredAt");--> statement-breakpoint
CREATE INDEX "AuditEvent_correlationId_idx" ON "AuditEvent" USING btree ("correlationId");--> statement-breakpoint
CREATE INDEX "AuditEvent_occurredAt_idx" ON "AuditEvent" USING btree ("occurredAt");--> statement-breakpoint
CREATE INDEX "AuditEvent_resourceType_resourceId_idx" ON "AuditEvent" USING btree ("resourceType","resourceId");--> statement-breakpoint
CREATE INDEX "ChatConversation_lastMessageAt_idx" ON "ChatConversation" USING btree ("lastMessageAt");--> statement-breakpoint
CREATE INDEX "ChatConversation_ownerSubject_status_updatedAt_idx" ON "ChatConversation" USING btree ("ownerSubject","status","updatedAt");--> statement-breakpoint
CREATE UNIQUE INDEX "ChatFeedback_messageId_key" ON "ChatFeedback" USING btree ("messageId");--> statement-breakpoint
CREATE INDEX "ChatFeedback_ownerSubject_createdAt_idx" ON "ChatFeedback" USING btree ("ownerSubject","createdAt");--> statement-breakpoint
CREATE INDEX "ChatFeedback_rating_createdAt_idx" ON "ChatFeedback" USING btree ("rating","createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "ChatMessage_agentRunId_key" ON "ChatMessage" USING btree ("agentRunId");--> statement-breakpoint
CREATE INDEX "ChatMessage_conversationId_createdAt_idx" ON "ChatMessage" USING btree ("conversationId","createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "ChatMessage_conversationId_ordinal_key" ON "ChatMessage" USING btree ("conversationId","ordinal");--> statement-breakpoint
CREATE INDEX "ChatMessage_status_createdAt_idx" ON "ChatMessage" USING btree ("status","createdAt");--> statement-breakpoint
CREATE INDEX "ComponentCompatibility_category_status_idx" ON "ComponentCompatibility" USING btree ("category","status");--> statement-breakpoint
CREATE INDEX "ComponentCompatibility_required_status_idx" ON "ComponentCompatibility" USING btree ("required","status");--> statement-breakpoint
CREATE INDEX "ConfigurationRevision_createdAt_idx" ON "ConfigurationRevision" USING btree ("createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "ConfigurationRevision_serviceConnectionId_revision_key" ON "ConfigurationRevision" USING btree ("serviceConnectionId","revision");--> statement-breakpoint
CREATE INDEX "Document_ownerSubject_status_updatedAt_idx" ON "Document" USING btree ("ownerSubject","status","updatedAt");--> statement-breakpoint
CREATE INDEX "Document_retentionUntil_status_idx" ON "Document" USING btree ("retentionUntil","status");--> statement-breakpoint
CREATE INDEX "Document_sha256_idx" ON "Document" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "Document_status_createdAt_idx" ON "Document" USING btree ("status","createdAt");--> statement-breakpoint
CREATE INDEX "DocumentChunk_content_fts_idx" ON "DocumentChunk" USING gin (to_tsvector('simple'::regconfig, content));--> statement-breakpoint
CREATE UNIQUE INDEX "DocumentChunk_documentId_ordinal_key" ON "DocumentChunk" USING btree ("documentId","ordinal");--> statement-breakpoint
CREATE INDEX "DocumentChunk_embedding_idx" ON "DocumentChunk" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "DocumentChunk_ownerSubject_idx" ON "DocumentChunk" USING btree ("ownerSubject");--> statement-breakpoint
CREATE UNIQUE INDEX "DocumentMemoryPublication_documentId_key" ON "DocumentMemoryPublication" USING btree ("documentId");--> statement-breakpoint
CREATE INDEX "DocumentMemoryPublication_ownerSubject_status_updatedAt_idx" ON "DocumentMemoryPublication" USING btree ("ownerSubject","status","updatedAt");--> statement-breakpoint
CREATE INDEX "DocumentMemoryPublication_scopeTag_status_idx" ON "DocumentMemoryPublication" USING btree ("scopeTag","status");--> statement-breakpoint
CREATE INDEX "DocumentMemoryPublication_status_queuedAt_idx" ON "DocumentMemoryPublication" USING btree ("status","queuedAt");--> statement-breakpoint
CREATE INDEX "EnterpriseUser_email_idx" ON "EnterpriseUser" USING btree ("email");--> statement-breakpoint
CREATE INDEX "EnterpriseUser_enabled_lastLoginAt_idx" ON "EnterpriseUser" USING btree ("enabled","lastLoginAt");--> statement-breakpoint
CREATE UNIQUE INDEX "EnterpriseUser_issuer_subject_key" ON "EnterpriseUser" USING btree ("issuer","subject");--> statement-breakpoint
CREATE INDEX "EnterpriseUserSession_absoluteExpiresAt_idx" ON "EnterpriseUserSession" USING btree ("absoluteExpiresAt");--> statement-breakpoint
CREATE INDEX "EnterpriseUserSession_revokedAt_idleExpiresAt_idx" ON "EnterpriseUserSession" USING btree ("revokedAt","idleExpiresAt");--> statement-breakpoint
CREATE UNIQUE INDEX "EnterpriseUserSession_tokenHash_key" ON "EnterpriseUserSession" USING btree ("tokenHash");--> statement-breakpoint
CREATE INDEX "EnterpriseUserSession_userId_createdAt_idx" ON "EnterpriseUserSession" USING btree ("userId","createdAt");--> statement-breakpoint
CREATE INDEX "EvaluationRun_status_createdAt_idx" ON "EvaluationRun" USING btree ("status","createdAt");--> statement-breakpoint
CREATE INDEX "EvaluationRun_targetType_targetReference_targetVersion_idx" ON "EvaluationRun" USING btree ("targetType","targetReference","targetVersion");--> statement-breakpoint
CREATE UNIQUE INDEX "GovernedTool_slug_key" ON "GovernedTool" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "GovernedTool_status_risk_idx" ON "GovernedTool" USING btree ("status","risk");--> statement-breakpoint
CREATE INDEX "GovernedToolCall_runId_createdAt_idx" ON "GovernedToolCall" USING btree ("runId","createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "GovernedToolCall_runId_requestId_key" ON "GovernedToolCall" USING btree ("runId","requestId");--> statement-breakpoint
CREATE INDEX "GovernedToolCall_status_requestedAt_idx" ON "GovernedToolCall" USING btree ("status","requestedAt");--> statement-breakpoint
CREATE INDEX "GovernedToolCall_toolId_status_createdAt_idx" ON "GovernedToolCall" USING btree ("toolId","status","createdAt");--> statement-breakpoint
CREATE INDEX "GuardrailPolicy_activationEvaluationId_idx" ON "GuardrailPolicy" USING btree ("activationEvaluationId");--> statement-breakpoint
CREATE UNIQUE INDEX "GuardrailPolicy_single_active_key" ON "GuardrailPolicy" USING btree ((true)) WHERE (status = 'ACTIVE'::"GuardrailPolicyStatus");--> statement-breakpoint
CREATE UNIQUE INDEX "GuardrailPolicy_slug_key" ON "GuardrailPolicy" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "GuardrailPolicy_status_updatedAt_idx" ON "GuardrailPolicy" USING btree ("status","updatedAt");--> statement-breakpoint
CREATE INDEX "HermesNodeEnrollment_nodeId_status_idx" ON "HermesNodeEnrollment" USING btree ("nodeId","status");--> statement-breakpoint
CREATE INDEX "HermesNodeEnrollment_status_expiresAt_idx" ON "HermesNodeEnrollment" USING btree ("status","expiresAt");--> statement-breakpoint
CREATE UNIQUE INDEX "HermesNodeEnrollment_tokenHash_key" ON "HermesNodeEnrollment" USING btree ("tokenHash");--> statement-breakpoint
CREATE UNIQUE INDEX "HermesNodeRequestNonce_nodeId_nonce_key" ON "HermesNodeRequestNonce" USING btree ("nodeId","nonce");--> statement-breakpoint
CREATE INDEX "HermesNodeRequestNonce_receivedAt_idx" ON "HermesNodeRequestNonce" USING btree ("receivedAt");--> statement-breakpoint
CREATE INDEX "HermesRuntimeNode_createdAt_idx" ON "HermesRuntimeNode" USING btree ("createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "HermesRuntimeNode_identityFingerprint_key" ON "HermesRuntimeNode" USING btree ("identityFingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "HermesRuntimeNode_serviceConnectionId_key" ON "HermesRuntimeNode" USING btree ("serviceConnectionId");--> statement-breakpoint
CREATE UNIQUE INDEX "HermesRuntimeNode_slug_key" ON "HermesRuntimeNode" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "HermesRuntimeNode_status_lastSeenAt_idx" ON "HermesRuntimeNode" USING btree ("status","lastSeenAt");--> statement-breakpoint
CREATE INDEX "InstallationCredential_activatedAt_idx" ON "InstallationCredential" USING btree ("activatedAt");--> statement-breakpoint
CREATE UNIQUE INDEX "InstallationCredential_keyHash_key" ON "InstallationCredential" USING btree ("keyHash");--> statement-breakpoint
CREATE INDEX "LocalAdministrator_disabledAt_lockedUntil_idx" ON "LocalAdministrator" USING btree ("disabledAt","lockedUntil");--> statement-breakpoint
CREATE UNIQUE INDEX "LocalAdministrator_username_key" ON "LocalAdministrator" USING btree ("username");--> statement-breakpoint
CREATE INDEX "McpGatewayCredential_enabled_revokedAt_idx" ON "McpGatewayCredential" USING btree ("enabled","revokedAt");--> statement-breakpoint
CREATE UNIQUE INDEX "McpGatewayCredential_tokenHash_key" ON "McpGatewayCredential" USING btree ("tokenHash");--> statement-breakpoint
CREATE UNIQUE INDEX "McpGatewayCredential_tokenPrefix_key" ON "McpGatewayCredential" USING btree ("tokenPrefix");--> statement-breakpoint
CREATE INDEX "ModelDeployment_activationEvaluationId_idx" ON "ModelDeployment" USING btree ("activationEvaluationId");--> statement-breakpoint
CREATE UNIQUE INDEX "ModelDeployment_active_default_workload_key" ON "ModelDeployment" USING btree ("workload") WHERE ((status = 'ACTIVE'::"ModelDeploymentStatus") AND ("isDefault" = true));--> statement-breakpoint
CREATE INDEX "ModelDeployment_connectionId_idx" ON "ModelDeployment" USING btree ("connectionId");--> statement-breakpoint
CREATE UNIQUE INDEX "ModelDeployment_slug_key" ON "ModelDeployment" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "ModelDeployment_workload_modelAlias_key" ON "ModelDeployment" USING btree ("workload","modelAlias");--> statement-breakpoint
CREATE INDEX "ModelDeployment_workload_status_idx" ON "ModelDeployment" USING btree ("workload","status");--> statement-breakpoint
CREATE INDEX "OidcAuthorizationRequest_expiresAt_consumedAt_idx" ON "OidcAuthorizationRequest" USING btree ("expiresAt","consumedAt");--> statement-breakpoint
CREATE INDEX "OidcAuthorizationRequest_serviceConnectionId_createdAt_idx" ON "OidcAuthorizationRequest" USING btree ("serviceConnectionId","createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "OidcAuthorizationRequest_stateHash_key" ON "OidcAuthorizationRequest" USING btree ("stateHash");--> statement-breakpoint
CREATE INDEX "OnboardingEvidence_componentKey_createdAt_idx" ON "OnboardingEvidence" USING btree ("componentKey","createdAt");--> statement-breakpoint
CREATE INDEX "OnboardingEvidence_source_outcome_createdAt_idx" ON "OnboardingEvidence" USING btree ("source","outcome","createdAt");--> statement-breakpoint
CREATE INDEX "OnboardingEvidence_stageKey_createdAt_idx" ON "OnboardingEvidence" USING btree ("stageKey","createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "OnboardingStep_ordinal_key" ON "OnboardingStep" USING btree ("ordinal");--> statement-breakpoint
CREATE INDEX "OnboardingStep_status_ordinal_idx" ON "OnboardingStep" USING btree ("status","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "OperationalIncident_activeFingerprint_key" ON "OperationalIncident" USING btree ("activeFingerprint");--> statement-breakpoint
CREATE INDEX "OperationalIncident_component_status_idx" ON "OperationalIncident" USING btree ("component","status");--> statement-breakpoint
CREATE INDEX "OperationalIncident_owner_status_idx" ON "OperationalIncident" USING btree ("owner","status");--> statement-breakpoint
CREATE INDEX "OperationalIncident_status_severity_detectedAt_idx" ON "OperationalIncident" USING btree ("status","severity","detectedAt");--> statement-breakpoint
CREATE INDEX "ProductionReadinessApproval_decision_recordedAt_idx" ON "ProductionReadinessApproval" USING btree ("decision","recordedAt");--> statement-breakpoint
CREATE INDEX "ProductionReadinessApproval_role_recordedAt_idx" ON "ProductionReadinessApproval" USING btree ("role","recordedAt");--> statement-breakpoint
CREATE INDEX "ProductionReadinessControl_domain_status_idx" ON "ProductionReadinessControl" USING btree ("domain","status");--> statement-breakpoint
CREATE INDEX "ProductionReadinessControl_status_updatedAt_idx" ON "ProductionReadinessControl" USING btree ("status","updatedAt");--> statement-breakpoint
CREATE INDEX "PromptTemplate_activationEvaluationId_idx" ON "PromptTemplate" USING btree ("activationEvaluationId");--> statement-breakpoint
CREATE INDEX "PromptTemplate_purpose_status_idx" ON "PromptTemplate" USING btree ("purpose","status");--> statement-breakpoint
CREATE UNIQUE INDEX "PromptTemplate_single_active_purpose_key" ON "PromptTemplate" USING btree ("purpose") WHERE (status = 'ACTIVE'::"PromptTemplateStatus");--> statement-breakpoint
CREATE UNIQUE INDEX "PromptTemplate_slug_key" ON "PromptTemplate" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "SecretRecord_createdAt_idx" ON "SecretRecord" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "SecretRecord_serviceConnectionId_fieldName_active_idx" ON "SecretRecord" USING btree ("serviceConnectionId","fieldName","active");--> statement-breakpoint
CREATE INDEX "ServiceConnection_enabled_status_idx" ON "ServiceConnection" USING btree ("enabled","status");--> statement-breakpoint
CREATE INDEX "ServiceConnection_kind_environment_idx" ON "ServiceConnection" USING btree ("kind","environment");--> statement-breakpoint
CREATE INDEX "ServiceConnection_monitoringClaimedAt_idx" ON "ServiceConnection" USING btree ("monitoringClaimedAt");--> statement-breakpoint
CREATE UNIQUE INDEX "ServiceConnection_slug_key" ON "ServiceConnection" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "ToolActionDispatch_callId_key" ON "ToolActionDispatch" USING btree ("callId");--> statement-breakpoint
CREATE INDEX "ToolActionDispatch_claimedAt_idx" ON "ToolActionDispatch" USING btree ("claimedAt");--> statement-breakpoint
CREATE INDEX "ToolActionDispatch_status_nextAttemptAt_idx" ON "ToolActionDispatch" USING btree ("status","nextAttemptAt");--> statement-breakpoint
CREATE UNIQUE INDEX "ToolApproval_callId_key" ON "ToolApproval" USING btree ("callId");--> statement-breakpoint
CREATE INDEX "ToolApproval_status_expiresAt_idx" ON "ToolApproval" USING btree ("status","expiresAt");--> statement-breakpoint
CREATE INDEX "WorkerNode_lastSeenAt_idx" ON "WorkerNode" USING btree ("lastSeenAt");--> statement-breakpoint
CREATE INDEX "WorkerNode_status_lastSeenAt_idx" ON "WorkerNode" USING btree ("status","lastSeenAt");