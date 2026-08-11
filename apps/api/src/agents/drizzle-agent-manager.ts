import type {
  HermesRuntimeCatalogue,
  AgentCapability,
  AgentMemoryMode,
  AgentMetrics,
  AgentProfile,
  AgentProfileList,
  AgentRun,
  AgentRunEvent,
  AgentRunEventList,
  AgentRunList,
  AgentRuntimeControl,
  CreateAgentProfile,
  KnowledgeSource,
  SubmitAgentRun,
  UpdateAgentProfile,
  UpdateAgentRuntimeControl,
} from "@orcasynapse/contracts";
import { agentCapabilitySchema, agentSkillReferenceSchema, knowledgeSourceSchema } from "@orcasynapse/contracts";
import {
  agentProfile,
  agentProfileVersion,
  agentRun,
  agentRunEvent,
  agentRuntimeControl,
  auditEvent,
  componentCompatibility,
  evaluationRun,
  hermesRuntimeNode,
  modelDeployment,
  platformArchitectureDecision,
  runtimeToolsetAdmission,
  serviceConnection,
  toolRuntimeControl,
  type OrcaSynapseDatabase,
  agentRunWakeStatement,
} from "@orcasynapse/database";
import { and, count, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { advisoryLock, isUniqueViolation } from "../database-support.js";
import {
  AgentConflictError,
  AgentNotFoundError,
  AgentRuntimeDisabledError,
  type AgentBoundaryVerifier,
  type AgentManager,
  type AgentPrincipal,
} from "./agent-manager.js";

interface StoredVersion {
  id: string;
  version: number;
  displayName: string;
  purpose: string;
  instructions: string;
  soulMd: string;
  skills: unknown;
  distributionDigest: string | null;
  modelAlias: string;
  maxTurns: number;
  timeoutSeconds: number;
  maxConcurrentRuns: number;
  allowPrivateKnowledge: boolean;
  memoryMode: AgentMemoryMode;
  safeMode: boolean;
  createdBy: string | null;
  createdAt: Date;
}

interface StoredProfile {
  id: string;
  slug: string;
  status: AgentProfile["status"];
  currentVersion: number;
  activeVersion: number | null;
  createdAt: Date;
  updatedAt: Date;
  versions: StoredVersion[];
}

interface StoredRun {
  id: string;
  profileId: string;
  profileVersion: number;
  profileDistributionDigest: string | null;
  status: AgentRun["status"];
  input: string;
  output: string | null;
  partialOutput: string;
  modelAlias: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  finishReason: string | null;
  effectiveCapabilities: unknown;
  sources: unknown;
  failureCode: string | null;
  failureMessage: string | null;
  queuedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  profile: { slug: string };
  version: { displayName: string; distributionDigest: string | null };
}

interface StoredRunEvent {
  id: string;
  cursor: bigint;
  runId: string;
  type: AgentRunEvent["type"];
  delta: string | null;
  preview: string | null;
  errorCode: string | null;
  approvalId: string | null;
  summary: string | null;
  status: string | null;
  toolName: string | null;
  toolCallKey: string | null;
  text: string | null;
  contentOffset: number | null;
  childSessionId: string | null;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  // PostgreSQL numeric arrives as a string; the DTO narrows it to a number.
  costUsd: string | number | null;
  occurredAt: Date;
}

/**
 * The relation shape that replaces the Prisma profile include. It is a function
 * because the relational query builder requires a mutable `orderBy` array.
 */
function profileWith() {
  return { agentProfileVersions: { orderBy: [desc(agentProfileVersion.version)] } };
}

/** The relation shape that replaces the Prisma run include. */
const runWith = {
  agentProfile: { columns: { slug: true } },
  agentProfileVersion: { columns: { displayName: true, distributionDigest: true } },
} as const;

type LoadedProfile = { agentProfileVersions: StoredVersion[] } & Omit<StoredProfile, "versions">;
type LoadedRun = {
  agentProfile: { slug: string } | null;
  agentProfileVersion: { displayName: string; distributionDigest: string | null } | null;
} & Omit<StoredRun, "profile" | "version">;

function storedProfile(loaded: LoadedProfile): StoredProfile {
  const { agentProfileVersions, ...profile } = loaded;
  return { ...profile, versions: agentProfileVersions };
}

function storedRun(loaded: LoadedRun): StoredRun {
  const { agentProfile: profile, agentProfileVersion: version, ...run } = loaded;
  if (!profile || !version) throw new AgentConflictError("The agent run has lost its profile configuration.");
  return { ...run, profile, version };
}

function parseSkills(value: unknown) {
  if (!Array.isArray(value)) throw new AgentConflictError("The Profile Distribution Skill manifest is invalid.");
  return value.map((skill) => {
    const parsed = agentSkillReferenceSchema.safeParse(skill);
    if (!parsed.success) throw new AgentConflictError("The Profile Distribution Skill manifest is invalid.");
    return parsed.data;
  });
}

function distributionDigest(configuration: {
  displayName: string;
  purpose: string;
  instructions: string;
  soulMd: string;
  skills: Array<{ name: string; version: string; digest: string }>;
  modelAlias: string;
  maxTurns: number;
  timeoutSeconds: number;
  maxConcurrentRuns: number;
  allowPrivateKnowledge: boolean;
  memoryMode: AgentMemoryMode;
  safeMode: boolean;
}): string {
  const canonical = {
    displayName: configuration.displayName,
    purpose: configuration.purpose,
    instructions: configuration.instructions,
    soulMd: configuration.soulMd,
    skills: [...configuration.skills].sort((left, right) =>
      `${left.name}:${left.version}:${left.digest}`.localeCompare(`${right.name}:${right.version}:${right.digest}`)),
    modelAlias: configuration.modelAlias,
    maxTurns: configuration.maxTurns,
    timeoutSeconds: configuration.timeoutSeconds,
    maxConcurrentRuns: configuration.maxConcurrentRuns,
    allowPrivateKnowledge: configuration.allowPrivateKnowledge,
    memoryMode: configuration.memoryMode,
    safeMode: configuration.safeMode,
  };
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

/**
 * Agent memory is owned by Hermes' native MEMORY.md / USER.md lifecycle.
 *
 * OrcaSynapse still materializes document-retrieval authority here, but it no
 * longer grants either side of the legacy pgvector agent-memory plane. The
 * stored memoryMode field is retained only so the backup branch and existing
 * rows remain reversible during this pre-production transition.
 */
function executionCapabilities(_mode: AgentMemoryMode, allowPrivateKnowledge: boolean): AgentCapability[] {
  return allowPrivateKnowledge ? ["knowledge:private:read"] : [];
}

function versionDto(version: StoredVersion) {
  if (version.maxTurns !== 1 || version.safeMode !== true) {
    throw new AgentConflictError("The agent version does not satisfy the enforced safe-mode boundary.");
  }
  const skills = parseSkills(version.skills);
  const soulMd = version.soulMd.trim().length >= 10 ? version.soulMd : version.instructions;
  const digest = version.distributionDigest ?? distributionDigest({
    displayName: version.displayName, purpose: version.purpose, instructions: version.instructions,
    soulMd, skills, modelAlias: version.modelAlias, maxTurns: version.maxTurns,
    timeoutSeconds: version.timeoutSeconds, maxConcurrentRuns: version.maxConcurrentRuns,
    allowPrivateKnowledge: version.allowPrivateKnowledge, memoryMode: version.memoryMode, safeMode: version.safeMode,
  });
  return {
    id: version.id,
    version: version.version,
    displayName: version.displayName,
    purpose: version.purpose,
    instructions: version.instructions,
    soulMd,
    skills,
    modelAlias: version.modelAlias,
    maxTurns: 1 as const,
    timeoutSeconds: version.timeoutSeconds,
    maxConcurrentRuns: version.maxConcurrentRuns,
    allowPrivateKnowledge: version.allowPrivateKnowledge,
    memoryMode: version.memoryMode,
    safeMode: true as const,
    createdBy: version.createdBy,
    distributionDigest: digest,
    createdAt: version.createdAt.toISOString(),
  };
}

function profileDto(profile: StoredProfile, preferCurrent = false): AgentProfile {
  const requestedVersion = preferCurrent ? profile.currentVersion : profile.activeVersion ?? profile.currentVersion;
  const version = profile.versions.find((item) => item.version === requestedVersion) ?? profile.versions[0];
  const activeVersion = profile.activeVersion === null
    ? null
    : profile.versions.find((item) => item.version === profile.activeVersion);
  if (!version) throw new AgentConflictError("The agent profile has no configuration version.");
  if (profile.activeVersion !== null && !activeVersion) {
    throw new AgentConflictError("The active agent configuration is missing.");
  }
  return {
    id: profile.id,
    slug: profile.slug,
    status: profile.status,
    currentVersion: profile.currentVersion,
    activeVersion: profile.activeVersion,
    activeVersionConfiguration: activeVersion ? versionDto(activeVersion) : null,
    version: versionDto(version),
    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
  };
}

function parseCapabilities(value: unknown): AgentCapability[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = agentCapabilitySchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

function parseSources(value: unknown): KnowledgeSource[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 10).flatMap((item) => {
    const parsed = knowledgeSourceSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

function runDto(run: StoredRun): AgentRun {
  return {
    id: run.id,
    profileId: run.profileId,
    profileSlug: run.profile.slug,
    profileName: run.version.displayName,
    profileVersion: run.profileVersion,
    profileDistributionDigest: run.profileDistributionDigest ?? run.version.distributionDigest,
    status: run.status,
    input: run.input,
    output: run.output,
    partialOutput: run.partialOutput,
    modelAlias: run.modelAlias,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    reasoningTokens: run.reasoningTokens,
    totalTokens: run.totalTokens,
    finishReason: run.finishReason,
    effectiveCapabilities: parseCapabilities(run.effectiveCapabilities),
    sources: parseSources(run.sources),
    failureCode: run.failureCode,
    failureMessage: run.failureMessage,
    queuedAt: run.queuedAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  };
}

function runEventDto(event: StoredRunEvent): AgentRunEvent {
  return {
    id: event.id,
    cursor: event.cursor.toString(),
    runId: event.runId,
    type: event.type,
    delta: event.delta,
    preview: event.preview,
    errorCode: event.errorCode,
    approvalId: event.approvalId,
    summary: event.summary,
    status: event.status,
    toolName: event.toolName,
    toolCallKey: event.toolCallKey,
    text: event.text,
    contentOffset: event.contentOffset,
    childSessionId: event.childSessionId,
    durationMs: event.durationMs,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    reasoningTokens: event.reasoningTokens,
    costUsd: event.costUsd === null ? null : Number(event.costUsd),
    occurredAt: event.occurredAt.toISOString(),
  };
}

export class DrizzleAgentManager implements AgentManager {
  constructor(
    private readonly database: OrcaSynapseDatabase,
    private readonly boundaryVerifier?: AgentBoundaryVerifier,
  ) {}

  async listProfiles(_principal: AgentPrincipal, includeInactive: boolean): Promise<AgentProfileList> {
    const profiles = await this.database.query.agentProfile.findMany({
      ...(includeInactive
        ? {}
        : { where: and(eq(agentProfile.status, "ACTIVE"), isNotNull(agentProfile.activeVersion)) }),
      with: profileWith(),
      orderBy: [desc(agentProfile.updatedAt)],
      limit: 100,
    });
    return {
      items: (profiles as LoadedProfile[]).map((profile) => profileDto(storedProfile(profile), includeInactive)),
    };
  }

  async createProfile(principal: AgentPrincipal, input: CreateAgentProfile): Promise<AgentProfile> {
    const digest = distributionDigest(input);
    let created: StoredProfile;
    try {
      created = await this.database.transaction(async (transaction) => {
        const [profile] = await transaction
          .insert(agentProfile)
          .values({ slug: input.slug })
          .returning();
        if (!profile) throw new AgentConflictError("The agent profile could not be created.");
        const [version] = await transaction
          .insert(agentProfileVersion)
          .values({
            profileId: profile.id,
            version: 1,
            displayName: input.displayName,
            purpose: input.purpose,
            instructions: input.instructions,
            soulMd: input.soulMd,
            skills: input.skills,
            distributionDigest: digest,
            modelAlias: input.modelAlias,
            maxTurns: input.maxTurns,
            timeoutSeconds: input.timeoutSeconds,
            maxConcurrentRuns: input.maxConcurrentRuns,
            allowPrivateKnowledge: input.allowPrivateKnowledge,
            memoryMode: input.memoryMode,
            safeMode: input.safeMode,
            createdBy: principal.id,
          })
          .returning();
        if (!version) throw new AgentConflictError("The agent configuration could not be created.");
        await transaction.insert(auditEvent).values({
          actorType: "USER", actorId: principal.id, action: "agent.profile_created",
          resourceType: "AgentProfile", resourceId: profile.id, outcome: "SUCCESS",
          metadata: { slug: input.slug, version: 1 },
        });
        return { ...profile, versions: [version] } as StoredProfile;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new AgentConflictError("An agent profile already uses this slug.");
      throw error;
    }
    return profileDto(created, true);
  }

  async updateProfile(principal: AgentPrincipal, profileId: string, input: UpdateAgentProfile): Promise<AgentProfile> {
    const updated = await this.database.transaction(async (transaction) => {
      await transaction.execute(advisoryLock(`orcasynapse-agent-profile:${profileId}`));
      const [profile] = await transaction
        .select()
        .from(agentProfile)
        .where(eq(agentProfile.id, profileId))
        .limit(1);
      if (!profile) throw new AgentNotFoundError();
      const [current] = await transaction
        .select()
        .from(agentProfileVersion)
        .where(and(
          eq(agentProfileVersion.profileId, profileId),
          eq(agentProfileVersion.version, profile.currentVersion),
        ))
        .limit(1);
      if (!current) throw new AgentConflictError("The current agent configuration is missing.");
      const nextVersion = profile.currentVersion + 1;
      const skills = input.skills ?? parseSkills(current.skills);
      const soulMd = input.soulMd ?? (current.soulMd.trim().length >= 10 ? current.soulMd : current.instructions);
      const nextConfiguration = {
        displayName: input.displayName ?? current.displayName,
        purpose: input.purpose ?? current.purpose,
        instructions: input.instructions ?? current.instructions,
        soulMd,
        skills,
        modelAlias: input.modelAlias ?? current.modelAlias,
        maxTurns: input.maxTurns ?? current.maxTurns,
        timeoutSeconds: input.timeoutSeconds ?? current.timeoutSeconds,
        maxConcurrentRuns: input.maxConcurrentRuns ?? current.maxConcurrentRuns,
        allowPrivateKnowledge: input.allowPrivateKnowledge ?? current.allowPrivateKnowledge,
        memoryMode: input.memoryMode ?? current.memoryMode,
        safeMode: input.safeMode ?? current.safeMode,
      };
      await transaction.insert(agentProfileVersion).values({
        profileId,
        version: nextVersion,
        ...nextConfiguration,
        distributionDigest: distributionDigest(nextConfiguration),
        createdBy: principal.id,
      });
      await transaction
        .update(agentProfile)
        .set({ currentVersion: nextVersion })
        .where(eq(agentProfile.id, profileId));
      await transaction.insert(auditEvent).values({
        actorType: "USER", actorId: principal.id, action: "agent.profile_version_created",
        resourceType: "AgentProfile", resourceId: profileId, outcome: "SUCCESS",
        metadata: { version: nextVersion, changedFields: Object.keys(input) },
      });
      const reloaded = await transaction.query.agentProfile.findFirst({
        where: eq(agentProfile.id, profileId),
        with: profileWith(),
      });
      if (!reloaded) throw new AgentNotFoundError();
      return storedProfile(reloaded as LoadedProfile);
    });
    return profileDto(updated, true);
  }

  async activateProfile(principal: AgentPrincipal, profileId: string): Promise<AgentProfile> {
    return profileDto(await this.changeProfileState(principal, profileId, "ACTIVE"), true);
  }

  async standbyProfile(principal: AgentPrincipal, profileId: string): Promise<AgentProfile> {
    return profileDto(await this.changeProfileState(principal, profileId, "STANDBY"), true);
  }

  async suspendProfile(principal: AgentPrincipal, profileId: string): Promise<AgentProfile> {
    return profileDto(await this.changeProfileState(principal, profileId, "SUSPENDED"), true);
  }

  async listRuns(principal: AgentPrincipal, includeAll: boolean): Promise<AgentRunList> {
    const runs = await this.database.query.agentRun.findMany({
      ...(includeAll ? {} : { where: eq(agentRun.ownerSubject, principal.subject) }),
      with: runWith,
      orderBy: [desc(agentRun.createdAt)],
      limit: 200,
    });
    return { items: (runs as LoadedRun[]).map((run) => runDto(storedRun(run))) };
  }

  async getRun(principal: AgentPrincipal, runId: string, includeAll: boolean): Promise<AgentRun> {
    const run = await this.database.query.agentRun.findFirst({
      where: includeAll
        ? eq(agentRun.id, runId)
        : and(eq(agentRun.id, runId), eq(agentRun.ownerSubject, principal.subject)),
      with: runWith,
    });
    if (!run) throw new AgentNotFoundError();
    return runDto(storedRun(run as LoadedRun));
  }

  async listRunEvents(principal: AgentPrincipal, runId: string, includeAll: boolean): Promise<AgentRunEventList> {
    const [run] = await this.database
      .select({ id: agentRun.id })
      .from(agentRun)
      .where(includeAll
        ? eq(agentRun.id, runId)
        : and(eq(agentRun.id, runId), eq(agentRun.ownerSubject, principal.subject)))
      .limit(1);
    if (!run) throw new AgentNotFoundError();
    // Ordered by cursor, and taken from the newest end.
    //
    // occurredAt is millisecond-resolution and id is a random UUID v4, so a
    // burst written inside one millisecond came back in UUID order: a tool
    // result could precede its own call and reassembled delta text scrambled.
    // cursor is the append-order bigserial the chat stream already reads, and
    // it has its own (runId, cursor) index. Descending then reversed, because
    // an ascending cap returned the OLDEST 500 and a longer run showed nothing
    // that happened after them.
    const events = await this.database
      .select()
      .from(agentRunEvent)
      .where(eq(agentRunEvent.runId, runId))
      .orderBy(desc(agentRunEvent.cursor))
      .limit(500);
    return { items: events.reverse().map((event) => runEventDto(event as StoredRunEvent)) };
  }

  async submitRun(
    principal: AgentPrincipal,
    input: SubmitAgentRun,
    options: {
      sessionId?: string;
      memorySessionKey?: string;
      conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>;
      outputCharacterLimit?: number;
      knowledgeDocumentIds?: readonly string[];
    } = {},
  ): Promise<AgentRun> {
    const runId = randomUUID();
    const conversationHistory = (options.conversationHistory ?? []).slice(-40);
    if (conversationHistory.some(({ role, content }) =>
      !["user", "assistant"].includes(role) || typeof content !== "string" || content.length > 32_000)) {
      throw new AgentConflictError("The supplied conversation history is invalid.");
    }
    const historyCharacters = conversationHistory.reduce((total, message) => total + message.content.length, 0);
    if (historyCharacters > 64_000) throw new AgentConflictError("The supplied conversation history is too large.");
    const memorySessionKey = options.memorySessionKey ?? options.sessionId ?? runId;
    if (memorySessionKey.length < 1 || memorySessionKey.length > 200) {
      throw new AgentConflictError("The Hermes memory session key is invalid.");
    }
    const outputCharacterLimit = Math.min(200_000, Math.max(1_000, options.outputCharacterLimit ?? 200_000));
    const run = await this.database.transaction(async (transaction) => {
      await transaction.execute(advisoryLock(`orcasynapse-agent-submit:${input.profileId}`));
      const [control] = await transaction
        .select()
        .from(agentRuntimeControl)
        .where(eq(agentRuntimeControl.id, "global"))
        .limit(1);
      const [profile] = await transaction
        .select()
        .from(agentProfile)
        .where(eq(agentProfile.id, input.profileId))
        .limit(1);
      const runtimeNodes = await transaction
        .select({
          status: hermesRuntimeNode.status,
          lastSeenAt: hermesRuntimeNode.lastSeenAt,
          connectionEnabled: serviceConnection.enabled,
          connectionStatus: serviceConnection.status,
        })
        .from(hermesRuntimeNode)
        .leftJoin(serviceConnection, eq(hermesRuntimeNode.serviceConnectionId, serviceConnection.id))
        .where(and(isNotNull(hermesRuntimeNode.enrolledAt), ne(hermesRuntimeNode.status, "REVOKED")))
        .limit(2);

      if (!control?.enabled) throw new AgentRuntimeDisabledError(control?.reason ?? undefined);
      const runtimeNode = runtimeNodes[0];
      const heartbeatIsFresh = runtimeNode?.lastSeenAt
        && Date.now() - runtimeNode.lastSeenAt.getTime() < 180_000;
      if (
        runtimeNodes.length !== 1
        || runtimeNode?.status !== "ONLINE"
        || !heartbeatIsFresh
        || runtimeNode.connectionEnabled !== true
        || runtimeNode.connectionStatus !== "HEALTHY"
      ) {
        const reason = runtimeNode?.status === "DRAINING"
          ? "The Hermes runtime is draining and cannot accept new work."
          : runtimeNode?.status === "SUSPENDED"
            ? "The Hermes runtime is suspended."
            : "Exactly one online, recently observed, and healthy Hermes runtime is required.";
        throw new AgentRuntimeDisabledError(reason);
      }
      if (!profile || profile.status !== "ACTIVE" || profile.activeVersion === null) {
        throw new AgentConflictError("Only an active agent profile can accept runs.");
      }
      const [version] = await transaction
        .select()
        .from(agentProfileVersion)
        .where(and(
          eq(agentProfileVersion.profileId, profile.id),
          eq(agentProfileVersion.version, profile.activeVersion),
        ))
        .limit(1);
      if (!version) throw new AgentConflictError("The active agent configuration is missing.");
      const [activeRuns] = await transaction
        .select({ total: count() })
        .from(agentRun)
        .where(and(
          eq(agentRun.profileId, profile.id),
          inArray(agentRun.status, ["QUEUED", "RUNNING", "WAITING_FOR_APPROVAL", "CANCEL_REQUESTED"]),
        ));
      if ((activeRuns?.total ?? 0) >= version.maxConcurrentRuns) {
        throw new AgentConflictError("This agent has reached its configured concurrent-run limit.");
      }
      const [created] = await transaction
        .insert(agentRun)
        .values({
          id: runId,
          profileId: profile.id,
          profileVersionId: version.id,
          profileVersion: version.version,
          profileDistributionDigest: version.distributionDigest,
          ownerSubject: principal.subject,
          requestedBy: principal.id,
          sessionId: options.sessionId ?? runId,
          memorySessionKey,
          input: input.input,
          conversationHistory,
          outputCharacterLimit,
          modelAlias: version.modelAlias,
          jobId: randomUUID(),
          effectiveCapabilities: executionCapabilities(version.memoryMode, version.allowPrivateKnowledge),
          // Absent means owner-wide retrieval; present narrows it for this run.
          ...(options.knowledgeDocumentIds ? { knowledgeDocumentIds: [...options.knowledgeDocumentIds] } : {}),
        })
        .returning();
      if (!created) throw new AgentConflictError("The agent run could not be queued.");
      // Wakes the worker the instant this commits, instead of leaving the
      // message to wait out the reconcile tick. PostgreSQL defers NOTIFY until
      // commit, so the worker can never be woken for a run it cannot yet see.
      // The tick still runs: this only removes the wait, never the guarantee.
      await transaction.execute(sql.raw(agentRunWakeStatement()));
      await transaction.insert(auditEvent).values({
        actorType: "USER", actorId: principal.id, action: "agent.run_queued",
        resourceType: "AgentRun", resourceId: created.id, outcome: "SUCCESS",
        metadata: { profileId: profile.id, profileVersion: version.version },
      });
      return {
        ...created,
        profile: { slug: profile.slug },
        version: { displayName: version.displayName, distributionDigest: version.distributionDigest },
      } as StoredRun;
    });
    return runDto(run);
  }

  async cancelRun(principal: AgentPrincipal, runId: string, includeAll: boolean): Promise<AgentRun> {
    const ownership = includeAll ? undefined : eq(agentRun.ownerSubject, principal.subject);
    const changed = await this.database
      .update(agentRun)
      .set({ status: "CANCEL_REQUESTED" })
      .where(and(
        eq(agentRun.id, runId),
        ownership,
        inArray(agentRun.status, ["QUEUED", "RUNNING", "WAITING_FOR_APPROVAL"]),
      ))
      .returning({ id: agentRun.id });
    if (changed.length !== 1) {
      const [existing] = await this.database
        .select({ id: agentRun.id })
        .from(agentRun)
        .where(and(eq(agentRun.id, runId), ownership))
        .limit(1);
      if (!existing) throw new AgentNotFoundError();
      throw new AgentConflictError("Only queued or running agent work can be cancelled.");
    }
    await this.database.insert(auditEvent).values({
      actorType: "USER", actorId: principal.id, action: "agent.run_cancel_requested",
      resourceType: "AgentRun", resourceId: runId, outcome: "SUCCESS",
    });
    return this.getRun(principal, runId, includeAll);
  }

  async runtimeCatalogue(): Promise<HermesRuntimeCatalogue> {
    if (!this.boundaryVerifier) {
      return { toolsets: [], skills: [], enabledToolsets: 0 };
    }
    const { toolsets, skills } = await this.boundaryVerifier.catalogue();
    return {
      toolsets,
      skills,
      enabledToolsets: toolsets.filter((toolset) => toolset.enabled).length,
    };
  }

  async getRuntimeControl(): Promise<AgentRuntimeControl> {
    const [control] = await this.database
      .select()
      .from(agentRuntimeControl)
      .where(eq(agentRuntimeControl.id, "global"))
      .limit(1);
    return {
      enabled: control?.enabled ?? false,
      reason: control?.reason ?? "Runtime control is missing; execution is denied fail-closed.",
      updatedAt: (control?.updatedAt ?? new Date(0)).toISOString(),
      updatedBy: control?.updatedBy ?? null,
    };
  }

  async updateRuntimeControl(principal: AgentPrincipal, input: UpdateAgentRuntimeControl): Promise<AgentRuntimeControl> {
    if (input.enabled) {
      if (!this.boundaryVerifier) {
        throw new AgentRuntimeDisabledError("Hermes boundary verification is unavailable; execution remains disabled.");
      }
      try {
        const [toolControl] = await this.database
          .select({ enabled: toolRuntimeControl.enabled })
          .from(toolRuntimeControl)
          .where(eq(toolRuntimeControl.id, "global"))
          .limit(1);
        if (toolControl?.enabled) await this.boundaryVerifier.assertGovernedToolBoundary();
        else await this.boundaryVerifier.assertAdmittedToolBoundary(await this.admittedToolsets());
      } catch {
        await this.database.insert(auditEvent).values({
          actorType: "USER", actorId: principal.id, action: "agent.runtime_enable_denied",
          resourceType: "AgentRuntimeControl", resourceId: "global", outcome: "FAILURE",
          metadata: { reason: input.reason, failureCode: "HERMES_BOUNDARY_VERIFICATION_FAILED" },
        });
        throw new AgentRuntimeDisabledError("Hermes failed the authenticated execution-boundary check; execution remains disabled.");
      }
    }
    const control = await this.database.transaction(async (transaction) => {
      const [updated] = await transaction
        .insert(agentRuntimeControl)
        .values({ id: "global", enabled: input.enabled, reason: input.reason, updatedBy: principal.id })
        .onConflictDoUpdate({
          target: agentRuntimeControl.id,
          set: { enabled: input.enabled, reason: input.reason, updatedBy: principal.id, updatedAt: new Date() },
        })
        .returning();
      if (!updated) throw new AgentConflictError("The agent runtime control could not be written.");
      await transaction.insert(auditEvent).values({
        actorType: "USER", actorId: principal.id,
        action: input.enabled ? "agent.runtime_enabled" : "agent.runtime_disabled",
        resourceType: "AgentRuntimeControl", resourceId: "global", outcome: "SUCCESS",
        metadata: { reason: input.reason },
      });
      return updated;
    });
    return { enabled: control.enabled, reason: control.reason, updatedAt: control.updatedAt.toISOString(), updatedBy: control.updatedBy };
  }

  async metrics(): Promise<AgentMetrics> {
    const [profiles, runs] = await Promise.all([
      this.database
        .select({ status: agentProfile.status, total: count() })
        .from(agentProfile)
        .groupBy(agentProfile.status),
      this.database
        .select({ status: agentRun.status, total: count() })
        .from(agentRun)
        .groupBy(agentRun.status),
    ]);
    const profileCount = (status?: string) =>
      profiles.filter((item) => !status || item.status === status).reduce((sum, item) => sum + item.total, 0);
    const runCount = (statuses: string[]) =>
      runs.filter((item) => statuses.includes(item.status)).reduce((sum, item) => sum + item.total, 0);
    return {
      generatedAt: new Date().toISOString(), profiles: profileCount(), activeProfiles: profileCount("ACTIVE"),
      queuedRuns: runCount(["QUEUED"]), runningRuns: runCount(["RUNNING", "WAITING_FOR_APPROVAL", "CANCEL_REQUESTED"]),
      completedRuns: runCount(["COMPLETED"]), failedRuns: runCount(["FAILED", "TIMED_OUT", "DENIED"]),
    };
  }

  /** Toolsets an operator has admitted; anything else enabled fails the check. */
  private async admittedToolsets(): Promise<string[]> {
    const rows = await this.database
      .select({ toolsetName: runtimeToolsetAdmission.toolsetName })
      .from(runtimeToolsetAdmission)
      .where(eq(runtimeToolsetAdmission.admitted, true));
    return rows.map((row) => row.toolsetName);
  }

  private async changeProfileState(
    principal: AgentPrincipal,
    profileId: string,
    state: "ACTIVE" | "STANDBY" | "SUSPENDED",
  ): Promise<StoredProfile> {
    return this.database.transaction(async (transaction) => {
      const [profile] = await transaction
        .select()
        .from(agentProfile)
        .where(eq(agentProfile.id, profileId))
        .limit(1);
      if (!profile) throw new AgentNotFoundError();
      const requiresRelease = state !== "SUSPENDED";
      const [currentVersion] = requiresRelease
        ? await transaction
          .select({
            modelAlias: agentProfileVersion.modelAlias,
            distributionDigest: agentProfileVersion.distributionDigest,
          })
          .from(agentProfileVersion)
          .where(and(
            eq(agentProfileVersion.profileId, profileId),
            eq(agentProfileVersion.version, profile.currentVersion),
          ))
          .limit(1)
        : [];
      if (requiresRelease && !currentVersion) {
        throw new AgentConflictError("The current agent version is missing.");
      }
      if (requiresRelease && !currentVersion!.distributionDigest) {
        throw new AgentConflictError("Create a Profile Distribution version before standby or activation.");
      }
      if (requiresRelease) {
        const [hermesCompatibility] = await transaction
          .select({ status: componentCompatibility.status })
          .from(componentCompatibility)
          .where(eq(componentCompatibility.key, "hermes-api"))
          .limit(1);
        if (hermesCompatibility?.status !== "PASSED") {
          throw new AgentConflictError("Hermes compatibility is not passed. Use Create & activate in Hermes Profiles to run the check automatically, or run the AI services check from Deployment diagnostics.");
        }
      }
      const [catalogue] = requiresRelease
        ? await transaction
          .select({ total: count() })
          .from(modelDeployment)
          .where(and(eq(modelDeployment.workload, "AGENT"), isNotNull(modelDeployment.firstActivatedAt)))
        : [];
      const modelCatalogueCount = catalogue?.total ?? 0;
      const [modelRoute] = requiresRelease && modelCatalogueCount > 0
        ? await transaction
          .select({ id: modelDeployment.id })
          .from(modelDeployment)
          .where(and(
            eq(modelDeployment.workload, "AGENT"),
            eq(modelDeployment.modelAlias, currentVersion!.modelAlias),
            eq(modelDeployment.status, "ACTIVE"),
          ))
          .limit(1)
        : [];
      if (requiresRelease && modelCatalogueCount > 0 && !modelRoute) {
        throw new AgentConflictError(`Activate the '${currentVersion!.modelAlias}' agent model route before activating this profile.`);
      }
      const [architecture] = requiresRelease
        ? await transaction
          .select({ targetEnvironment: platformArchitectureDecision.targetEnvironment })
          .from(platformArchitectureDecision)
          .where(eq(platformArchitectureDecision.id, "global"))
          .limit(1)
        : [];
      const targetEnvironment = architecture?.targetEnvironment ?? "DEVELOPMENT";
      const requiresReleaseEvidence = state === "ACTIVE" && targetEnvironment !== "DEVELOPMENT";
      const [releaseEvidence] = requiresReleaseEvidence
        ? await transaction
          .select({ id: evaluationRun.id })
          .from(evaluationRun)
          .where(and(
            eq(evaluationRun.targetType, "AGENT"),
            eq(evaluationRun.targetReference, `agent:${profile.slug}`),
            eq(evaluationRun.targetVersion, String(profile.currentVersion)),
            eq(evaluationRun.status, "PROMOTED"),
          ))
          .limit(1)
        : [];
      if (requiresReleaseEvidence && !releaseEvidence) {
        throw new AgentConflictError(`${targetEnvironment.toLowerCase()} activation requires promoted evaluation evidence for agent:${profile.slug} version ${profile.currentVersion}. Promote the matching evaluation in Operations, or keep this installation in Development while validating the first profile.`);
      }
      await transaction
        .update(agentProfile)
        .set({ status: state, ...(requiresRelease ? { activeVersion: profile.currentVersion } : {}) })
        .where(eq(agentProfile.id, profileId));
      await transaction.insert(auditEvent).values({
        actorType: "USER", actorId: principal.id,
        action: state === "ACTIVE" ? "agent.profile_activated" : state === "STANDBY" ? "agent.profile_standby" : "agent.profile_suspended",
        resourceType: "AgentProfile", resourceId: profileId, outcome: "SUCCESS",
        metadata: {
          activeVersion: requiresRelease ? profile.currentVersion : profile.activeVersion,
          evaluationRunId: releaseEvidence?.id ?? null,
          modelRouteId: modelRoute?.id ?? null,
          targetEnvironment,
          releaseEvidenceRequired: requiresReleaseEvidence,
        },
      });
      const reloaded = await transaction.query.agentProfile.findFirst({
        where: eq(agentProfile.id, profileId),
        with: profileWith(),
      });
      if (!reloaded) throw new AgentNotFoundError();
      return storedProfile(reloaded as LoadedProfile);
    });
  }
}
