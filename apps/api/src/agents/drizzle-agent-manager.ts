import type {
  HermesRuntimeCatalogue,
  AgentMetrics,
  AgentProfile,
  AgentProfileList,
  AgentRun,
  AgentRunEvent,
  AgentRunEventList,
  AgentRunList,
  AgentRuntimeControl,
  CreateAgentProfile,
  GuardrailRule,
  SubmitAgentRun,
  UpdateAgentProfile,
  UpdateAgentRuntimeControl,
} from "@orcasynapse/contracts";
import { ADMIN_ROLES, agentSkillReferenceSchema, LOCAL_PEOPLE_GROUP } from "@orcasynapse/contracts";
import {
  agentProfile,
  agentProfileVersion,
  agentRun,
  agentRunEvent,
  agentRuntimeControl,
  agentToolGrant,
  auditEvent,
  componentCompatibility,
  governedTool,
  guardrailPolicy,
  hermesRuntimeNode,
  modelDeployment,
  platformArchitectureDecision,
  runtimeToolsetAdmission,
  serviceConnection,
  skillSet,
  toolSet,
  type OrcaSynapseDatabase,
  agentRunWakeStatement,
} from "@orcasynapse/database";
import { and, count, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { advisoryLock, isUniqueViolation } from "../database-support.js";
import { inspectInput } from "../guardrails/runtime-policy.js";
import {
  AgentConflictError,
  AgentNotFoundError,
  AgentPolicyViolationError,
  AgentRuntimeDisabledError,
  type AgentBoundaryVerifier,
  type AgentManager,
  type AgentPrincipal,
} from "./agent-manager.js";
import { profileVisibleTo } from "./profile-visibility.js";

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
  safeMode: boolean;
  createdBy: string | null;
  createdAt: Date;
  toolSetId: string | null;
  skillSetId: string | null;
}

interface StoredProfile {
  id: string;
  slug: string;
  status: AgentProfile["status"];
  currentVersion: number;
  activeVersion: number | null;
  divisionId: string | null;
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
    safeMode: configuration.safeMode,
  };
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
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
    safeMode: version.safeMode,
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
    safeMode: true as const,
    createdBy: version.createdBy,
    distributionDigest: digest,
    createdAt: version.createdAt.toISOString(),
    toolSetId: version.toolSetId,
    skillSetId: version.skillSetId,
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
    divisionId: profile.divisionId,
    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
  };
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

  /*
   * The list, and whether anything on it may execute.
   *
   * `executionEnabled` is answered here rather than composed in the route so
   * that no caller can return a profile list without it. The enterprise route
   * is the reason: it is the only agent read an `agents:use` session has, and
   * the boundary's own route is `adminOnly`, so a dashboard that could not read
   * the flag here would go back to assuming execution was on. Only the boolean
   * crosses over -- `getRuntimeControl`'s reason and operator stay on the admin
   * route that returns them.
   */
  /**
   * Settle which tool set and skill set a new version carries.
   *
   * Precedence: what the caller named, else what the previous version held,
   * else the tracking defaults. The last step is why no API caller has to know
   * these exist -- a profile created without naming them gets "everything this
   * deployment admits", which is both the friendliest default and the only safe
   * one, since a set narrower than the node's enabled toolsets makes the Hermes
   * boundary assertion throw.
   *
   * Returns a partial rather than throwing when a default is missing: a
   * database that predates the seed should not lose the ability to create
   * profiles over a column that is nullable anyway.
   */
  private async resolveSets(
    transaction: { select: OrcaSynapseDatabase["select"] },
    input: { toolSetId?: string | undefined; skillSetId?: string | undefined },
    current?: { toolSetId: string | null; skillSetId: string | null },
  ): Promise<{ toolSetId?: string; skillSetId?: string }> {
    const named = {
      toolSetId: input.toolSetId ?? current?.toolSetId ?? undefined,
      skillSetId: input.skillSetId ?? current?.skillSetId ?? undefined,
    };
    if (named.toolSetId && named.skillSetId) return { toolSetId: named.toolSetId, skillSetId: named.skillSetId };
    const [tools] = named.toolSetId ? [] : await transaction
      .select({ id: toolSet.id }).from(toolSet).where(eq(toolSet.tracksAdmission, true)).limit(1);
    const [skills] = named.skillSetId ? [] : await transaction
      .select({ id: skillSet.id }).from(skillSet).where(eq(skillSet.tracksRuntime, true)).limit(1);
    const resolvedTool = named.toolSetId ?? tools?.id;
    const resolvedSkill = named.skillSetId ?? skills?.id;
    return {
      ...(resolvedTool ? { toolSetId: resolvedTool } : {}),
      ...(resolvedSkill ? { skillSetId: resolvedSkill } : {}),
    };
  }

  /**
   * Grant the governed memory tools to a newly minted version.
   *
   * The installer seeds these grants for every version that exists at upgrade
   * time; without this, a profile created the day after would silently be the
   * only one that cannot remember anything, and an operator comparing two
   * profiles would find no setting explaining the difference.
   *
   * Permissive by default and narrowable afterwards -- see the seeder for why
   * that direction is the affordable one. Both tools are READ_ONLY and the
   * division comes from the run rather than the grant, so this widens who may
   * keep notes and never what any of them can read.
   */
  private async grantMemoryTools(
    transaction: { select: OrcaSynapseDatabase["select"]; insert: OrcaSynapseDatabase["insert"] },
    profileVersionId: string,
  ): Promise<void> {
    const tools = await transaction
      .select({ id: governedTool.id })
      .from(governedTool)
      .where(inArray(governedTool.handlerKey, ["orcasynapse.memory.remember", "orcasynapse.memory.recall"]));
    if (tools.length === 0) return;
    await transaction.insert(agentToolGrant).values(tools.map(({ id }) => ({
      profileVersionId,
      toolId: id,
      enabled: true,
      allowedGroups: [LOCAL_PEOPLE_GROUP],
      // Every role, from the one list that defines them.
      allowedAdminRoles: [...ADMIN_ROLES],
    })));
  }

  async listProfiles(principal: AgentPrincipal, includeInactive: boolean): Promise<AgentProfileList> {
    const [profiles, runtime] = await Promise.all([
      this.database.query.agentProfile.findMany({
        ...(includeInactive
          ? {}
          : { where: and(eq(agentProfile.status, "ACTIVE"), isNotNull(agentProfile.activeVersion)) }),
        with: profileWith(),
        orderBy: [desc(agentProfile.updatedAt)],
        limit: 100,
      }),
      this.getRuntimeControl(),
    ]);
    return {
      /*
       * The principal was `_principal` until increment A: this list was the
       * same for every signed-in user, so a division could never bound it.
       *
       * Filtering through the shared rule rather than adding a `where` clause
       * is deliberate. The rule is one function that both this and `submitRun`
       * consult, so the list and the gate cannot disagree -- a profile you
       * cannot run is a profile you never see named. Increment D adds the
       * division clause to that function and this narrows with it, untouched.
       */
      items: (profiles as LoadedProfile[])
        .filter((profile) => profileVisibleTo(principal, profile))
        .map((profile) => profileDto(storedProfile(profile), includeInactive)),
      executionEnabled: runtime.enabled,
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
            safeMode: input.safeMode,
            createdBy: principal.id,
            ...(await this.resolveSets(transaction, input)),
          })
          .returning();
        if (!version) throw new AgentConflictError("The agent configuration could not be created.");
        await this.grantMemoryTools(transaction, version.id);
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
        safeMode: input.safeMode ?? current.safeMode,
      };
      const [minted] = await transaction.insert(agentProfileVersion).values({
        profileId,
        version: nextVersion,
        ...nextConfiguration,
        distributionDigest: distributionDigest(nextConfiguration),
        createdBy: principal.id,
        /*
         * Carried forward from the version being superseded unless the caller
         * changes them. A version is immutable and a run must reproduce exactly
         * what it was given, so an edit that says nothing about the sets must
         * not quietly re-resolve them to whatever the defaults are today.
         */
        ...(await this.resolveSets(transaction, input, current)),
      }).returning({ id: agentProfileVersion.id });
      /*
       * A new version is a new grant target: `AgentToolGrant` hangs off the
       * version, not the profile, so an edit that mints v2 would otherwise
       * leave the agent able to remember on v1 and not on v2.
       */
      if (minted) await this.grantMemoryTools(transaction, minted.id);
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
      outputCharacterLimit?: number;
    } = {},
  ): Promise<AgentRun> {
    const runId = randomUUID();
    /*
     * The operator's guardrail, on every path that starts a run.
     *
     * Chat resolves the active policy itself -- it needs the same numbers to
     * inspect the input -- and passes the output ceiling down. A run submitted
     * directly through /api/v1/agents/runs passed nothing, so it silently took
     * the 200,000 platform ceiling while the dashboard showed the operator the
     * smaller number they had configured. A guardrail one of two callers obeys
     * is worse than an absent one, because the screen claims otherwise.
     *
     * Resolved here rather than at the route so no future caller can reintroduce
     * the gap by forgetting the option, and clamped to the platform ceiling
     * either way: the policy may lower the bound, never raise it past what the
     * worker's own accounting is built for.
     */
    const policy = await this.activePolicy();
    const outputCharacterLimit = Math.min(
      200_000,
      Math.max(1_000, options.outputCharacterLimit ?? policy.maxOutputCharacters),
    );
    /*
     * Input inspection, which this path had none of until now.
     *
     * `inspectInputText` had exactly two callers -- chat and the inference
     * gateway -- so `POST /api/v1/agents/runs` was bounded only by the
     * contract's flat 32,000 characters: no policy limit, no control-character
     * check, no credential check, no operator rule. A direct run was the way
     * around every guardrail on the deployment.
     *
     * Chat has already inspected by the time it reaches here, and inspecting
     * again is deliberate rather than wasteful. The alternative is an
     * `alreadyInspected` option, which is exactly the shape the comment above
     * rejects: a guardrail one of two callers obeys. The second pass is
     * idempotent -- redacted text matches nothing -- so it costs a scan and
     * removes a hole a future caller could reopen by forgetting a flag.
     */
    const inspection = inspectInput(input.input, policy, policy.rules);
    if (inspection.decision === "BLOCK") {
      const blocking = inspection.matches.filter(({ action }) => action === "BLOCK").map(({ label }) => label);
      await this.database.insert(auditEvent).values({
        actorType: "USER", actorId: principal.id, action: "guardrail.request_blocked",
        resourceType: "AgentRun", resourceId: runId, outcome: "FAILURE",
        // Labels and counts. Never the input -- a credential rule fires because
        // the input looked like a key, and explaining that by quoting it would
        // put the key in a trail that is retained and forwarded.
        metadata: {
          reason: inspection.reason,
          profileId: input.profileId,
          rules: inspection.matches.map(({ ruleId, label, action, count }) => ({ ruleId, label, action, count })),
        },
      }).catch(() => undefined);
      throw new AgentPolicyViolationError(blocking.length > 0
        ? `The active guardrail policy blocks this input (${blocking.join(", ")}).`
        : `The active guardrail policy blocks this input (${inspection.reason}).`);
    }
    // The redacted text is what runs, for the same reason it is what chat
    // stores: a redaction the model never sees is not a redaction.
    const guardedInput = inspection.text;
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
      /*
       * Before anything else is read, and before any runtime state is
       * disclosed: may this caller use this profile at all?
       *
       * `submitRun` previously took the caller's UUID on trust -- the row was
       * loaded and run. A profile that does not exist fell through to the
       * "only an active agent profile can accept runs" conflict below, which is
       * a 409, and a 409 confirms the UUID names something real. That is the
       * fact a division boundary exists to withhold, so it answers 404 here.
       *
       * Placed ahead of the runtime checks deliberately: a caller who may not
       * see a profile should not learn whether the runtime is up by asking
       * about it.
       */
      if (!profileVisibleTo(principal, profile)) throw new AgentNotFoundError();
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
          // The inspected text, not the submitted text. This row is what the
          // worker hands to Hermes.
          input: guardedInput,
          outputCharacterLimit,
          modelAlias: version.modelAlias,
          jobId: randomUUID(),
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

  /**
   * The whole active guardrail policy, and the fail-closed latch that goes with it.
   *
   * This replaced `activeOutputCharacterLimit`, which read one column and did
   * not latch. That asymmetry was a real hole: chat and the inference gateway
   * both refuse once *any* policy has been activated and none is currently
   * ACTIVE, while a direct agent run silently fell back to the platform
   * ceiling. So suspending the active policy tightened two paths and quietly
   * loosened the third — the opposite of what an operator suspending a policy
   * is asking for.
   *
   * `firstActivatedAt` is the latch, exactly as it is in `resolvePolicy` on the
   * chat manager: before a deployment has ever activated a policy the defaults
   * stand, and afterwards the absence of an active one is a refusal rather than
   * a default.
   */
  private async activePolicy(): Promise<{
    maxInputCharacters: number;
    maxOutputCharacters: number;
    blockControlCharacters: boolean;
    blockCredentialPatterns: boolean;
    rules: GuardrailRule[];
  }> {
    const [enforced] = await this.database
      .select({ total: sql<number>`count(*)::int` })
      .from(guardrailPolicy)
      .where(isNotNull(guardrailPolicy.firstActivatedAt));
    const catalogueEnforced = (enforced?.total ?? 0) > 0;

    const active = !catalogueEnforced ? [] : await this.database
      .select({
        maxInputCharacters: guardrailPolicy.maxInputCharacters,
        maxOutputCharacters: guardrailPolicy.maxOutputCharacters,
        blockControlCharacters: guardrailPolicy.blockControlCharacters,
        blockCredentialPatterns: guardrailPolicy.blockCredentialPatterns,
        rules: guardrailPolicy.rules,
      })
      .from(guardrailPolicy)
      .where(eq(guardrailPolicy.status, "ACTIVE"))
      .limit(2);

    if (catalogueEnforced && active.length !== 1) {
      throw new AgentConflictError(active.length === 0
        ? "Activate one guardrail policy before submitting agent runs."
        : "More than one guardrail policy is active.");
    }
    const policy = active[0];
    return {
      maxInputCharacters: policy?.maxInputCharacters ?? 32_000,
      maxOutputCharacters: policy?.maxOutputCharacters ?? 200_000,
      blockControlCharacters: policy?.blockControlCharacters ?? true,
      blockCredentialPatterns: policy?.blockCredentialPatterns ?? true,
      rules: (policy?.rules ?? []) as GuardrailRule[],
    };
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
      // True when the row is missing, matching the column default: a memory
      // that never fills is the feature not working, and a deployment that has
      // not decided yet is better served by it running.
      memoryExtractionEnabled: control?.memoryExtractionEnabled ?? true,
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
        await this.boundaryVerifier.assertAdmittedToolBoundary(await this.admittedToolsets());
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
      /*
       * Read before write, so the audit trail can say what moved.
       *
       * Without it the action is picked from `input.enabled` alone: an operator
       * turning extraction off while leaving execution running produced
       * `agent.runtime_enabled` and a metadata object mentioning only the
       * reason. True, and silent about the only thing that actually changed --
       * in the control whose entire purpose was making extraction visible.
       */
      const [before] = await transaction
        .select({ enabled: agentRuntimeControl.enabled, extraction: agentRuntimeControl.memoryExtractionEnabled })
        .from(agentRuntimeControl).where(eq(agentRuntimeControl.id, "global")).limit(1);
      // Absent matches the column defaults, which is what the first write sees.
      const wasExtracting = before?.extraction ?? true;
      const nowExtracting = input.memoryExtractionEnabled ?? wasExtracting;
      const [updated] = await transaction
        .insert(agentRuntimeControl)
        .values({
          id: "global", enabled: input.enabled, reason: input.reason, updatedBy: principal.id,
          ...(input.memoryExtractionEnabled === undefined ? {} : { memoryExtractionEnabled: input.memoryExtractionEnabled }),
        })
        .onConflictDoUpdate({
          target: agentRuntimeControl.id,
          set: {
            enabled: input.enabled, reason: input.reason, updatedBy: principal.id, updatedAt: new Date(),
            // Omitted rather than defaulted: a caller that only means to start
            // or stop runs must not silently turn extraction back on.
            ...(input.memoryExtractionEnabled === undefined ? {} : { memoryExtractionEnabled: input.memoryExtractionEnabled }),
          },
        })
        .returning();
      if (!updated) throw new AgentConflictError("The agent runtime control could not be written.");
      await transaction.insert(auditEvent).values({
        actorType: "USER", actorId: principal.id,
        action: input.enabled ? "agent.runtime_enabled" : "agent.runtime_disabled",
        resourceType: "AgentRuntimeControl", resourceId: "global", outcome: "SUCCESS",
        // Both states, not just the reason: a reader of one event should not
        // have to find the next one to know what the control was left in.
        metadata: { reason: input.reason, enabled: input.enabled, memoryExtractionEnabled: nowExtracting },
      });
      /*
       * A second event, and only when extraction actually moved.
       *
       * Its own action rather than a field on the one above, because that one
       * is written on every call -- including calls that change nothing -- so
       * an operator searching for "when did we stop reading conversations"
       * would have to diff metadata across a history of unchanged writes.
       */
      if (nowExtracting !== wasExtracting) {
        await transaction.insert(auditEvent).values({
          actorType: "USER", actorId: principal.id,
          action: nowExtracting ? "agent.memory_extraction_enabled" : "agent.memory_extraction_disabled",
          resourceType: "AgentRuntimeControl", resourceId: "global", outcome: "SUCCESS",
          metadata: { reason: input.reason },
        });
      }
      return updated;
    });
    return {
      enabled: control.enabled,
      memoryExtractionEnabled: control.memoryExtractionEnabled,
      reason: control.reason,
      updatedAt: control.updatedAt.toISOString(),
      updatedBy: control.updatedBy,
    };
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
          modelRouteId: modelRoute?.id ?? null,
          targetEnvironment,
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
