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
 *   - every updatedAt column is stamped client-side, because these were client
 *     defaults in the ORM that came before - without the stamping, inserts fail
 *     NOT NULL;
 *   - AgentToolGrant.allowedAdminRoles is an enum array that introspection once
 *     rendered as bytea[], a type no role value can be written to.
 *
 * migrations.test.ts asserts on the emitted SQL and guards these decisions.
 */

import { pgTable, index, uniqueIndex, uuid, varchar, text, boolean, timestamp, foreignKey, inet, jsonb, integer, check, bigint, numeric, bigserial, pgEnum } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"
import { bytea } from "./bytea.js"

export const administratorAuthenticationMethod = pgEnum("AdministratorAuthenticationMethod", ['LOCAL_PASSWORD', 'INSTALLATION_KEY_RECOVERY', 'OIDC'])
export const administratorRole = pgEnum("AdministratorRole", ['PLATFORM_ADMIN', 'SECURITY_ADMIN', 'OPERATIONS_ADMIN', 'AUDITOR'])
export const agentProfileStatus = pgEnum("AgentProfileStatus", ['DRAFT', 'ACTIVE', 'SUSPENDED', 'STANDBY'])
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
export const guardrailPolicyStatus = pgEnum("GuardrailPolicyStatus", ['DRAFT', 'ACTIVE', 'SUSPENDED'])
export const hermesNodeEnrollmentStatus = pgEnum("HermesNodeEnrollmentStatus", ['ISSUED', 'CONSUMED', 'REVOKED', 'EXPIRED'])
export const hermesRuntimeNodeStatus = pgEnum("HermesRuntimeNodeStatus", ['PENDING', 'ONLINE', 'DEGRADED', 'DRAINING', 'SUSPENDED', 'REVOKED', 'OFFLINE'])
export const hermesCorpusEntryKind = pgEnum("HermesCorpusEntryKind", ['MEMORY', 'SKILL', 'SKILL_FILE', 'SKILL_BUNDLE', 'PROVENANCE', 'PENDING_CHANGE'])
export const hermesCorpusMutationOperation = pgEnum("HermesCorpusMutationOperation", ['MEMORY_ADD', 'MEMORY_REPLACE', 'MEMORY_REMOVE', 'SKILL_CREATE', 'SKILL_EDIT', 'SKILL_DELETE', 'SKILL_WRITE_FILE', 'SKILL_REMOVE_FILE'])
export const hermesCorpusMutationStatus = pgEnum("HermesCorpusMutationStatus", ['PENDING_APPROVAL', 'QUEUED', 'DISPATCHED', 'APPLIED', 'REJECTED', 'CONFLICT', 'FAILED', 'EXPIRED'])
export const configurationSetStatus = pgEnum("ConfigurationSetStatus", ['ACTIVE', 'RETIRED'])
export const divisionStatus = pgEnum("DivisionStatus", ['ACTIVE', 'SUSPENDED'])
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

/** Identifies the intentionally incompatible greenfield schema generation. */
export const schemaMetadata = pgTable("SchemaMetadata", {
	id: varchar({ length: 32 }).default('current').primaryKey().notNull(),
	epoch: varchar({ length: 64 }).notNull(),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const enterpriseUser = pgTable("EnterpriseUser", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	issuer: varchar({ length: 512 }).notNull(),
	subject: varchar({ length: 255 }).notNull(),
	email: varchar({ length: 320 }),
	displayName: varchar({ length: 200 }).notNull(),
	groups: text().array(),
	enabled: boolean().default(true).notNull(),
	/*
	 * Null means created but never signed in.
	 *
	 * NOT NULL until v7.1.0, which is what made an administrator unable to
	 * pre-create a person: the row could only come into existence by somebody
	 * arriving through an identity provider. Divisions bound users, so a
	 * deployment with no IdP had a boundary and nobody to apply it to.
	 */
	lastLoginAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
	/* Null means the user sees only deployment-wide profiles. */
	divisionId: uuid(),
}, (table) => [
	index("EnterpriseUser_email_idx").using("btree", table.email.asc().nullsLast()),
	index("EnterpriseUser_enabled_lastLoginAt_idx").using("btree", table.enabled.asc().nullsLast(), table.lastLoginAt.asc().nullsLast()),
	uniqueIndex("EnterpriseUser_issuer_subject_key").using("btree", table.issuer.asc().nullsLast(), table.subject.asc().nullsLast()),
	foreignKey({
			columns: [table.divisionId],
			foreignColumns: [division.id],
			name: "EnterpriseUser_divisionId_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
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
	/**
	 * Delivery position for SIEM forwarding.
	 *
	 * occurredAt is transaction_timestamp(), so it orders events by when their
	 * transaction began rather than by when they became readable, and a cursor
	 * over it skips an event whose transaction commits late. This orders them
	 * the way AgentRunEvent.cursor orders run events.
	 */
	cursor: bigserial({ mode: "bigint" }).notNull(),
}, (table) => [
	index("AuditEvent_actorId_occurredAt_idx").using("btree", table.actorId.asc().nullsLast(), table.occurredAt.asc().nullsLast()),
	index("AuditEvent_correlationId_idx").using("btree", table.correlationId.asc().nullsLast()),
	uniqueIndex("AuditEvent_cursor_key").using("btree", table.cursor.asc().nullsLast()),
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

/**
 * A tenant boundary over rows, not a scope over actions.
 *
 * Deliberately ordinary data: a super admin creates these at runtime with any
 * name, and nothing in the code enumerates them. That is a consequence of
 * division not being a scope -- had it been modelled as one, every new division
 * would mean editing ADMIN_SCOPES, a release, and an upgrade of every
 * deployment.
 *
 * Divisions bound *users*, never administrators. There is deliberately no
 * column on LocalAdministrator: an administrator is deployment-wide, which is
 * what makes every administration screen safe by construction -- including
 * Memory and Skills, which are shared per node and therefore cannot be filtered
 * for a division-scoped admin even in principle.
 */
export const division = pgTable("Division", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	slug: varchar({ length: 64 }).notNull(),
	displayName: varchar({ length: 120 }).notNull(),
	description: varchar({ length: 500 }).default('').notNull(),
	status: divisionStatus().default('ACTIVE').notNull(),
	revision: integer().default(1).notNull(),
	createdBy: uuid(),
	updatedBy: uuid(),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
}, (table) => [
	uniqueIndex("Division_slug_key").using("btree", table.slug.asc().nullsLast()),
	index("Division_status_displayName_idx").using("btree", table.status.asc().nullsLast(), table.displayName.asc().nullsLast()),
]);

export const agentProfile = pgTable("AgentProfile", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	slug: varchar({ length: 64 }).notNull(),
	status: agentProfileStatus().default('DRAFT').notNull(),
	currentVersion: integer().default(1).notNull(),
	activeVersion: integer(),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
	/*
	 * Null means deployment-wide, which is what every existing row already is.
	 * So the migration re-homes nothing: a profile stays visible to everyone
	 * until a super admin deliberately assigns it.
	 */
	divisionId: uuid(),
}, (table) => [
	uniqueIndex("AgentProfile_slug_key").using("btree", table.slug.asc().nullsLast()),
	index("AgentProfile_status_updatedAt_idx").using("btree", table.status.asc().nullsLast(), table.updatedAt.asc().nullsLast()),
	index("AgentProfile_divisionId_idx").using("btree", table.divisionId.asc().nullsLast()),
	foreignKey({
			columns: [table.divisionId],
			foreignColumns: [division.id],
			name: "AgentProfile_divisionId_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
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
/**
 * A named, reusable selection of Hermes toolsets.
 *
 * Distinct from `RuntimeToolsetAdmission`, which is the deployment-wide
 * allowlist of what any node may enable. This names a subset of that for reuse
 * across profiles, and it is *declarative*: see DIVISIONS_PLAN increment C for
 * why a narrower set cannot bind a run, and why the seeded default must
 * therefore track admission rather than narrow it.
 *
 * `tracksAdmission` is that default's marker. A set with it resolves to whatever
 * is admitted deployment-wide when read, rather than freezing a snapshot -- at
 * install nothing is admitted yet, so a snapshot would seed an "everything" set
 * containing nothing.
 */
export const toolSet = pgTable("ToolSet", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	slug: varchar({ length: 64 }).notNull(),
	displayName: varchar({ length: 120 }).notNull(),
	description: varchar({ length: 500 }).default('').notNull(),
	status: configurationSetStatus().default('ACTIVE').notNull(),
	toolsetNames: text().array().default([]).notNull(),
	tracksAdmission: boolean().default(false).notNull(),
	revision: integer().default(1).notNull(),
	createdBy: uuid(),
	updatedBy: uuid(),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
}, (table) => [
	uniqueIndex("ToolSet_slug_key").using("btree", table.slug.asc().nullsLast()),
	index("ToolSet_status_updatedAt_idx").using("btree", table.status.asc().nullsLast(), table.updatedAt.asc().nullsLast()),
]);

/**
 * A named, reusable selection of Skills, mirroring `ToolSet`.
 *
 * `tracksRuntime` is the same idea as `tracksAdmission`: the seeded default
 * means "every Skill this node reports" rather than a list captured before any
 * node existed.
 */
export const skillSet = pgTable("SkillSet", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	slug: varchar({ length: 64 }).notNull(),
	displayName: varchar({ length: 120 }).notNull(),
	description: varchar({ length: 500 }).default('').notNull(),
	status: configurationSetStatus().default('ACTIVE').notNull(),
	skills: jsonb().default([]).notNull(),
	tracksRuntime: boolean().default(false).notNull(),
	revision: integer().default(1).notNull(),
	createdBy: uuid(),
	updatedBy: uuid(),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
}, (table) => [
	uniqueIndex("SkillSet_slug_key").using("btree", table.slug.asc().nullsLast()),
	index("SkillSet_status_updatedAt_idx").using("btree", table.status.asc().nullsLast(), table.updatedAt.asc().nullsLast()),
]);

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
	safeMode: boolean().default(true).notNull(),
	createdBy: uuid(),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	soulMd: text().default("").notNull(),
	skills: jsonb().default([]).notNull(),
	distributionDigest: varchar({ length: 64 }),
	/*
	 * The version's sets, on the *version* rather than the profile: a version is
	 * immutable, and a run must reproduce exactly the configuration it was given.
	 *
	 * Nullable in the database and required by the API, which is not a hedge.
	 * A NOT NULL foreign key cannot be added ahead of the rows that would satisfy
	 * it -- drizzle's migration SQL runs before any seeding code, so every
	 * existing version would fail the constraint at upgrade. The seeder creates
	 * the default sets and backfills these columns immediately afterwards; the
	 * contract refuses a create without both, so only pre-existing rows are ever
	 * null and only until the same upgrade finishes.
	 */
	toolSetId: uuid(),
	skillSetId: uuid(),
}, (table) => [
	index("AgentProfileVersion_profileId_createdAt_idx").using("btree", table.profileId.asc().nullsLast(), table.createdAt.asc().nullsLast()),
	uniqueIndex("AgentProfileVersion_profileId_version_key").using("btree", table.profileId.asc().nullsLast(), table.version.asc().nullsLast()),
	foreignKey({
			columns: [table.profileId],
			foreignColumns: [agentProfile.id],
			name: "AgentProfileVersion_profileId_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
	/*
	 * RESTRICT, not CASCADE: deleting a set that a shipped version depends on
	 * would silently rewrite what that version was. The manager refuses the
	 * delete with a 409 naming the profile; this is the backstop if it ever
	 * does not.
	 */
	foreignKey({
			columns: [table.toolSetId],
			foreignColumns: [toolSet.id],
			name: "AgentProfileVersion_toolSetId_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
	foreignKey({
			columns: [table.skillSetId],
			foreignColumns: [skillSet.id],
			name: "AgentProfileVersion_skillSetId_fkey"
		}).onUpdate("cascade").onDelete("restrict"),
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
}, (table) => [
	index("ChatConversation_lastMessageAt_idx").using("btree", table.lastMessageAt.asc().nullsLast()),
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
	firstActivatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	revision: integer().default(1).notNull(),
	createdBy: uuid(),
	updatedBy: uuid(),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
}, (table) => [
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
	check("ModelDeployment_limits_check", sql`(("contextWindowTokens" >= 1024) AND ("contextWindowTokens" <= 4194304)) AND (("maxOutputTokens" >= 64) AND ("maxOutputTokens" <= 131072)) AND ("maxOutputTokens" <= "contextWindowTokens") AND (("maxConcurrentRequests" >= 1) AND ("maxConcurrentRequests" <= 1024)) AND (revision > 0)`),
	check("ModelDeployment_activation_check", sql`(status <> 'ACTIVE'::"ModelDeploymentStatus") OR ("firstActivatedAt" IS NOT NULL)`),
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
	firstActivatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	revision: integer().default(1).notNull(),
	createdBy: uuid(),
	updatedBy: uuid(),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
}, (table) => [
	index("PromptTemplate_purpose_status_idx").using("btree", table.purpose.asc().nullsLast(), table.status.asc().nullsLast()),
	uniqueIndex("PromptTemplate_single_active_purpose_key").using("btree", table.purpose.asc().nullsLast()).where(sql`(status = 'ACTIVE'::"PromptTemplateStatus")`),
	uniqueIndex("PromptTemplate_slug_key").using("btree", table.slug.asc().nullsLast()),
	check("PromptTemplate_content_check", sql`((char_length(btrim(content)) >= 20) AND (char_length(btrim(content)) <= 20000)) AND (("contentChecksum")::text ~ '^[a-f0-9]{64}$'::text) AND (revision > 0)`),
	check("PromptTemplate_activation_check", sql`(status <> 'ACTIVE'::"PromptTemplateStatus") OR ("firstActivatedAt" IS NOT NULL)`),
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
	// Correlates the start, progress and terminal events of one tool call.
	// Hermes does not issue a call identifier of its own on most surfaces, so
	// this is the runtime's id where one is offered and a synthesised key where
	// none is -- see recordSafeEvent in the worker for how the difference is kept
	// visible rather than papered over.
	toolCallKey: varchar({ length: 200 }),
	// The event's own prose, where it is longer than a summary line: reasoning
	// text, a tool's returned output. `summary` stays the one-line label.
	text: text(),
	// How much of the answer had been streamed when this event occurred, so a
	// timeline can place tool work between the words it interrupted instead of
	// stacking every event after the finished answer.
	contentOffset: integer(),
}, (table) => [
	uniqueIndex("AgentRunEvent_cursor_key").using("btree", table.cursor.asc().nullsLast()),
	index("AgentRunEvent_runId_toolCallKey_idx").using("btree", table.runId.asc().nullsLast(), table.toolCallKey.asc().nullsLast()),
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

/**
 * The release an operator has approved this deployment to move to.
 *
 * Intent only. Nothing in the container acts on this row - the dashboard runs
 * without host-root or Docker control and that boundary is deliberate. Root
 * agents on VM1 and VM2 read the target and apply it; the host pulls, the
 * container never pushes.
 *
 * desiredCommit is what makes the record safe to act on later. A tag is a
 * moving ref - it can be re-pointed after approval - so the commit it resolved
 * to at approval time is stored beside it, and the constraint below refuses a
 * row where the two do not travel together. approvedBySubject is kept beside
 * approvedBy because a federated approver has no row in LocalAdministrator, so
 * the uuid alone cannot be resolved back to a name afterwards.
 */
export const platformReleaseTarget = pgTable("PlatformReleaseTarget", {
	id: varchar({ length: 32 }).default('global').primaryKey().notNull(),
	desiredVersion: varchar({ length: 64 }),
	desiredCommit: varchar({ length: 40 }),
	approvedBy: uuid(),
	approvedBySubject: varchar({ length: 320 }),
	approvedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	revision: integer().default(0).notNull(),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
}, (table) => [
	check("PlatformReleaseTarget_approval_check", sql`(("desiredVersion" IS NULL) AND ("desiredCommit" IS NULL) AND ("approvedAt" IS NULL) AND ("approvedBySubject" IS NULL)) OR ((length(btrim(("desiredVersion")::text)) > 0) AND (("desiredCommit")::text ~ '^[0-9a-f]{40}$'::text) AND ("approvedAt" IS NOT NULL) AND (length(btrim(("approvedBySubject")::text)) > 0))`),
]);

/**
 * The host update agent's own liveness, written on every timer tick.
 *
 * Separate from PlatformUpdateRun because it answers a different question, and
 * the two must not overwrite each other. This row says "the agent is installed
 * and it checked at 14:02"; a run row says "an upgrade was attempted and here is
 * what happened". Folding them together would mean the next idle tick, ten
 * minutes after an upgrade, erases the record of the upgrade.
 *
 * Without this row an absent agent is indistinguishable from a deployment that
 * has never been upgraded: both have no runs. That is the failure an operator
 * actually hits - approving a release on a VM1 installed before the agent
 * existed, and waiting for something that is never going to read the approval.
 */
export const platformUpdateAgent = pgTable("PlatformUpdateAgent", {
	id: varchar({ length: 32 }).default('global').primaryKey().notNull(),
	phase: varchar({ length: 32 }).notNull(),
	detail: text().notNull(),
	installedVersion: varchar({ length: 64 }),
	installedCommit: varchar({ length: 40 }),
	currentRunId: uuid(),
	checkedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull(),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
});

/**
 * One row per upgrade attempt, with the log the operator reads afterwards.
 *
 * `log` is the installer's UI log, never its stdout. install-orcasynapse.sh
 * prints the Offline recovery key through ui_panel_kv, which is a bare printf
 * that deliberately never reaches UI_LOG_FILE - "printed, never logged" is an
 * invariant that file maintains on purpose. Capturing stdout here would publish
 * that key into this table and then into a browser, so the boundary the
 * installer already draws is the one this column is on the safe side of.
 *
 * apiUnavailableUntil is written before the API stops answering, so a dashboard
 * that cannot reach the control plane can tell a restart from a crash rather
 * than guessing. The agent records it at the top of the attempt for that reason.
 *
 * Rows are retained rather than replaced: the interesting run is usually the one
 * that failed, and the tick after it reports something else entirely.
 */
export const platformUpdateRun = pgTable("PlatformUpdateRun", {
	id: uuid().primaryKey().notNull(),
	phase: varchar({ length: 32 }).notNull(),
	detail: text().notNull(),
	targetVersion: varchar({ length: 64 }),
	targetCommit: varchar({ length: 40 }),
	installedVersion: varchar({ length: 64 }),
	installedCommit: varchar({ length: 40 }),
	// A sentence, not a commit: the agent records what recovery did
	// ("install.sh: RESTORED", "impossible: no previous commit recorded"),
	// because the useful thing to show is what happened, not what it moved to.
	rollback: text(),
	log: text(),
	logTruncated: boolean().default(false).notNull(),
	startedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull(),
	apiUnavailableUntil: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	completedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	recordedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull(),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
}, (table) => [
	index("PlatformUpdateRun_startedAt_idx").using("btree", table.startedAt.desc().nullsLast()),
]);

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
	// The node's systemd units at its last heartbeat. Nullable and undefaulted,
	// unlike capabilities above: an empty array would read as "this node has no
	// units", while null is the truth for a node whose installer predates the
	// field. Those two must not render the same, so the database refuses to
	// invent the difference.
	units: jsonb(),
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
	// A 40-character git commit SHA. VM2 installs Hermes natively and pins
	// with `--commit`; see 0025_hermes_commit_pin.
	hermesCommit: text(),
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

/**
 * An observation of the allowlisted Hermes corpus on one enrolled VM2.
 * HERMES_HOME remains canonical; these rows are a searchable control-plane
 * mirror and never participate in prompt construction.
 */
export const hermesCorpusSnapshot = pgTable("HermesCorpusSnapshot", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	nodeId: uuid().notNull(),
	rootHash: varchar({ length: 64 }).notNull(),
	observedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull(),
	entryCount: integer().notNull(),
	totalBytes: bigint({ mode: "number" }).notNull(),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	index("HermesCorpusSnapshot_nodeId_observedAt_idx").using("btree", table.nodeId.asc().nullsLast(), table.observedAt.desc().nullsLast()),
	foreignKey({
		columns: [table.nodeId],
		foreignColumns: [hermesRuntimeNode.id],
		name: "HermesCorpusSnapshot_nodeId_fkey"
	}).onUpdate("cascade").onDelete("cascade"),
]);

export const hermesCorpusEntry = pgTable("HermesCorpusEntry", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	nodeId: uuid().notNull(),
	path: text().notNull(),
	kind: hermesCorpusEntryKind().notNull(),
	mediaType: varchar({ length: 160 }).notNull(),
	sizeBytes: integer().notNull(),
	sha256: varchar({ length: 64 }).notNull(),
	content: text(),
	structuredEntries: jsonb(),
	readOnly: boolean().default(false).notNull(),
	revision: integer().default(1).notNull(),
	lastSnapshotId: uuid(),
	observedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull(),
	firstSeenAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
	deletedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
}, (table) => [
	uniqueIndex("HermesCorpusEntry_nodeId_path_key").using("btree", table.nodeId.asc().nullsLast(), table.path.asc().nullsLast()),
	index("HermesCorpusEntry_nodeId_kind_deletedAt_idx").using("btree", table.nodeId.asc().nullsLast(), table.kind.asc().nullsLast(), table.deletedAt.asc().nullsLast()),
	index("HermesCorpusEntry_search_idx").using("gin", sql`to_tsvector('simple', coalesce(${table.path}, '') || ' ' || coalesce(${table.content}, ''))`),
	foreignKey({
		columns: [table.nodeId],
		foreignColumns: [hermesRuntimeNode.id],
		name: "HermesCorpusEntry_nodeId_fkey"
	}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
		columns: [table.lastSnapshotId],
		foreignColumns: [hermesCorpusSnapshot.id],
		name: "HermesCorpusEntry_lastSnapshotId_fkey"
	}).onUpdate("cascade").onDelete("set null"),
]);

export const hermesCorpusMutation = pgTable("HermesCorpusMutation", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	nodeId: uuid().notNull(),
	operation: hermesCorpusMutationOperation().notNull(),
	path: text().notNull(),
	expectedHash: varchar({ length: 64 }),
	content: text(),
	oldText: text(),
	reason: varchar({ length: 1000 }).notNull(),
	status: hermesCorpusMutationStatus().notNull(),
	requestedBy: uuid().notNull(),
	requestedBySubject: varchar({ length: 320 }).notNull(),
	approvedBy: uuid(),
	approvedBySubject: varchar({ length: 320 }),
	beforeHash: varchar({ length: 64 }),
	afterHash: varchar({ length: 64 }),
	error: text(),
	idempotencyKey: uuid().notNull(),
	requestedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	approvedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	dispatchedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	completedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
}, (table) => [
	uniqueIndex("HermesCorpusMutation_idempotencyKey_key").using("btree", table.idempotencyKey.asc().nullsLast()),
	index("HermesCorpusMutation_nodeId_status_requestedAt_idx").using("btree", table.nodeId.asc().nullsLast(), table.status.asc().nullsLast(), table.requestedAt.asc().nullsLast()),
	foreignKey({
		columns: [table.nodeId],
		foreignColumns: [hermesRuntimeNode.id],
		name: "HermesCorpusMutation_nodeId_fkey"
	}).onUpdate("cascade").onDelete("cascade"),
]);

export const hermesCorpusRevision = pgTable("HermesCorpusRevision", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	entryId: uuid(),
	nodeId: uuid().notNull(),
	path: text().notNull(),
	revision: integer().notNull(),
	changeKind: varchar({ length: 32 }).notNull(),
	beforeHash: varchar({ length: 64 }),
	afterHash: varchar({ length: 64 }),
	beforeContent: text(),
	afterContent: text(),
	mutationId: uuid(),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	index("HermesCorpusRevision_nodeId_path_revision_idx").using("btree", table.nodeId.asc().nullsLast(), table.path.asc().nullsLast(), table.revision.desc().nullsLast()),
	foreignKey({
		columns: [table.entryId],
		foreignColumns: [hermesCorpusEntry.id],
		name: "HermesCorpusRevision_entryId_fkey"
	}).onUpdate("cascade").onDelete("set null"),
	foreignKey({
		columns: [table.nodeId],
		foreignColumns: [hermesRuntimeNode.id],
		name: "HermesCorpusRevision_nodeId_fkey"
	}).onUpdate("cascade").onDelete("cascade"),
	foreignKey({
		columns: [table.mutationId],
		foreignColumns: [hermesCorpusMutation.id],
		name: "HermesCorpusRevision_mutationId_fkey"
	}).onUpdate("cascade").onDelete("set null"),
]);

export const guardrailPolicy = pgTable("GuardrailPolicy", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	slug: varchar({ length: 64 }).notNull(),
	displayName: varchar({ length: 120 }).notNull(),
	description: varchar({ length: 500 }).notNull(),
	version: varchar({ length: 120 }).notNull(),
	status: guardrailPolicyStatus().default('DRAFT').notNull(),
	maxInputCharacters: integer().notNull(),
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
	uniqueIndex("GuardrailPolicy_single_active_key").using("btree", sql`(true)`).where(sql`(status = 'ACTIVE'::"GuardrailPolicyStatus")`),
	uniqueIndex("GuardrailPolicy_slug_key").using("btree", table.slug.asc().nullsLast()),
	index("GuardrailPolicy_status_updatedAt_idx").using("btree", table.status.asc().nullsLast(), table.updatedAt.asc().nullsLast()),
	check("GuardrailPolicy_activation_check", sql`(status <> 'ACTIVE'::"GuardrailPolicyStatus") OR ("firstActivatedAt" IS NOT NULL)`),
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

/**
 * A username and password for one `EnterpriseUser`.
 *
 * Deliberately a second table rather than columns on the identity. An
 * `EnterpriseUser` is who somebody is -- their division, their display name,
 * what they may reach; a `LocalUser` is one way of proving it. Keeping them
 * apart means a person can later be migrated to an identity provider by
 * deleting a credential rather than by rebuilding an identity, and it keeps a
 * password hash out of every query that only wanted a name.
 *
 * Every field here mirrors `LocalAdministrator`, because the lockout and
 * forced-rotation behaviour must not diverge between the two. The plan is
 * explicit that a third credential store is the real cost of this option; the
 * mitigation is that both are the same shape and share one failure limit.
 */
export const localUser = pgTable("LocalUser", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid().notNull(),
	username: varchar({ length: 64 }).notNull(),
	passwordHash: text().notNull(),
	passwordChangeRequired: boolean().default(true).notNull(),
	failedLoginCount: integer().default(0).notNull(),
	lockedUntil: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	passwordChangedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	createdBy: uuid(),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
}, (table) => [
	uniqueIndex("LocalUser_username_key").using("btree", table.username.asc().nullsLast()),
	// One credential per identity: two passwords for one person would make
	// "disable this account" ambiguous.
	uniqueIndex("LocalUser_userId_key").using("btree", table.userId.asc().nullsLast()),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [enterpriseUser.id],
			name: "LocalUser_userId_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

/**
 * Division-scoped agent memory.
 *
 * Written and read only by the governed `remember` / `recall` tools, whose
 * division comes from the run authorization rather than from anything the agent
 * sent. See `DrizzleToolingManager.runScope`.
 *
 * `divisionId` is nullable and null is a real scope -- a run against a
 * deployment-wide profile -- not the absence of one. Reading it as "no filter"
 * would hand every division's rows to a run that belongs to none of them, so
 * every query here matches null explicitly rather than omitting the predicate.
 *
 * It lives in VM1's database because the tool executes on VM1: the MCP plane is
 * the API. Nothing on VM2 reads or writes this table, so no SQL credential goes
 * anywhere near the runtime, and the Memory screen can show these rows directly
 * instead of reconciling a copy.
 */
export const scopedMemoryEntry = pgTable("ScopedMemoryEntry", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	divisionId: uuid(),
	content: text().notNull(),
	/** Which run wrote it, for the audit trail and for the Memory screen. */
	runId: uuid(),
	createdAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	index("ScopedMemoryEntry_divisionId_createdAt_idx").using("btree", table.divisionId.asc().nullsLast(), table.createdAt.desc().nullsLast()),
	index("ScopedMemoryEntry_search_idx").using("gin", sql`to_tsvector('simple', ${table.content})`),
	foreignKey({
			columns: [table.divisionId],
			foreignColumns: [division.id],
			name: "ScopedMemoryEntry_divisionId_fkey"
		}).onUpdate("cascade").onDelete("cascade"),
]);

export const agentRun = pgTable("AgentRun", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	profileId: uuid().notNull(),
	profileVersionId: uuid().notNull(),
	profileVersion: integer().notNull(),
	ownerSubject: varchar({ length: 200 }).notNull(),
	requestedBy: uuid().notNull(),
	status: agentRunStatus().default('QUEUED').notNull(),
	input: text().notNull(),
	output: text(),
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
 * How far the audit trail has been forwarded to a SIEM.
 *
 * Position is AuditEvent.cursor: everything at or below it has been delivered.
 * Failures leave it untouched, so a batch is retried rather than lost.
 *
 * lastForwardedAt and lastForwardedId describe the last event sent and are
 * shown to operators; they are not the position. A wall-clock cursor orders
 * events by when their transaction began rather than by when they became
 * readable, which permanently skipped events written by slow transactions.
 */
export const auditForwardingState = pgTable("AuditForwardingState", {
	id: varchar({ length: 32 }).default('global').primaryKey().notNull(),
	lastForwardedCursor: bigint({ mode: "bigint" }),
	lastForwardedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	lastForwardedId: uuid(),
	lastAttemptAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }),
	lastError: varchar({ length: 500 }),
	deliveredCount: integer().default(0).notNull(),
	updatedAt: timestamp({ precision: 6, withTimezone: true, mode: 'date' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
});
