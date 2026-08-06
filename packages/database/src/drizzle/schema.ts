/*
 * This file is the schema's source of truth. Edit it, then run `pnpm db:generate`
 * to emit the migration under drizzle/migrations; the runtime migrator applies
 * that SQL. Never introspect the database back over this file - it carries
 * decisions the database cannot express, and a regeneration would silently drop
 * them:
 *
 *   - temporal columns use date mode, so they carry Date values;
 *   - bytea columns are typed through a customType, because drizzle-kit cannot
 *     introspect them;
 *   - every updatedAt column is stamped client-side, and so is
 *     ChatConversation.hermesMemoryKey, because these were client defaults in
 *     the ORM that came before - without the stamping, inserts fail NOT NULL;
 *   - AgentToolGrant.allowedAdminRoles is an enum array that introspection once
 *     rendered as bytea[], a type no role value can be written to.
 *
 * migrations.test.ts asserts on the emitted SQL and guards these decisions.
 */

import { pgTable, index, uniqueIndex, uuid, varchar, text, boolean, timestamp, foreignKey, inet, jsonb, integer, check, doublePrecision, bigint, numeric, bigserial, vector, pgEnum } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { randomUUID } from "node:crypto"
import { bytea } from "./bytea.js"

export const administratorAuthenticationMethod = pgEnum("AdministratorAuthenticationMethod", ['LOCAL_PASSWORD', 'INSTALLATION_KEY_RECOVERY', 'OIDC'])
export const administratorRole = pgEnum("AdministratorRole", ['PLATFORM_ADMIN', 'SECURITY_ADMIN', 'OPERATIONS_ADMIN', 'AUDITOR'])
export const agentProfileStatus = pgEnum("AgentProfileStatus", ['DRAFT', 'ACTIVE', 'SUSPENDED', 'STANDBY'])
export const agentMemoryMode = pgEnum("AgentMemoryMode", ['DOCUMENTS_ONLY', 'RECALL_ONLY', 'LEARN_USER', 'LEARN_EXCHANGE'])
export const memoryProfileScope = pgEnum("MemoryProfileScope", ['STATIC', 'DYNAMIC', 'EPISODIC'])
export const memoryPolicyStatus = pgEnum("MemoryPolicyStatus", ['DRAFT', 'ACTIVE', 'SUSPENDED'])
export const agentRunApprovalStatus = pgEnum("AgentRunApprovalStatus", ['PENDING', 'APPROVED', 'DENIED', 'EXPIRED', 'CANCELLED'])
export const agentRunStatus = pgEnum("AgentRunStatus", ['QUEUED', 'RUNNING', 'WAITING_FOR_APPROVAL', 'CANCEL_REQUESTED', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'DENIED'])
export const auditActorType = pgEnum("AuditActorType", ['USER', 'SERVICE', 'SYSTEM'])
export const chatConversationStatus = pgEnum("ChatConversationStatus", ['ACTIVE', 'ARCHIVED'])
export const chatFeedbackRating = pgEnum("ChatFeedbackRating", ['HELPFUL', 'NOT_HELPFUL'])
export const chatMessageRole = pgEnum("ChatMessageRole", ['USER', 'ASSISTANT'])
export const chatMessageStatus = pgEnum("ChatMessageStatus", ['PENDING', 'COMPLETED', 'FAILED', 'CANCELLED'])
export const componentCompatibilityStatus = pgEnum("ComponentCompatibilityStatus", ['NOT_TESTED', 'IN_PROGRESS', 'PASSED', 'FAILED', 'BLOCKED'])
export const connectionStatus = pgEnum("ConnectionStatus", ['NOT_TESTED', 'HEALTHY', 'DEGRADED', 'UNREACHABLE', 'DISABLED'])
export const deploymentEnvironment = pgEnum("DeploymentEnvironment", ['DEVELOPMENT', 'STAGING', 'PRODUCTION'])
export const deploymentTopologyMode = pgEnum("DeploymentTopologyMode", ['COMPACT', 'CONTROL_PLANE', 'SEGMENTED_PRODUCTION'])
export const documentClassification = pgEnum("DocumentClassification", ['INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'])
export const documentStatus = pgEnum("DocumentStatus", ['QUARANTINED', 'QUEUED', 'CONVERTING', 'READY', 'FAILED', 'REJECTED', 'DELETING', 'DELETED'])
export const evaluationRunStatus = pgEnum("EvaluationRunStatus", ['DRAFT', 'PASSED', 'FAILED', 'PROMOTED'])
export const evaluationTargetType = pgEnum("EvaluationTargetType", ['MODEL', 'PROMPT', 'POLICY', 'AGENT'])
export const guardrailPolicyStatus = pgEnum("GuardrailPolicyStatus", ['DRAFT', 'ACTIVE', 'SUSPENDED'])
export const hermesNodeEnrollmentStatus = pgEnum("HermesNodeEnrollmentStatus", ['ISSUED', 'CONSUMED', 'REVOKED', 'EXPIRED'])
export const hermesRuntimeNodeStatus = pgEnum("HermesRuntimeNodeStatus", ['PENDING', 'ONLINE', 'DEGRADED', 'DRAINING', 'SUSPENDED', 'REVOKED', 'OFFLINE'])
export const modelDeploymentStatus = pgEnum("ModelDeploymentStatus", ['DRAFT', 'ACTIVE', 'SUSPENDED'])
export const modelWorkload = pgEnum("ModelWorkload", ['CHAT', 'AGENT'])
export const onboardingEvidenceOutcome = pgEnum("OnboardingEvidenceOutcome", ['PASSED', 'FAILED', 'WARNING'])
export const onboardingEvidenceSource = pgEnum("OnboardingEvidenceSource", ['AUTOMATED', 'EXTERNAL_ATTESTATION'])
export const onboardingJourneyStatus = pgEnum("OnboardingJourneyStatus", ['NOT_STARTED', 'IN_PROGRESS', 'BLOCKED', 'COMPLETED'])
export const onboardingStepStatus = pgEnum("OnboardingStepStatus", ['NOT_STARTED', 'IN_PROGRESS', 'BLOCKED', 'COMPLETED'])
export const onboardingTargetEnvironment = pgEnum("OnboardingTargetEnvironment", ['DEVELOPMENT', 'PILOT', 'PRODUCTION'])
export const operationalIncidentSeverity = pgEnum("OperationalIncidentSeverity", ['WARNING', 'CRITICAL'])
export const operationalIncidentStatus = pgEnum("OperationalIncidentStatus", ['OPEN', 'ACKNOWLEDGED', 'RESOLVED'])
export const productionReadinessApprovalDecision = pgEnum("ProductionReadinessApprovalDecision", ['APPROVED', 'REJECTED'])
export const productionReadinessApprovalRole = pgEnum("ProductionReadinessApprovalRole", ['SECURITY', 'INFRASTRUCTURE', 'PRODUCT', 'BUSINESS'])
export const productionReadinessControlStatus = pgEnum("ProductionReadinessControlStatus", ['NOT_STARTED', 'IN_PROGRESS', 'BLOCKED', 'VERIFIED', 'WAIVED'])
export const productionReadinessDomain = pgEnum("ProductionReadinessDomain", ['SECURITY', 'INFRASTRUCTURE', 'RECOVERY', 'OPERATIONS', 'TRAINING', 'BUSINESS'])
export const promptPurpose = pgEnum("PromptPurpose", ['CHAT_SYSTEM'])
export const promptTemplateStatus = pgEnum("PromptTemplateStatus", ['DRAFT', 'ACTIVE', 'SUSPENDED'])
export const serviceKind = pgEnum("ServiceKind", ['INFERENCE', 'HERMES', 'MCP', 'OIDC', 'SIEM', 'NOTIFICATION', 'OTHER'])
export const toolApprovalStatus = pgEnum("ToolApprovalStatus", ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED'])
export const toolCallStatus = pgEnum("ToolCallStatus", ['REQUESTED', 'APPROVAL_PENDING', 'EXECUTING', 'COMPLETED', 'FAILED', 'DENIED', 'CANCELLED'])
export const toolResourceScope = pgEnum("ToolResourceScope", ['OWNER_ONLY'])
export const toolRisk = pgEnum("ToolRisk", ['READ_ONLY', 'CONSEQUENTIAL'])
export const toolStatus = pgEnum("ToolStatus", ['ACTIVE', 'SUSPENDED'])
export const workerLifecycleStatus = pgEnum("WorkerLifecycleStatus", ['ONLINE', 'STOPPED'])


export const enterpriseUser = pgTable("EnterpriseUser", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	issuer: varchar({ length: 512 }).notNull(),
	subject: varchar({ length: 255 }).notNull(),
	email: varchar({ length: 320 }),
	displayName: varchar({ length: 200 }).notNull(),
	groups: text().array(),
	enabled: boolean().default(true).notNull(),
	lastLoginAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull(),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
}, (table) => [
	index("EnterpriseUser_email_idx").using("btree", table.email.asc().nullsLast()),
	index("EnterpriseUser_enabled_lastLoginAt_idx").using("btree", table.enabled.asc().nullsLast(), table.lastLoginAt.asc().nullsLast()),
	uniqueIndex("EnterpriseUser_issuer_subject_key").using("btree", table.issuer.asc().nullsLast(), table.subject.asc().nullsLast()),
]);

export const enterpriseUserSession = pgTable("EnterpriseUserSession", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	tokenHash: bytea("tokenHash").notNull(),
	userId: uuid().notNull(),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	lastSeenAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull(),
	idleExpiresAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull(),
	absoluteExpiresAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull(),
	revokedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	sourceIp: inet(),
	userAgentHash: varchar({ length: 64 }),
}, (table) => [
	index("EnterpriseUserSession_absoluteExpiresAt_idx").using("btree", table.absoluteExpiresAt.asc().nullsLast()),
	index("EnterpriseUserSession_revokedAt_idleExpiresAt_idx").using("btree", table.revokedAt.asc().nullsLast(), table.idleExpiresAt.asc().nullsLast()),
	uniqueIndex("EnterpriseUserSession_tokenHash_key").using("btree", table.tokenHash.asc().nullsLast()),
	index("EnterpriseUserSession_userId_createdAt_idx").using("btree", table.userId.asc().nullsLast(), table.createdAt.asc().nullsLast()),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [enterpriseUser.id],
			name: "EnterpriseUserSession_userId_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const auditEvent = pgTable("AuditEvent", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	occurredAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	actorType: auditActorType().notNull(),
	actorId: uuid(),
	action: varchar({ length: 160 }).notNull(),
	resourceType: varchar({ length: 120 }).notNull(),
	resourceId: varchar({ length: 160 }),
	outcome: varchar({ length: 40 }).notNull(),
	correlationId: uuid(),
	sourceIp: inet(),
	metadata: jsonb().default({}).notNull(),
}, (table) => [
	index("AuditEvent_actorId_occurredAt_idx").using("btree", table.actorId.asc().nullsLast(), table.occurredAt.asc().nullsLast()),
	index("AuditEvent_correlationId_idx").using("btree", table.correlationId.asc().nullsLast()),
	index("AuditEvent_occurredAt_idx").using("btree", table.occurredAt.asc().nullsLast()),
	index("AuditEvent_resourceType_resourceId_idx").using("btree", table.resourceType.asc().nullsLast(), table.resourceId.asc().nullsLast()),
]);

export const secretRecord = pgTable("SecretRecord", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	serviceConnectionId: uuid().notNull(),
	fieldName: varchar({ length: 120 }).notNull(),
	encryptedValue: bytea("encryptedValue").notNull(),
	valueNonce: bytea("valueNonce").notNull(),
	valueAuthTag: bytea("valueAuthTag").notNull(),
	wrappedDataKey: bytea("wrappedDataKey").notNull(),
	keyNonce: bytea("keyNonce").notNull(),
	keyAuthTag: bytea("keyAuthTag").notNull(),
	encryptionVersion: integer().default(1).notNull(),
	masterKeyVersion: integer().default(1).notNull(),
	active: boolean().default(true).notNull(),
	createdBy: uuid(),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	retiredAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
}, (table) => [
	index("SecretRecord_createdAt_idx").using("btree", table.createdAt.asc().nullsLast()),
	index("SecretRecord_serviceConnectionId_fieldName_active_idx").using("btree", table.serviceConnectionId.asc().nullsLast(), table.fieldName.asc().nullsLast(), table.active.asc().nullsLast()),
	foreignKey({
			columns: [table.serviceConnectionId],
			foreignColumns: [serviceConnection.id],
			name: "SecretRecord_serviceConnectionId_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const configurationRevision = pgTable("ConfigurationRevision", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	serviceConnectionId: uuid().notNull(),
	revision: integer().notNull(),
	configuration: jsonb().notNull(),
	secretFieldNames: text().array(),
	checksum: varchar({ length: 64 }).notNull(),
	createdBy: uuid(),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	activatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
}, (table) => [
	index("ConfigurationRevision_createdAt_idx").using("btree", table.createdAt.asc().nullsLast()),
	uniqueIndex("ConfigurationRevision_serviceConnectionId_revision_key").using("btree", table.serviceConnectionId.asc().nullsLast(), table.revision.asc().nullsLast()),
	foreignKey({
			columns: [table.serviceConnectionId],
			foreignColumns: [serviceConnection.id],
			name: "ConfigurationRevision_serviceConnectionId_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const agentProfile = pgTable("AgentProfile", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	slug: varchar({ length: 64 }).notNull(),
	status: agentProfileStatus().default('DRAFT').notNull(),
	currentVersion: integer().default(1).notNull(),
	activeVersion: integer(),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
}, (table) => [
	uniqueIndex("AgentProfile_slug_key").using("btree", table.slug.asc().nullsLast()),
	index("AgentProfile_status_updatedAt_idx").using("btree", table.status.asc().nullsLast(), table.updatedAt.asc().nullsLast()),
]);

export const workerNode = pgTable("WorkerNode", {
	id: varchar({ length: 160 }).primaryKey().notNull(),
	name: varchar({ length: 160 }).notNull(),
	version: varchar({ length: 40 }).notNull(),
	status: workerLifecycleStatus().default('ONLINE').notNull(),
	workloads: text().array(),
	metadata: jsonb().default({}).notNull(),
	startedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull(),
	lastSeenAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull(),
	stoppedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
}, (table) => [
	index("WorkerNode_lastSeenAt_idx").using("btree", table.lastSeenAt.asc().nullsLast()),
	index("WorkerNode_status_lastSeenAt_idx").using("btree", table.status.asc().nullsLast(), table.lastSeenAt.asc().nullsLast()),
]);

export const chatFeedback = pgTable("ChatFeedback", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	messageId: uuid().notNull(),
	ownerSubject: varchar({ length: 200 }).notNull(),
	rating: chatFeedbackRating().notNull(),
	comment: varchar({ length: 1000 }),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
}, (table) => [
	uniqueIndex("ChatFeedback_messageId_key").using("btree", table.messageId.asc().nullsLast()),
	index("ChatFeedback_ownerSubject_createdAt_idx").using("btree", table.ownerSubject.asc().nullsLast(), table.createdAt.asc().nullsLast()),
	index("ChatFeedback_rating_createdAt_idx").using("btree", table.rating.asc().nullsLast(), table.createdAt.asc().nullsLast()),
	foreignKey({
			columns: [table.messageId],
			foreignColumns: [chatMessage.id],
			name: "ChatFeedback_messageId_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const agentRuntimeControl = pgTable("AgentRuntimeControl", {
	id: varchar({ length: 32 }).default('global').primaryKey().notNull(),
	enabled: boolean().default(false).notNull(),
	reason: varchar({ length: 500 }),
	updatedBy: uuid(),
	updatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
});

export const agentProfileVersion = pgTable("AgentProfileVersion", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	profileId: uuid().notNull(),
	version: integer().notNull(),
	displayName: varchar({ length: 120 }).notNull(),
	purpose: varchar({ length: 500 }).notNull(),
	instructions: text().notNull(),
	modelAlias: varchar({ length: 200 }).notNull(),
	maxTurns: integer().notNull(),
	timeoutSeconds: integer().notNull(),
	maxConcurrentRuns: integer().notNull(),
	allowPrivateKnowledge: boolean().default(false).notNull(),
	memoryMode: agentMemoryMode().default('DOCUMENTS_ONLY').notNull(),
	safeMode: boolean().default(true).notNull(),
	createdBy: uuid(),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	soulMd: text().default("").notNull(),
	skills: jsonb().default([]).notNull(),
	distributionDigest: varchar({ length: 64 }),
}, (table) => [
	index("AgentProfileVersion_profileId_createdAt_idx").using("btree", table.profileId.asc().nullsLast(), table.createdAt.asc().nullsLast()),
	uniqueIndex("AgentProfileVersion_profileId_version_key").using("btree", table.profileId.asc().nullsLast(), table.version.asc().nullsLast()),
	foreignKey({
			columns: [table.profileId],
			foreignColumns: [agentProfile.id],
			name: "AgentProfileVersion_profileId_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	check("AgentProfileVersion_phase5_boundary_check", sql`("maxTurns" = 1) AND ("safeMode" = true)`),
]);


export const chatConversation = pgTable("ChatConversation", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	ownerSubject: varchar({ length: 200 }).notNull(),
	title: varchar({ length: 160 }).notNull(),
	modelAlias: varchar({ length: 200 }).notNull(),
	status: chatConversationStatus().default('ACTIVE').notNull(),
	generation: integer().default(0).notNull(),
	lastMessageAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
	profileId: uuid(),
	profileName: varchar({ length: 120 }),
	// Adaptation: Prisma defaulted this client-side with @default(uuid()), so the
	// column carries no database default and needs the same stamping here.
	hermesMemoryKey: varchar({ length: 200 }).notNull().$defaultFn(() => randomUUID()),
	// How far memory extraction has read this conversation. Null means never;
	// older than lastMessageAt means there is new material to distil. Capture
	// runs once the conversation goes quiet rather than once per turn, so the
	// model sees the whole arc and is called once instead of per message.
	memoryDistilledAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
}, (table) => [
	index("ChatConversation_lastMessageAt_idx").using("btree", table.lastMessageAt.asc().nullsLast()),
	// Drives the idle sweep: the partial predicate keeps the index to the
	// conversations that could still owe a distillation.
	index("ChatConversation_memoryPending_idx")
		.using("btree", table.lastMessageAt.asc().nullsLast())
		.where(sql`"memoryDistilledAt" IS NULL OR "memoryDistilledAt" < "lastMessageAt"`),
	index("ChatConversation_ownerSubject_status_updatedAt_idx").using("btree", table.ownerSubject.asc().nullsLast(), table.status.asc().nullsLast(), table.updatedAt.asc().nullsLast()),
]);

export const chatMessage = pgTable("ChatMessage", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	conversationId: uuid().notNull(),
	ordinal: integer().notNull(),
	role: chatMessageRole().notNull(),
	status: chatMessageStatus().notNull(),
	content: text().notNull(),
	modelAlias: varchar({ length: 200 }),
	inputTokens: integer(),
	outputTokens: integer(),
	totalTokens: integer(),
	latencyMs: integer(),
	finishReason: varchar({ length: 120 }),
	providerRequestId: varchar({ length: 200 }),
	errorCode: varchar({ length: 80 }),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	completedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	sources: jsonb().default([]).notNull(),
	agentRunId: uuid(),
	reasoningTokens: integer(),
	firstTokenLatencyMs: integer(),
}, (table) => [
	uniqueIndex("ChatMessage_agentRunId_key").using("btree", table.agentRunId.asc().nullsLast()),
	index("ChatMessage_conversationId_createdAt_idx").using("btree", table.conversationId.asc().nullsLast(), table.createdAt.asc().nullsLast()),
	uniqueIndex("ChatMessage_conversationId_ordinal_key").using("btree", table.conversationId.asc().nullsLast(), table.ordinal.asc().nullsLast()),
	index("ChatMessage_status_createdAt_idx").using("btree", table.status.asc().nullsLast(), table.createdAt.asc().nullsLast()),
	foreignKey({
			columns: [table.conversationId],
			foreignColumns: [chatConversation.id],
			name: "ChatMessage_conversationId_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.agentRunId],
			foreignColumns: [agentRun.id],
			name: "ChatMessage_agentRunId_fkey"
		}).onUpdate("cascade").onDelete("set null"),
]);

export const agentToolGrant = pgTable("AgentToolGrant", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	profileVersionId: uuid().notNull(),
	toolId: uuid().notNull(),
	enabled: boolean().default(true).notNull(),
	allowedGroups: text().array().notNull(),
	// Adaptation: drizzle-kit could not introspect an enum array and fell back to
	// bytea[], which the baseline then created. Corrected by migration 0001.
	allowedAdminRoles: administratorRole("allowedAdminRoles").array().notNull(),
	resourceScope: toolResourceScope().default('OWNER_ONLY').notNull(),
	createdBy: uuid(),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
}, (table) => [
	uniqueIndex("AgentToolGrant_profileVersionId_toolId_key").using("btree", table.profileVersionId.asc().nullsLast(), table.toolId.asc().nullsLast()),
	index("AgentToolGrant_toolId_enabled_idx").using("btree", table.toolId.asc().nullsLast(), table.enabled.asc().nullsLast()),
	foreignKey({
			columns: [table.profileVersionId],
			foreignColumns: [agentProfileVersion.id],
			name: "AgentToolGrant_profileVersionId_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.toolId],
			foreignColumns: [governedTool.id],
			name: "AgentToolGrant_toolId_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
	check("AgentToolGrant_principal_check", sql`(cardinality("allowedGroups") > 0) OR (cardinality("allowedAdminRoles") > 0)`),
]);

export const governedTool = pgTable("GovernedTool", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	slug: varchar({ length: 80 }).notNull(),
	displayName: varchar({ length: 120 }).notNull(),
	description: varchar({ length: 1000 }).notNull(),
	risk: toolRisk().notNull(),
	status: toolStatus().default('ACTIVE').notNull(),
	handlerKey: varchar({ length: 120 }).notNull(),
	inputSchema: jsonb().notNull(),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
}, (table) => [
	uniqueIndex("GovernedTool_slug_key").using("btree", table.slug.asc().nullsLast()),
	index("GovernedTool_status_risk_idx").using("btree", table.status.asc().nullsLast(), table.risk.asc().nullsLast()),
]);

export const oidcAuthorizationRequest = pgTable("OidcAuthorizationRequest", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	serviceConnectionId: uuid().notNull(),
	stateHash: bytea("stateHash").notNull(),
	nonce: varchar({ length: 86 }).notNull(),
	returnTo: varchar({ length: 500 }).notNull(),
	issuer: varchar({ length: 512 }).notNull(),
	tokenEndpoint: varchar({ length: 2048 }).notNull(),
	jwksUri: varchar({ length: 2048 }).notNull(),
	clientId: varchar({ length: 256 }).notNull(),
	redirectUri: varchar({ length: 2048 }).notNull(),
	codeVerifierEncryptedValue: bytea("codeVerifierEncryptedValue").notNull(),
	codeVerifierValueNonce: bytea("codeVerifierValueNonce").notNull(),
	codeVerifierValueAuthTag: bytea("codeVerifierValueAuthTag").notNull(),
	codeVerifierWrappedDataKey: bytea("codeVerifierWrappedDataKey").notNull(),
	codeVerifierKeyNonce: bytea("codeVerifierKeyNonce").notNull(),
	codeVerifierKeyAuthTag: bytea("codeVerifierKeyAuthTag").notNull(),
	encryptionVersion: integer().default(1).notNull(),
	masterKeyVersion: integer().default(1).notNull(),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	expiresAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull(),
	consumedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
}, (table) => [
	index("OidcAuthorizationRequest_expiresAt_consumedAt_idx").using("btree", table.expiresAt.asc().nullsLast(), table.consumedAt.asc().nullsLast()),
	index("OidcAuthorizationRequest_serviceConnectionId_createdAt_idx").using("btree", table.serviceConnectionId.asc().nullsLast(), table.createdAt.asc().nullsLast()),
	uniqueIndex("OidcAuthorizationRequest_stateHash_key").using("btree", table.stateHash.asc().nullsLast()),
	foreignKey({
			columns: [table.serviceConnectionId],
			foreignColumns: [serviceConnection.id],
			name: "OidcAuthorizationRequest_serviceConnectionId_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const mcpGatewayCredential = pgTable("McpGatewayCredential", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: varchar({ length: 120 }).notNull(),
	tokenPrefix: varchar({ length: 32 }).notNull(),
	tokenHash: bytea("tokenHash").notNull(),
	enabled: boolean().default(true).notNull(),
	lastUsedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	revokedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	createdBy: uuid(),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	index("McpGatewayCredential_enabled_revokedAt_idx").using("btree", table.enabled.asc().nullsLast(), table.revokedAt.asc().nullsLast()),
	uniqueIndex("McpGatewayCredential_tokenHash_key").using("btree", table.tokenHash.asc().nullsLast()),
	uniqueIndex("McpGatewayCredential_tokenPrefix_key").using("btree", table.tokenPrefix.asc().nullsLast()),
	check("McpGatewayCredential_tokenHash_check", sql`octet_length("tokenHash") = 32`),
]);

export const operationalIncident = pgTable("OperationalIncident", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	activeFingerprint: varchar({ length: 160 }),
	title: varchar({ length: 160 }).notNull(),
	severity: operationalIncidentSeverity().notNull(),
	status: operationalIncidentStatus().default('OPEN').notNull(),
	component: varchar({ length: 80 }).notNull(),
	summary: varchar({ length: 1000 }).notNull(),
	owner: varchar({ length: 160 }),
	automated: boolean().default(false).notNull(),
	detectedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	lastObservedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	acknowledgedBy: uuid(),
	acknowledgedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	resolvedBy: uuid(),
	resolvedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	resolutionNote: varchar({ length: 1000 }),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
}, (table) => [
	uniqueIndex("OperationalIncident_activeFingerprint_key").using("btree", table.activeFingerprint.asc().nullsLast()),
	index("OperationalIncident_component_status_idx").using("btree", table.component.asc().nullsLast(), table.status.asc().nullsLast()),
	index("OperationalIncident_owner_status_idx").using("btree", table.owner.asc().nullsLast(), table.status.asc().nullsLast()),
	index("OperationalIncident_status_severity_detectedAt_idx").using("btree", table.status.asc().nullsLast(), table.severity.asc().nullsLast(), table.detectedAt.asc().nullsLast()),
	check("OperationalIncident_lifecycle_check", sql`((status = 'OPEN'::"OperationalIncidentStatus") AND ("acknowledgedAt" IS NULL) AND ("resolvedAt" IS NULL)) OR ((status = 'ACKNOWLEDGED'::"OperationalIncidentStatus") AND ("acknowledgedAt" IS NOT NULL) AND ("resolvedAt" IS NULL)) OR ((status = 'RESOLVED'::"OperationalIncidentStatus") AND ("resolvedAt" IS NOT NULL) AND ("activeFingerprint" IS NULL))`),
]);

export const toolRuntimeControl = pgTable("ToolRuntimeControl", {
	id: varchar({ length: 32 }).default('global').primaryKey().notNull(),
	enabled: boolean().default(false).notNull(),
	reason: varchar({ length: 500 }),
	approvalTtlMinutes: integer().default(15).notNull(),
	updatedBy: uuid(),
	updatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
}, (table) => [
	check("ToolRuntimeControl_approvalTtlMinutes_check", sql`("approvalTtlMinutes" >= 5) AND ("approvalTtlMinutes" <= 1440)`),
]);

/**
 * Which Hermes toolsets this installation permits the runtime to enable.
 *
 * A row exists only once an operator has decided about a toolset, and the row
 * survives revocation so the reason and the deciding administrator stay on
 * record. Absence means "never admitted", which is the same refusal as
 * `admitted = false` — a fresh install has no rows and therefore admits nothing.
 */
export const runtimeToolsetAdmission = pgTable("RuntimeToolsetAdmission", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	toolsetName: varchar({ length: 120 }).notNull(),
	admitted: boolean().default(false).notNull(),
	reason: varchar({ length: 500 }).notNull(),
	admittedBy: uuid(),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()),
	updatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
}, (table) => [
	uniqueIndex("RuntimeToolsetAdmission_toolsetName_key").on(table.toolsetName),
]);

export const governedToolCall = pgTable("GovernedToolCall", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	runId: uuid().notNull(),
	toolId: uuid().notNull(),
	grantId: uuid().notNull(),
	requestId: uuid().notNull(),
	status: toolCallStatus().default('REQUESTED').notNull(),
	arguments: jsonb().notNull(),
	result: jsonb(),
	errorCode: varchar({ length: 80 }),
	errorMessage: varchar({ length: 500 }),
	requestedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	startedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	completedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
}, (table) => [
	index("GovernedToolCall_runId_createdAt_idx").using("btree", table.runId.asc().nullsLast(), table.createdAt.asc().nullsLast()),
	uniqueIndex("GovernedToolCall_runId_requestId_key").using("btree", table.runId.asc().nullsLast(), table.requestId.asc().nullsLast()),
	index("GovernedToolCall_status_requestedAt_idx").using("btree", table.status.asc().nullsLast(), table.requestedAt.asc().nullsLast()),
	index("GovernedToolCall_toolId_status_createdAt_idx").using("btree", table.toolId.asc().nullsLast(), table.status.asc().nullsLast(), table.createdAt.asc().nullsLast()),
	foreignKey({
			columns: [table.runId],
			foreignColumns: [agentRun.id],
			name: "GovernedToolCall_runId_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
	foreignKey({
			columns: [table.toolId],
			foreignColumns: [governedTool.id],
			name: "GovernedToolCall_toolId_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
	foreignKey({
			columns: [table.grantId],
			foreignColumns: [agentToolGrant.id],
			name: "GovernedToolCall_grantId_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
	check("GovernedToolCall_arguments_object_check", sql`jsonb_typeof(arguments) = 'object'::text`),
]);

export const toolApproval = pgTable("ToolApproval", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	callId: uuid().notNull(),
	status: toolApprovalStatus().default('PENDING').notNull(),
	expiresAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull(),
	decisionReason: varchar({ length: 1000 }),
	decisionBy: uuid(),
	decidedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
}, (table) => [
	uniqueIndex("ToolApproval_callId_key").using("btree", table.callId.asc().nullsLast()),
	index("ToolApproval_status_expiresAt_idx").using("btree", table.status.asc().nullsLast(), table.expiresAt.asc().nullsLast()),
	foreignKey({
			columns: [table.callId],
			foreignColumns: [governedToolCall.id],
			name: "ToolApproval_callId_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
]);

export const evaluationRun = pgTable("EvaluationRun", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: varchar({ length: 160 }).notNull(),
	targetType: evaluationTargetType().notNull(),
	targetReference: varchar({ length: 240 }).notNull(),
	targetVersion: varchar({ length: 120 }).notNull(),
	status: evaluationRunStatus().default('DRAFT').notNull(),
	minimumPassRate: doublePrecision().notNull(),
	requiredCategories: text().array().notNull(),
	categoryResults: jsonb().default([]).notNull(),
	totalCases: integer().default(0).notNull(),
	passedCases: integer().default(0).notNull(),
	criticalFailures: integer().default(0).notNull(),
	createdBy: uuid(),
	completedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	promotedBy: uuid(),
	promotedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	promotionReason: varchar({ length: 1000 }),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
}, (table) => [
	index("EvaluationRun_status_createdAt_idx").using("btree", table.status.asc().nullsLast(), table.createdAt.asc().nullsLast()),
	index("EvaluationRun_targetType_targetReference_targetVersion_idx").using("btree", table.targetType.asc().nullsLast(), table.targetReference.asc().nullsLast(), table.targetVersion.asc().nullsLast()),
	check("EvaluationRun_threshold_check", sql`("minimumPassRate" >= (0.5)::double precision) AND ("minimumPassRate" <= (1)::double precision)`),
	check("EvaluationRun_categories_check", sql`(cardinality("requiredCategories") >= 1) AND (cardinality("requiredCategories") <= 6)`),
	check("EvaluationRun_results_shape_check", sql`jsonb_typeof("categoryResults") = 'array'::text`),
	check("EvaluationRun_counts_check", sql`("totalCases" >= 0) AND ("passedCases" >= 0) AND ("passedCases" <= "totalCases") AND ("criticalFailures" >= 0) AND ("criticalFailures" <= ("totalCases" - "passedCases"))`),
	check("EvaluationRun_evidence_check", sql`((status = 'DRAFT'::"EvaluationRunStatus") AND ("completedAt" IS NULL) AND ("promotedAt" IS NULL) AND ("promotionReason" IS NULL)) OR ((status = ANY (ARRAY['PASSED'::"EvaluationRunStatus", 'FAILED'::"EvaluationRunStatus"])) AND ("completedAt" IS NOT NULL) AND ("promotedAt" IS NULL) AND ("promotionReason" IS NULL) AND (jsonb_array_length("categoryResults") > 0)) OR ((status = 'PROMOTED'::"EvaluationRunStatus") AND ("completedAt" IS NOT NULL) AND ("promotedAt" IS NOT NULL) AND (length(btrim(("promotionReason")::text)) >= 3) AND (jsonb_array_length("categoryResults") > 0))`),
	check("EvaluationRun_quality_check", sql`(status = ANY (ARRAY['DRAFT'::"EvaluationRunStatus", 'FAILED'::"EvaluationRunStatus"])) OR (("totalCases" > 0) AND ("criticalFailures" = 0) AND ((("passedCases")::double precision / ("totalCases")::double precision) >= "minimumPassRate"))`),
]);

export const productionReadinessControl = pgTable("ProductionReadinessControl", {
	key: varchar({ length: 80 }).primaryKey().notNull(),
	title: varchar({ length: 160 }).notNull(),
	domain: productionReadinessDomain().notNull(),
	description: varchar({ length: 1000 }).notNull(),
	status: productionReadinessControlStatus().default('NOT_STARTED').notNull(),
	owner: varchar({ length: 160 }),
	evidenceRefs: text().array().default([]).notNull(),
	note: varchar({ length: 1000 }),
	lastUpdatedBy: varchar({ length: 160 }),
	verifiedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	revision: integer().default(0).notNull(),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
}, (table) => [
	index("ProductionReadinessControl_domain_status_idx").using("btree", table.domain.asc().nullsLast(), table.status.asc().nullsLast()),
	index("ProductionReadinessControl_status_updatedAt_idx").using("btree", table.status.asc().nullsLast(), table.updatedAt.asc().nullsLast()),
	check("ProductionReadinessControl_key_check", sql`(key)::text ~ '^[a-z][a-z0-9-]{2,79}$'::text`),
	check("ProductionReadinessControl_owner_check", sql`(status = 'NOT_STARTED'::"ProductionReadinessControlStatus") OR ((owner IS NOT NULL) AND (length(btrim((owner)::text)) > 0))`),
	check("ProductionReadinessControl_note_check", sql`(status <> ALL (ARRAY['BLOCKED'::"ProductionReadinessControlStatus", 'VERIFIED'::"ProductionReadinessControlStatus", 'WAIVED'::"ProductionReadinessControlStatus"])) OR ((note IS NOT NULL) AND (length(btrim((note)::text)) >= 3))`),
	check("ProductionReadinessControl_evidence_check", sql`(status <> ALL (ARRAY['VERIFIED'::"ProductionReadinessControlStatus", 'WAIVED'::"ProductionReadinessControlStatus"])) OR (cardinality("evidenceRefs") > 0)`),
	check("ProductionReadinessControl_verification_check", sql`((status = ANY (ARRAY['VERIFIED'::"ProductionReadinessControlStatus", 'WAIVED'::"ProductionReadinessControlStatus"])) AND ("verifiedAt" IS NOT NULL)) OR ((status <> ALL (ARRAY['VERIFIED'::"ProductionReadinessControlStatus", 'WAIVED'::"ProductionReadinessControlStatus"])) AND ("verifiedAt" IS NULL))`),
]);

export const productionReadinessApproval = pgTable("ProductionReadinessApproval", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	role: productionReadinessApprovalRole().notNull(),
	decision: productionReadinessApprovalDecision().notNull(),
	authority: varchar({ length: 160 }).notNull(),
	evidenceRef: varchar({ length: 500 }).notNull(),
	reason: varchar({ length: 1000 }).notNull(),
	recordedBy: varchar({ length: 160 }).notNull(),
	recordedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	controlRevisions: jsonb().default({}).notNull(),
}, (table) => [
	index("ProductionReadinessApproval_decision_recordedAt_idx").using("btree", table.decision.asc().nullsLast(), table.recordedAt.asc().nullsLast()),
	index("ProductionReadinessApproval_role_recordedAt_idx").using("btree", table.role.asc().nullsLast(), table.recordedAt.asc().nullsLast()),
	check("ProductionReadinessApproval_content_check", sql`(length(btrim((authority)::text)) > 0) AND (length(btrim(("evidenceRef")::text)) > 0) AND (length(btrim((reason)::text)) >= 3) AND (length(btrim(("recordedBy")::text)) > 0)`),
	check("ProductionReadinessApproval_snapshot_check", sql`jsonb_typeof("controlRevisions") = 'object'::text`),
]);


export const connectionMonitoringControl = pgTable("ConnectionMonitoringControl", {
	id: varchar({ length: 32 }).default('global').primaryKey().notNull(),
	enabled: boolean().default(false).notNull(),
	intervalSeconds: integer().default(300).notNull(),
	reason: varchar({ length: 500 }),
	updatedBy: uuid(),
	updatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
}, (table) => [
	check("ConnectionMonitoringControl_intervalSeconds_check", sql`("intervalSeconds" >= 30) AND ("intervalSeconds" <= 86400)`),
]);

export const serviceConnection = pgTable("ServiceConnection", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	slug: varchar({ length: 64 }).notNull(),
	displayName: varchar({ length: 120 }).notNull(),
	kind: serviceKind().notNull(),
	environment: deploymentEnvironment().notNull(),
	baseUrl: text(),
	enabled: boolean().default(false).notNull(),
	status: connectionStatus().default('NOT_TESTED').notNull(),
	configuration: jsonb().default({}).notNull(),
	activeRevision: integer().default(1).notNull(),
	lastHealthcheckAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	lastHealthcheckMessage: text(),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
	monitoringClaimedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	monitoringClaimedBy: varchar({ length: 200 }),
	monitoringClaimToken: uuid(),
}, (table) => [
	index("ServiceConnection_enabled_status_idx").using("btree", table.enabled.asc().nullsLast(), table.status.asc().nullsLast()),
	index("ServiceConnection_kind_environment_idx").using("btree", table.kind.asc().nullsLast(), table.environment.asc().nullsLast()),
	index("ServiceConnection_monitoringClaimedAt_idx").using("btree", table.monitoringClaimedAt.asc().nullsLast()),
	uniqueIndex("ServiceConnection_slug_key").using("btree", table.slug.asc().nullsLast()),
	check("ServiceConnection_monitoringClaim_check", sql`(("monitoringClaimedAt" IS NULL) AND ("monitoringClaimedBy" IS NULL) AND ("monitoringClaimToken" IS NULL)) OR (("monitoringClaimedAt" IS NOT NULL) AND ("monitoringClaimedBy" IS NOT NULL) AND ("monitoringClaimToken" IS NOT NULL))`),
]);

export const modelDeployment = pgTable("ModelDeployment", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	slug: varchar({ length: 64 }).notNull(),
	displayName: varchar({ length: 120 }).notNull(),
	modelAlias: varchar({ length: 200 }).notNull(),
	workload: modelWorkload().notNull(),
	status: modelDeploymentStatus().default('DRAFT').notNull(),
	connectionId: uuid().notNull(),
	version: varchar({ length: 120 }).notNull(),
	license: varchar({ length: 160 }),
	contextWindowTokens: integer().notNull(),
	maxOutputTokens: integer().notNull(),
	maxConcurrentRequests: integer().notNull(),
	isDefault: boolean().default(false).notNull(),
	activationEvaluationId: uuid(),
	firstActivatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	revision: integer().default(1).notNull(),
	createdBy: uuid(),
	updatedBy: uuid(),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
}, (table) => [
	index("ModelDeployment_activationEvaluationId_idx").using("btree", table.activationEvaluationId.asc().nullsLast()),
	uniqueIndex("ModelDeployment_active_default_workload_key").using("btree", table.workload.asc().nullsLast()).where(sql`((status = 'ACTIVE'::"ModelDeploymentStatus") AND ("isDefault" = true))`),
	index("ModelDeployment_connectionId_idx").using("btree", table.connectionId.asc().nullsLast()),
	uniqueIndex("ModelDeployment_slug_key").using("btree", table.slug.asc().nullsLast()),
	uniqueIndex("ModelDeployment_workload_modelAlias_key").using("btree", table.workload.asc().nullsLast(), table.modelAlias.asc().nullsLast()),
	index("ModelDeployment_workload_status_idx").using("btree", table.workload.asc().nullsLast(), table.status.asc().nullsLast()),
	foreignKey({
			columns: [table.connectionId],
			foreignColumns: [serviceConnection.id],
			name: "ModelDeployment_connectionId_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
	foreignKey({
			columns: [table.activationEvaluationId],
			foreignColumns: [evaluationRun.id],
			name: "ModelDeployment_activationEvaluationId_fkey"
		}).onUpdate("cascade").onDelete("set null"),
	check("ModelDeployment_limits_check", sql`(("contextWindowTokens" >= 1024) AND ("contextWindowTokens" <= 4194304)) AND (("maxOutputTokens" >= 64) AND ("maxOutputTokens" <= 131072)) AND ("maxOutputTokens" <= "contextWindowTokens") AND (("maxConcurrentRequests" >= 1) AND ("maxConcurrentRequests" <= 1024)) AND (revision > 0)`),
	check("ModelDeployment_activation_evidence_check", sql`(status <> 'ACTIVE'::"ModelDeploymentStatus") OR (("activationEvaluationId" IS NOT NULL) AND ("firstActivatedAt" IS NOT NULL))`),
	check("ModelDeployment_default_status_check", sql`("isDefault" = false) OR (status = 'ACTIVE'::"ModelDeploymentStatus")`),
]);

export const promptTemplate = pgTable("PromptTemplate", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	slug: varchar({ length: 64 }).notNull(),
	displayName: varchar({ length: 120 }).notNull(),
	description: varchar({ length: 500 }).notNull(),
	purpose: promptPurpose().notNull(),
	version: varchar({ length: 120 }).notNull(),
	status: promptTemplateStatus().default('DRAFT').notNull(),
	content: text().notNull(),
	contentChecksum: varchar({ length: 64 }).notNull(),
	activationEvaluationId: uuid(),
	firstActivatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	revision: integer().default(1).notNull(),
	createdBy: uuid(),
	updatedBy: uuid(),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
}, (table) => [
	index("PromptTemplate_activationEvaluationId_idx").using("btree", table.activationEvaluationId.asc().nullsLast()),
	index("PromptTemplate_purpose_status_idx").using("btree", table.purpose.asc().nullsLast(), table.status.asc().nullsLast()),
	uniqueIndex("PromptTemplate_single_active_purpose_key").using("btree", table.purpose.asc().nullsLast()).where(sql`(status = 'ACTIVE'::"PromptTemplateStatus")`),
	uniqueIndex("PromptTemplate_slug_key").using("btree", table.slug.asc().nullsLast()),
	foreignKey({
			columns: [table.activationEvaluationId],
			foreignColumns: [evaluationRun.id],
			name: "PromptTemplate_activationEvaluationId_fkey"
		}).onUpdate("cascade").onDelete("set null"),
	check("PromptTemplate_content_check", sql`((char_length(btrim(content)) >= 20) AND (char_length(btrim(content)) <= 20000)) AND (("contentChecksum")::text ~ '^[a-f0-9]{64}$'::text) AND (revision > 0)`),
	check("PromptTemplate_activation_evidence_check", sql`(status <> 'ACTIVE'::"PromptTemplateStatus") OR (("activationEvaluationId" IS NOT NULL) AND ("firstActivatedAt" IS NOT NULL))`),
]);

export const onboardingStep = pgTable("OnboardingStep", {
	key: varchar({ length: 80 }).primaryKey().notNull(),
	ordinal: integer().notNull(),
	title: varchar({ length: 160 }).notNull(),
	description: varchar({ length: 1000 }).notNull(),
	required: boolean().default(true).notNull(),
	status: onboardingStepStatus().default('NOT_STARTED').notNull(),
	evidenceRefs: text().array().default([]),
	note: varchar({ length: 1000 }),
	revision: integer().default(0).notNull(),
	updatedBy: uuid(),
	completedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
}, (table) => [
	uniqueIndex("OnboardingStep_ordinal_key").using("btree", table.ordinal.asc().nullsLast()),
	index("OnboardingStep_status_ordinal_idx").using("btree", table.status.asc().nullsLast(), table.ordinal.asc().nullsLast()),
]);

export const onboardingJourney = pgTable("OnboardingJourney", {
	id: varchar({ length: 32 }).default('global').primaryKey().notNull(),
	status: onboardingJourneyStatus().default('NOT_STARTED').notNull(),
	currentStepKey: varchar({ length: 80 }),
	reason: varchar({ length: 1000 }),
	revision: integer().default(0).notNull(),
	startedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	completedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	updatedBy: uuid(),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
	activatedEnvironment: onboardingTargetEnvironment(),
});

export const componentCompatibility = pgTable("ComponentCompatibility", {
	key: varchar({ length: 80 }).primaryKey().notNull(),
	displayName: varchar({ length: 160 }).notNull(),
	category: varchar({ length: 80 }).notNull(),
	required: boolean().default(true).notNull(),
	expectedContract: varchar({ length: 1000 }).notNull(),
	status: componentCompatibilityStatus().default('NOT_TESTED').notNull(),
	observedVersion: varchar({ length: 240 }),
	evidenceRef: varchar({ length: 500 }),
	note: varchar({ length: 1000 }),
	testedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	updatedBy: uuid(),
	revision: integer().default(0).notNull(),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
}, (table) => [
	index("ComponentCompatibility_category_status_idx").using("btree", table.category.asc().nullsLast(), table.status.asc().nullsLast()),
	index("ComponentCompatibility_required_status_idx").using("btree", table.required.asc().nullsLast(), table.status.asc().nullsLast()),
]);

export const document = pgTable("Document", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	ownerSubject: varchar({ length: 200 }).notNull(),
	fileName: varchar({ length: 255 }).notNull(),
	mediaType: varchar({ length: 160 }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	sizeBytes: bigint({ mode: "number" }).notNull(),
	sha256: varchar({ length: 64 }).notNull(),
	classification: documentClassification().notNull(),
	status: documentStatus().default('QUEUED').notNull(),
	failureCode: varchar({ length: 80 }),
	failureMessage: varchar({ length: 500 }),
	// Extracted text awaiting embedding. The API extracts synchronously because
	// that is fast and needs no model, then hands the text to the worker, which
	// owns the slow part. Cleared once the chunks are written, so this is a
	// queue payload rather than storage: no source bytes are ever retained.
	pendingText: text(),
	ingestionAttempts: integer().default(0).notNull(),
	ingestionLeaseOwner: uuid(),
	ingestionLeaseExpiresAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	retentionUntil: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull(),
	completedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	deletedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
}, (table) => [
	index("Document_ownerSubject_status_updatedAt_idx").using("btree", table.ownerSubject.asc().nullsLast(), table.status.asc().nullsLast(), table.updatedAt.asc().nullsLast()),
	index("Document_retentionUntil_status_idx").using("btree", table.retentionUntil.asc().nullsLast(), table.status.asc().nullsLast()),
	index("Document_sha256_idx").using("btree", table.sha256.asc().nullsLast()),
	index("Document_status_createdAt_idx").using("btree", table.status.asc().nullsLast(), table.createdAt.asc().nullsLast()),
	index("Document_ingestionLease_idx").using("btree", table.status.asc().nullsLast(), table.ingestionLeaseExpiresAt.asc().nullsLast()),
]);

export const installationCredential = pgTable("InstallationCredential", {
	id: varchar({ length: 32 }).default('initial').primaryKey().notNull(),
	keyHash: bytea("keyHash").notNull(),
	activatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	lastSessionId: uuid(),
	lastSourceIp: inet(),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
}, (table) => [
	index("InstallationCredential_activatedAt_idx").using("btree", table.activatedAt.asc().nullsLast()),
	uniqueIndex("InstallationCredential_keyHash_key").using("btree", table.keyHash.asc().nullsLast()),
]);

/**
 * The control plane's own signing identity, used to sign what it tells a
 * runtime node to be.
 *
 * Runtime nodes already sign what they report upward; this is the other
 * direction, and it has to be signed rather than merely authenticated because
 * a node acts on the document — anything that can answer the node's request
 * could otherwise reconfigure it. Singleton, generated on first use, private
 * half sealed with the same envelope scheme as connection secrets.
 */
export const controlPlaneSigningKey = pgTable("ControlPlaneSigningKey", {
	id: varchar({ length: 32 }).default('primary').primaryKey().notNull(),
	publicKeyPem: text().notNull(),
	publicKeyFingerprint: varchar({ length: 100 }).notNull(),
	encryptedValue: bytea("encryptedValue").notNull(),
	valueNonce: bytea("valueNonce").notNull(),
	valueAuthTag: bytea("valueAuthTag").notNull(),
	wrappedDataKey: bytea("wrappedDataKey").notNull(),
	keyNonce: bytea("keyNonce").notNull(),
	keyAuthTag: bytea("keyAuthTag").notNull(),
	encryptionVersion: integer().default(1).notNull(),
	masterKeyVersion: integer().default(1).notNull(),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()),
	updatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
});

export const agentRunEvent = pgTable("AgentRunEvent", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	runId: uuid().notNull(),
	sourceEventId: varchar({ length: 255 }),
	type: varchar({ length: 80 }).notNull(),
	summary: varchar({ length: 1000 }),
	status: varchar({ length: 80 }),
	toolName: varchar({ length: 160 }),
	childSessionId: varchar({ length: 255 }),
	durationMs: integer(),
	inputTokens: integer(),
	outputTokens: integer(),
	costUsd: numeric({ precision: 18, scale:  8 }),
	occurredAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	cursor: bigserial({ mode: "bigint" }).notNull(),
	delta: text(),
	preview: varchar({ length: 1000 }),
	errorCode: varchar({ length: 80 }),
	approvalId: uuid(),
	reasoningTokens: integer(),
}, (table) => [
	uniqueIndex("AgentRunEvent_cursor_key").using("btree", table.cursor.asc().nullsLast()),
	index("AgentRunEvent_runId_cursor_idx").using("btree", table.runId.asc().nullsLast(), table.cursor.asc().nullsLast()),
	index("AgentRunEvent_runId_occurredAt_id_idx").using("btree", table.runId.asc().nullsLast(), table.occurredAt.asc().nullsLast(), table.id.asc().nullsLast()),
	uniqueIndex("AgentRunEvent_runId_sourceEventId_key").using("btree", table.runId.asc().nullsLast(), table.sourceEventId.asc().nullsLast()),
	foreignKey({
			columns: [table.runId],
			foreignColumns: [agentRun.id],
			name: "AgentRunEvent_runId_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const credentialRecoveryControl = pgTable("CredentialRecoveryControl", {
	id: varchar({ length: 32 }).default('global').primaryKey().notNull(),
	keyFingerprint: varchar({ length: 64 }),
	kitChecksum: varchar({ length: 64 }),
	recoveryOwner: varchar({ length: 160 }),
	exportedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	exportedBy: uuid(),
	verifiedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	verifiedBy: uuid(),
	revision: integer().default(0).notNull(),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
});

export const onboardingEvidence = pgTable("OnboardingEvidence", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	stageKey: varchar({ length: 80 }).notNull(),
	componentKey: varchar({ length: 80 }),
	source: onboardingEvidenceSource().notNull(),
	outcome: onboardingEvidenceOutcome().notNull(),
	code: varchar({ length: 120 }).notNull(),
	summary: varchar({ length: 1000 }).notNull(),
	observedVersion: varchar({ length: 240 }),
	details: jsonb().default({}).notNull(),
	createdBy: uuid(),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	expiresAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
}, (table) => [
	index("OnboardingEvidence_componentKey_createdAt_idx").using("btree", table.componentKey.asc().nullsLast(), table.createdAt.asc().nullsLast()),
	index("OnboardingEvidence_source_outcome_createdAt_idx").using("btree", table.source.asc().nullsLast(), table.outcome.asc().nullsLast(), table.createdAt.asc().nullsLast()),
	index("OnboardingEvidence_stageKey_createdAt_idx").using("btree", table.stageKey.asc().nullsLast(), table.createdAt.asc().nullsLast()),
]);

export const platformArchitectureDecision = pgTable("PlatformArchitectureDecision", {
	id: varchar({ length: 32 }).default('global').primaryKey().notNull(),
	reason: varchar({ length: 1000 }),
	revision: integer().default(0).notNull(),
	updatedBy: uuid(),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
	topologyMode: deploymentTopologyMode().default('CONTROL_PLANE').notNull(),
	targetEnvironment: onboardingTargetEnvironment().default('DEVELOPMENT').notNull(),
});

export const hermesRuntimeNode = pgTable("HermesRuntimeNode", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	slug: varchar({ length: 64 }).notNull(),
	displayName: varchar({ length: 120 }).notNull(),
	baseUrl: text().notNull(),
	expectedHostname: varchar({ length: 253 }),
	hostname: varchar({ length: 253 }),
	status: hermesRuntimeNodeStatus().default('PENDING').notNull(),
	identityPublicKeyPem: text(),
	identityFingerprint: varchar({ length: 64 }),
	hermesVersion: varchar({ length: 256 }),
	installerVersion: varchar({ length: 256 }),
	capabilities: jsonb().default([]).notNull(),
	serviceConnectionId: uuid(),
	lastSeenAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	enrolledAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	revokedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	revision: integer().default(0).notNull(),
	createdBy: uuid(),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
}, (table) => [
	index("HermesRuntimeNode_createdAt_idx").using("btree", table.createdAt.asc().nullsLast()),
	uniqueIndex("HermesRuntimeNode_identityFingerprint_key").using("btree", table.identityFingerprint.asc().nullsLast()),
	uniqueIndex("HermesRuntimeNode_serviceConnectionId_key").using("btree", table.serviceConnectionId.asc().nullsLast()),
	uniqueIndex("HermesRuntimeNode_slug_key").using("btree", table.slug.asc().nullsLast()),
	index("HermesRuntimeNode_status_lastSeenAt_idx").using("btree", table.status.asc().nullsLast(), table.lastSeenAt.asc().nullsLast()),
	foreignKey({
			columns: [table.serviceConnectionId],
			foreignColumns: [serviceConnection.id],
			name: "HermesRuntimeNode_serviceConnectionId_fkey"
		}).onUpdate("cascade").onDelete("set null"),
]);

export const hermesNodeRequestNonce = pgTable("HermesNodeRequestNonce", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	nodeId: uuid().notNull(),
	nonce: uuid().notNull(),
	receivedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	uniqueIndex("HermesNodeRequestNonce_nodeId_nonce_key").using("btree", table.nodeId.asc().nullsLast(), table.nonce.asc().nullsLast()),
	index("HermesNodeRequestNonce_receivedAt_idx").using("btree", table.receivedAt.asc().nullsLast()),
	foreignKey({
			columns: [table.nodeId],
			foreignColumns: [hermesRuntimeNode.id],
			name: "HermesNodeRequestNonce_nodeId_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const hermesNodeEnrollment = pgTable("HermesNodeEnrollment", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	nodeId: uuid().notNull(),
	tokenHash: bytea("tokenHash").notNull(),
	status: hermesNodeEnrollmentStatus().default('ISSUED').notNull(),
	expiresAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull(),
	consumedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	revokedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	consumedSourceIp: inet(),
	createdBy: uuid(),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
	controlPlaneUrl: text(),
	hermesImage: text(),
}, (table) => [
	index("HermesNodeEnrollment_nodeId_status_idx").using("btree", table.nodeId.asc().nullsLast(), table.status.asc().nullsLast()),
	index("HermesNodeEnrollment_status_expiresAt_idx").using("btree", table.status.asc().nullsLast(), table.expiresAt.asc().nullsLast()),
	uniqueIndex("HermesNodeEnrollment_tokenHash_key").using("btree", table.tokenHash.asc().nullsLast()),
	foreignKey({
			columns: [table.nodeId],
			foreignColumns: [hermesRuntimeNode.id],
			name: "HermesNodeEnrollment_nodeId_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const guardrailPolicy = pgTable("GuardrailPolicy", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	slug: varchar({ length: 64 }).notNull(),
	displayName: varchar({ length: 120 }).notNull(),
	description: varchar({ length: 500 }).notNull(),
	version: varchar({ length: 120 }).notNull(),
	status: guardrailPolicyStatus().default('DRAFT').notNull(),
	maxInputCharacters: integer().notNull(),
	activationEvaluationId: uuid(),
	firstActivatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	revision: integer().default(1).notNull(),
	createdBy: uuid(),
	updatedBy: uuid(),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
	maxOutputCharacters: integer().default(200000).notNull(),
	blockControlCharacters: boolean().default(true).notNull(),
	blockCredentialPatterns: boolean().default(true).notNull(),
}, (table) => [
	index("GuardrailPolicy_activationEvaluationId_idx").using("btree", table.activationEvaluationId.asc().nullsLast()),
	uniqueIndex("GuardrailPolicy_single_active_key").using("btree", sql`(true)`).where(sql`(status = 'ACTIVE'::"GuardrailPolicyStatus")`),
	uniqueIndex("GuardrailPolicy_slug_key").using("btree", table.slug.asc().nullsLast()),
	index("GuardrailPolicy_status_updatedAt_idx").using("btree", table.status.asc().nullsLast(), table.updatedAt.asc().nullsLast()),
	foreignKey({
			columns: [table.activationEvaluationId],
			foreignColumns: [evaluationRun.id],
			name: "GuardrailPolicy_activationEvaluationId_fkey"
		}).onUpdate("cascade").onDelete("set null"),
	check("GuardrailPolicy_activation_evidence_check", sql`(status <> 'ACTIVE'::"GuardrailPolicyStatus") OR (("activationEvaluationId" IS NOT NULL) AND ("firstActivatedAt" IS NOT NULL))`),
]);

export const administratorSession = pgTable("AdministratorSession", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	tokenHash: bytea("tokenHash").notNull(),
	subject: varchar({ length: 160 }).notNull(),
	role: administratorRole().notNull(),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	lastSeenAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull(),
	idleExpiresAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull(),
	absoluteExpiresAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull(),
	revokedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	sourceIp: inet(),
	userAgentHash: varchar({ length: 64 }),
	authenticationMethod: administratorAuthenticationMethod().default('LOCAL_PASSWORD').notNull(),
	passwordChangeRequired: boolean().default(false).notNull(),
}, (table) => [
	index("AdministratorSession_absoluteExpiresAt_idx").using("btree", table.absoluteExpiresAt.asc().nullsLast()),
	index("AdministratorSession_revokedAt_idleExpiresAt_idx").using("btree", table.revokedAt.asc().nullsLast(), table.idleExpiresAt.asc().nullsLast()),
	index("AdministratorSession_subject_createdAt_idx").using("btree", table.subject.asc().nullsLast(), table.createdAt.asc().nullsLast()),
	uniqueIndex("AdministratorSession_tokenHash_key").using("btree", table.tokenHash.asc().nullsLast()),
]);

export const localAdministrator = pgTable("LocalAdministrator", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	username: varchar({ length: 64 }).notNull(),
	displayName: varchar({ length: 120 }).notNull(),
	passwordHash: text().notNull(),
	role: administratorRole().default('PLATFORM_ADMIN').notNull(),
	passwordChangeRequired: boolean().default(true).notNull(),
	failedLoginCount: integer().default(0).notNull(),
	lockedUntil: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	lastLoginAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	passwordChangedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	disabledAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
}, (table) => [
	index("LocalAdministrator_disabledAt_lockedUntil_idx").using("btree", table.disabledAt.asc().nullsLast(), table.lockedUntil.asc().nullsLast()),
	uniqueIndex("LocalAdministrator_username_key").using("btree", table.username.asc().nullsLast()),
]);

export const agentRun = pgTable("AgentRun", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	// NULL means retrieval spans everything the owner holds; a non-null array
	// restricts it to exactly these documents.
	knowledgeDocumentIds: uuid().array(),
	profileId: uuid().notNull(),
	profileVersionId: uuid().notNull(),
	profileVersion: integer().notNull(),
	ownerSubject: varchar({ length: 200 }).notNull(),
	requestedBy: uuid().notNull(),
	status: agentRunStatus().default('QUEUED').notNull(),
	input: text().notNull(),
	output: text(),
	effectiveCapabilities: jsonb().default([]).notNull(),
	sources: jsonb().default([]).notNull(),
	externalRunId: varchar({ length: 255 }),
	jobId: uuid(),
	failureCode: varchar({ length: 80 }),
	failureMessage: varchar({ length: 500 }),
	queuedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	startedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	completedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
	toolCapabilityTokenHash: bytea("toolCapabilityTokenHash"),
	toolCapabilityExpiresAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	profileDistributionDigest: varchar({ length: 64 }),
	sessionId: varchar({ length: 200 }).notNull(),
	processorLeaseOwner: varchar({ length: 160 }),
	processorLeaseExpiresAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	memorySessionKey: varchar({ length: 200 }).notNull(),
	conversationHistory: jsonb().default([]).notNull(),
	partialOutput: text().default("").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	lastEventCursor: bigint({ mode: "number" }),
	outputCharacterLimit: integer().default(200000).notNull(),
	modelAlias: varchar({ length: 200 }),
	inputTokens: integer(),
	outputTokens: integer(),
	reasoningTokens: integer(),
	totalTokens: integer(),
	finishReason: varchar({ length: 120 }),
	firstTokenAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
}, (table) => [
	index("AgentRun_ownerSubject_createdAt_idx").using("btree", table.ownerSubject.asc().nullsLast(), table.createdAt.asc().nullsLast()),
	index("AgentRun_profileId_status_createdAt_idx").using("btree", table.profileId.asc().nullsLast(), table.status.asc().nullsLast(), table.createdAt.asc().nullsLast()),
	index("AgentRun_status_processorLeaseExpiresAt_idx").using("btree", table.status.asc().nullsLast(), table.processorLeaseExpiresAt.asc().nullsLast()),
	index("AgentRun_status_queuedAt_idx").using("btree", table.status.asc().nullsLast(), table.queuedAt.asc().nullsLast()),
	foreignKey({
			columns: [table.profileId],
			foreignColumns: [agentProfile.id],
			name: "AgentRun_profileId_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
	foreignKey({
			columns: [table.profileVersionId],
			foreignColumns: [agentProfileVersion.id],
			name: "AgentRun_profileVersionId_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
	check("AgentRun_toolCapability_pair_check", sql`(("toolCapabilityTokenHash" IS NULL) AND ("toolCapabilityExpiresAt" IS NULL)) OR ((octet_length("toolCapabilityTokenHash") = 32) AND ("toolCapabilityExpiresAt" IS NOT NULL))`),
]);

export const agentRunApproval = pgTable("AgentRunApproval", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	runId: uuid().notNull(),
	externalApprovalId: varchar({ length: 255 }),
	status: agentRunApprovalStatus().default('PENDING').notNull(),
	command: varchar({ length: 1000 }),
	summary: varchar({ length: 1000 }),
	choices: jsonb().default([]).notNull(),
	requestedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	expiresAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull(),
	decidedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	decidedBy: uuid(),
	decision: varchar({ length: 40 }),
	forwardedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
}, (table) => [
	index("AgentRunApproval_runId_status_requestedAt_idx").using("btree", table.runId.asc().nullsLast(), table.status.asc().nullsLast(), table.requestedAt.asc().nullsLast()),
	index("AgentRunApproval_status_expiresAt_idx").using("btree", table.status.asc().nullsLast(), table.expiresAt.asc().nullsLast()),
	foreignKey({
			columns: [table.runId],
			foreignColumns: [agentRun.id],
			name: "AgentRunApproval_runId_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const documentChunk = pgTable("DocumentChunk", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	documentId: uuid().notNull(),
	ownerSubject: varchar({ length: 200 }).notNull(),
	ordinal: integer().notNull(),
	content: text().notNull(),
	characterCount: integer().notNull(),
	embeddingModel: varchar({ length: 120 }).notNull(),
	embedding: vector({ dimensions: 1024 }).notNull(),
	contentSearch: text(),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	index("DocumentChunk_content_fts_idx").using("gin", sql`to_tsvector('simple'::regconfig, content)`),
	uniqueIndex("DocumentChunk_documentId_ordinal_key").using("btree", table.documentId.asc().nullsLast(), table.ordinal.asc().nullsLast()),
	index("DocumentChunk_embedding_idx").using("hnsw", table.embedding.asc().nullsLast().op("vector_cosine_ops")),
	index("DocumentChunk_ownerSubject_idx").using("btree", table.ownerSubject.asc().nullsLast()),
	foreignKey({
			columns: [table.documentId],
			foreignColumns: [document.id],
			name: "DocumentChunk_documentId_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

/**
 * A bounded counter for the Hermes inference gateway's per-minute limit.
 *
 * The limit was previously counted from AuditEvent, which has no retention, so
 * a hot path scanned a permanently growing table. Rows here are pruned to the
 * current window on every request, keeping the table proportional to the limit
 * rather than to lifetime traffic. The audit trail is still written separately
 * and remains complete.
 */
export const inferenceGatewayRequest = pgTable("InferenceGatewayRequest", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	connectionId: uuid().notNull(),
	occurredAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	index("InferenceGatewayRequest_connectionId_occurredAt_idx").using("btree", table.connectionId.asc().nullsLast(), table.occurredAt.asc().nullsLast()),
	foreignKey({
			columns: [table.connectionId],
			foreignColumns: [serviceConnection.id],
			name: "InferenceGatewayRequest_connectionId_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

/**
 * Documents pinned to a conversation.
 *
 * Retrieval defaults to everything the owner holds, which is right for an
 * open-ended question and wrong when the operator already knows which sources
 * matter. Pinning narrows a conversation's runs to exactly these documents.
 */
export const chatConversationDocument = pgTable("ChatConversationDocument", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	conversationId: uuid().notNull(),
	documentId: uuid().notNull(),
	ownerSubject: varchar({ length: 200 }).notNull(),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	uniqueIndex("ChatConversationDocument_conversationId_documentId_key").using("btree", table.conversationId.asc().nullsLast(), table.documentId.asc().nullsLast()),
	index("ChatConversationDocument_documentId_idx").using("btree", table.documentId.asc().nullsLast()),
	foreignKey({
			columns: [table.conversationId],
			foreignColumns: [chatConversation.id],
			name: "ChatConversationDocument_conversationId_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
			columns: [table.documentId],
			foreignColumns: [document.id],
			name: "ChatConversationDocument_documentId_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

/**
 * How far the audit trail has been forwarded to a SIEM.
 *
 * The trail is append-only and ordered by (occurredAt, id), so a keyset cursor
 * is enough to resume: everything at or before the cursor has been delivered.
 * Failures leave the cursor untouched, so a batch is retried rather than lost.
 */
export const auditForwardingState = pgTable("AuditForwardingState", {
	id: varchar({ length: 32 }).default('global').primaryKey().notNull(),
	lastForwardedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	lastForwardedId: uuid(),
	lastAttemptAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	lastError: varchar({ length: 500 }),
	deliveredCount: integer().default(0).notNull(),
	updatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
});

/**
 * What an agent has learned about the person it serves.
 *
 * This is the plane that replaced the external memory service on VM2. Keeping
 * it here rather than beside the runtime means a runtime host can be destroyed
 * and re-enrolled without losing what an agent knows, the same backup covers
 * it as the rest of the control plane, and an administrator can read and
 * delete it - none of which was true of a store that lived on the agent VM.
 *
 * Scope is (ownerSubject, agentProfileId): an agent recalls only what it
 * learned, about the identity that is asking. Both halves are predicates
 * inside the retrieval query, so nothing a caller supplies can widen them.
 */
export const agentMemory = pgTable("AgentMemory", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	ownerSubject: varchar({ length: 200 }).notNull(),
	agentProfileId: uuid().notNull(),
	content: text().notNull(),
	characterCount: integer().notNull(),
	embeddingModel: varchar({ length: 120 }).notNull(),
	embedding: vector({ dimensions: 1024 }).notNull(),
	profileScope: memoryProfileScope().default('EPISODIC').notNull(),
	// A fact is never edited or deleted when it changes; a new row supersedes it
	// and the old one stays as history. `isLatest` is what recall filters on, so
	// the current answer is one indexed predicate rather than a chain walk.
	version: integer().default(1).notNull(),
	parentMemoryId: uuid(),
	rootMemoryId: uuid(),
	isLatest: boolean().default(true).notNull(),
	supersededAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	supersededReason: varchar({ length: 300 }),
	sourceRunId: uuid(),
	sourceConversationId: uuid(),
	// Bulk forgetting is a soft delete: a person asking for a topic to be
	// forgotten is answered by the fact ceasing to be recalled, and the trail of
	// what was forgotten, by whom and why has to outlive the rows themselves.
	// The batch id ties one operator decision to every row it touched.
	forgottenAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	forgetReason: varchar({ length: 300 }),
	forgetBatchId: uuid(),
	retentionUntil: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	index("AgentMemory_content_fts_idx").using("gin", sql`to_tsvector('simple'::regconfig, content)`),
	index("AgentMemory_forgetBatchId_idx").using("btree", table.forgetBatchId.asc().nullsLast()),
	index("AgentMemory_embedding_idx").using("hnsw", table.embedding.asc().nullsLast().op("vector_cosine_ops")),
	index("AgentMemory_owner_profile_idx").using("btree", table.ownerSubject.asc().nullsLast(), table.agentProfileId.asc().nullsLast()),
	index("AgentMemory_latest_idx").using("btree", table.ownerSubject.asc().nullsLast(), table.agentProfileId.asc().nullsLast()).where(sql`"isLatest" AND "forgottenAt" IS NULL`),
	index("AgentMemory_profile_idx").using("btree", table.ownerSubject.asc().nullsLast(), table.agentProfileId.asc().nullsLast(), table.profileScope.asc().nullsLast()),
	index("AgentMemory_retentionUntil_idx").using("btree", table.retentionUntil.asc().nullsLast()),
	foreignKey({
			columns: [table.agentProfileId],
			foreignColumns: [agentProfile.id],
			name: "AgentMemory_agentProfileId_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	check("AgentMemory_content_check", sql`(char_length(btrim(content)) >= 3) AND ("characterCount" > 0)`),
]);

/**
 * The installation-wide ceiling on agent memory.
 *
 * A profile picks its own mode; this bounds every profile at once. Exactly one
 * policy may be ACTIVE, enforced by a partial unique index rather than by
 * application code, so two administrators cannot race two ceilings into effect.
 */
export const memoryPolicy = pgTable("MemoryPolicy", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	slug: varchar({ length: 64 }).notNull(),
	displayName: varchar({ length: 120 }).notNull(),
	description: varchar({ length: 500 }).notNull(),
	status: memoryPolicyStatus().default('DRAFT').notNull(),
	maximumCaptureMode: agentMemoryMode().default('LEARN_EXCHANGE').notNull(),
	retentionDays: integer(),
	maximumItemsPerOwner: integer().default(500).notNull(),
	recallLimit: integer().default(6).notNull(),
	recallMinimumScore: doublePrecision().default(0.4).notNull(),
	knowledgeRecallLimit: integer().default(18).notNull(),
	knowledgeMinimumScore: doublePrecision().default(0.35).notNull(),
	distillCapture: boolean().default(true).notNull(),
	revision: integer().default(1).notNull(),
	firstActivatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	createdBy: uuid(),
	updatedBy: uuid(),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
}, (table) => [
	uniqueIndex("MemoryPolicy_slug_key").using("btree", table.slug.asc().nullsLast()),
	uniqueIndex("MemoryPolicy_single_active_key").on(sql`(true)`).where(sql`status = 'ACTIVE'`),
	check("MemoryPolicy_bounds_check", sql`("maximumItemsPerOwner" >= 10) AND ("recallLimit" >= 1) AND ("recallMinimumScore" >= 0) AND ("recallMinimumScore" <= 1) AND ("knowledgeRecallLimit" >= 1) AND ("knowledgeMinimumScore" >= 0) AND ("knowledgeMinimumScore" <= 1) AND ("retentionDays" IS NULL OR "retentionDays" >= 1) AND (revision > 0)`),
	check("MemoryPolicy_activation_check", sql`(status <> 'ACTIVE') OR ("firstActivatedAt" IS NOT NULL)`),
]);
