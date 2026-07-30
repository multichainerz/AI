import type {
  AgentCapability,
  AgentMetrics,
  AgentProfile,
  AgentProfileList,
  AgentRun,
  AgentRunList,
  AgentRuntimeControl,
  CreateAgentProfile,
  KnowledgeSource,
  SubmitAgentRun,
  UpdateAgentProfile,
  UpdateAgentRuntimeControl,
} from "@aihub/contracts";
import { agentCapabilitySchema, knowledgeSourceSchema } from "@aihub/contracts";
import { Prisma, type AIHubPrismaClient } from "@aihub/database";
import type { PgBossQueueService } from "@aihub/jobs";
import {
  AgentConflictError,
  AgentNotFoundError,
  AgentQueueUnavailableError,
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
  modelAlias: string;
  maxTurns: number;
  timeoutSeconds: number;
  maxConcurrentRuns: number;
  allowPrivateKnowledge: boolean;
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
  status: AgentRun["status"];
  input: string;
  output: string | null;
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
  version: { displayName: string };
}

function versionDto(version: StoredVersion) {
  if (version.maxTurns !== 1 || version.safeMode !== true) {
    throw new AgentConflictError("The agent version does not satisfy the Phase 5 safe-mode boundary.");
  }
  return {
    id: version.id,
    version: version.version,
    displayName: version.displayName,
    purpose: version.purpose,
    instructions: version.instructions,
    modelAlias: version.modelAlias,
    maxTurns: 1 as const,
    timeoutSeconds: version.timeoutSeconds,
    maxConcurrentRuns: version.maxConcurrentRuns,
    allowPrivateKnowledge: version.allowPrivateKnowledge,
    safeMode: true as const,
    createdBy: version.createdBy,
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
    status: run.status,
    input: run.input,
    output: run.output,
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

const profileInclude = {
  versions: { orderBy: { version: "desc" as const } },
} as const;
const runInclude = {
  profile: { select: { slug: true } },
  version: { select: { displayName: true } },
} as const;

export class PrismaAgentManager implements AgentManager {
  constructor(
    private readonly prisma: AIHubPrismaClient,
    private readonly queue: PgBossQueueService,
    private readonly boundaryVerifier?: AgentBoundaryVerifier,
  ) {}

  async listProfiles(_principal: AgentPrincipal, includeInactive: boolean): Promise<AgentProfileList> {
    const profiles = await this.prisma.agentProfile.findMany({
      ...(includeInactive ? {} : { where: { status: "ACTIVE" as const, activeVersion: { not: null } } }),
      include: profileInclude,
      orderBy: { updatedAt: "desc" },
      take: 100,
    });
    return { items: profiles.map((profile) => profileDto(profile as StoredProfile, includeInactive)) };
  }

  async createProfile(principal: AgentPrincipal, input: CreateAgentProfile): Promise<AgentProfile> {
    let created: StoredProfile;
    try {
      created = await this.prisma.$transaction(async (transaction) => {
      const profile = await transaction.agentProfile.create({
        data: {
          slug: input.slug,
          versions: {
            create: {
              version: 1,
              displayName: input.displayName,
              purpose: input.purpose,
              instructions: input.instructions,
              modelAlias: input.modelAlias,
              maxTurns: input.maxTurns,
              timeoutSeconds: input.timeoutSeconds,
              maxConcurrentRuns: input.maxConcurrentRuns,
              allowPrivateKnowledge: input.allowPrivateKnowledge,
              safeMode: input.safeMode,
              createdBy: principal.id,
            },
          },
        },
        include: profileInclude,
      }) as StoredProfile;
      await transaction.auditEvent.create({ data: {
        actorType: "USER", actorId: principal.id, action: "agent.profile_created",
        resourceType: "AgentProfile", resourceId: profile.id, outcome: "SUCCESS",
        metadata: { slug: input.slug, version: 1 },
      } });
      return profile;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new AgentConflictError("An agent profile already uses this slug.");
      }
      throw error;
    }
    return profileDto(created, true);
  }

  async updateProfile(principal: AgentPrincipal, profileId: string, input: UpdateAgentProfile): Promise<AgentProfile> {
    const updated = await this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`aihub-agent-profile:${profileId}`}, 0))`;
      const profile = await transaction.agentProfile.findUnique({
        where: { id: profileId },
      });
      if (!profile) throw new AgentNotFoundError();
      const current = await transaction.agentProfileVersion.findUnique({
        where: { profileId_version: { profileId, version: profile.currentVersion } },
      });
      if (!current) throw new AgentConflictError("The current agent configuration is missing.");
      const nextVersion = profile.currentVersion + 1;
      await transaction.agentProfileVersion.create({ data: {
        profileId,
        version: nextVersion,
        displayName: input.displayName ?? current.displayName,
        purpose: input.purpose ?? current.purpose,
        instructions: input.instructions ?? current.instructions,
        modelAlias: input.modelAlias ?? current.modelAlias,
        maxTurns: input.maxTurns ?? current.maxTurns,
        timeoutSeconds: input.timeoutSeconds ?? current.timeoutSeconds,
        maxConcurrentRuns: input.maxConcurrentRuns ?? current.maxConcurrentRuns,
        allowPrivateKnowledge: input.allowPrivateKnowledge ?? current.allowPrivateKnowledge,
        safeMode: input.safeMode ?? current.safeMode,
        createdBy: principal.id,
      } });
      await transaction.agentProfile.update({ where: { id: profileId }, data: { currentVersion: nextVersion } });
      await transaction.auditEvent.create({ data: {
        actorType: "USER", actorId: principal.id, action: "agent.profile_version_created",
        resourceType: "AgentProfile", resourceId: profileId, outcome: "SUCCESS",
        metadata: { version: nextVersion, changedFields: Object.keys(input) },
      } });
      return transaction.agentProfile.findUniqueOrThrow({ where: { id: profileId }, include: profileInclude });
    });
    return profileDto(updated as StoredProfile, true);
  }

  async activateProfile(principal: AgentPrincipal, profileId: string): Promise<AgentProfile> {
    const updated = await this.changeProfileState(principal, profileId, "ACTIVE");
    return profileDto(updated, true);
  }

  async suspendProfile(principal: AgentPrincipal, profileId: string): Promise<AgentProfile> {
    const updated = await this.changeProfileState(principal, profileId, "SUSPENDED");
    return profileDto(updated, true);
  }

  async listRuns(principal: AgentPrincipal, includeAll: boolean): Promise<AgentRunList> {
    const runs = await this.prisma.agentRun.findMany({
      ...(includeAll ? {} : { where: { ownerSubject: principal.subject } }),
      include: runInclude,
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    return { items: runs.map((run) => runDto(run as StoredRun)) };
  }

  async getRun(principal: AgentPrincipal, runId: string, includeAll: boolean): Promise<AgentRun> {
    const run = await this.prisma.agentRun.findFirst({
      where: { id: runId, ...(includeAll ? {} : { ownerSubject: principal.subject }) },
      include: runInclude,
    });
    if (!run) throw new AgentNotFoundError();
    return runDto(run as StoredRun);
  }

  async submitRun(principal: AgentPrincipal, input: SubmitAgentRun): Promise<AgentRun> {
    const run = await this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`aihub-agent-submit:${input.profileId}`}, 0))`;
      const [control, profile] = await Promise.all([
        transaction.agentRuntimeControl.findUnique({ where: { id: "global" } }),
        transaction.agentProfile.findUnique({ where: { id: input.profileId } }),
      ]);
      if (!control?.enabled) throw new AgentRuntimeDisabledError(control?.reason ?? undefined);
      if (!profile || profile.status !== "ACTIVE" || profile.activeVersion === null) {
        throw new AgentConflictError("Only an active agent profile can accept runs.");
      }
      const version = await transaction.agentProfileVersion.findUnique({
        where: { profileId_version: { profileId: profile.id, version: profile.activeVersion } },
      });
      if (!version) throw new AgentConflictError("The active agent configuration is missing.");
      const activeRuns = await transaction.agentRun.count({
        where: { profileId: profile.id, status: { in: ["QUEUED", "RUNNING", "CANCEL_REQUESTED"] } },
      });
      if (activeRuns >= version.maxConcurrentRuns) {
        throw new AgentConflictError("This agent has reached its configured concurrent-run limit.");
      }
      const created = await transaction.agentRun.create({
        data: {
          profileId: profile.id,
          profileVersionId: version.id,
          profileVersion: version.version,
          ownerSubject: principal.subject,
          requestedBy: principal.id,
          input: input.input,
          effectiveCapabilities: version.allowPrivateKnowledge ? ["knowledge:private:read"] : [],
        },
        include: runInclude,
      });
      await transaction.auditEvent.create({ data: {
        actorType: "USER", actorId: principal.id, action: "agent.run_queued",
        resourceType: "AgentRun", resourceId: created.id, outcome: "SUCCESS",
        metadata: { profileId: profile.id, profileVersion: version.version },
      } });
      return created;
    });
    try {
      const jobId = await this.queue.sendAgentRun({ runId: run.id });
      const queued = await this.prisma.agentRun.update({ where: { id: run.id }, data: { jobId }, include: runInclude });
      return runDto(queued as StoredRun);
    } catch (error) {
      await this.prisma.agentRun.update({
        where: { id: run.id },
        data: { status: "FAILED", failureCode: "QUEUE_UNAVAILABLE", failureMessage: "AIHub could not enqueue the agent run.", completedAt: new Date() },
      });
      throw new AgentQueueUnavailableError();
    }
  }

  async cancelRun(principal: AgentPrincipal, runId: string, includeAll: boolean): Promise<AgentRun> {
    const changed = await this.prisma.agentRun.updateMany({
      where: { id: runId, ...(includeAll ? {} : { ownerSubject: principal.subject }), status: { in: ["QUEUED", "RUNNING"] } },
      data: { status: "CANCEL_REQUESTED" },
    });
    if (changed.count !== 1) {
      const existing = await this.prisma.agentRun.findFirst({ where: { id: runId, ...(includeAll ? {} : { ownerSubject: principal.subject }) } });
      if (!existing) throw new AgentNotFoundError();
      throw new AgentConflictError("Only queued or running agent work can be cancelled.");
    }
    await this.prisma.auditEvent.create({ data: {
      actorType: "USER", actorId: principal.id, action: "agent.run_cancel_requested",
      resourceType: "AgentRun", resourceId: runId, outcome: "SUCCESS",
    } });
    return this.getRun(principal, runId, includeAll);
  }

  async getRuntimeControl(): Promise<AgentRuntimeControl> {
    const control = await this.prisma.agentRuntimeControl.findUnique({ where: { id: "global" } });
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
        const toolControl = await this.prisma.toolRuntimeControl.findUnique({ where: { id: "global" } });
        if (toolControl?.enabled) await this.boundaryVerifier.assertGovernedToolBoundary();
        else await this.boundaryVerifier.assertZeroToolBoundary();
      } catch {
        await this.prisma.auditEvent.create({ data: {
          actorType: "USER", actorId: principal.id, action: "agent.runtime_enable_denied",
          resourceType: "AgentRuntimeControl", resourceId: "global", outcome: "FAILURE",
          metadata: { reason: input.reason, failureCode: "HERMES_BOUNDARY_VERIFICATION_FAILED" },
        } });
        throw new AgentRuntimeDisabledError("Hermes failed the authenticated execution-boundary check; execution remains disabled.");
      }
    }
    const control = await this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.agentRuntimeControl.upsert({
        where: { id: "global" },
        create: { id: "global", enabled: input.enabled, reason: input.reason, updatedBy: principal.id },
        update: { enabled: input.enabled, reason: input.reason, updatedBy: principal.id },
      });
      await transaction.auditEvent.create({ data: {
        actorType: "USER", actorId: principal.id,
        action: input.enabled ? "agent.runtime_enabled" : "agent.runtime_disabled",
        resourceType: "AgentRuntimeControl", resourceId: "global", outcome: "SUCCESS",
        metadata: { reason: input.reason },
      } });
      return updated;
    });
    return { enabled: control.enabled, reason: control.reason, updatedAt: control.updatedAt.toISOString(), updatedBy: control.updatedBy };
  }

  async metrics(): Promise<AgentMetrics> {
    const [profiles, runs] = await Promise.all([
      this.prisma.agentProfile.groupBy({ by: ["status"], _count: { _all: true } }),
      this.prisma.agentRun.groupBy({ by: ["status"], _count: { _all: true } }),
    ]);
    const profileCount = (status?: string) => profiles.filter((item) => !status || item.status === status).reduce((sum, item) => sum + item._count._all, 0);
    const runCount = (statuses: string[]) => runs.filter((item) => statuses.includes(item.status)).reduce((sum, item) => sum + item._count._all, 0);
    return {
      generatedAt: new Date().toISOString(), profiles: profileCount(), activeProfiles: profileCount("ACTIVE"),
      queuedRuns: runCount(["QUEUED"]), runningRuns: runCount(["RUNNING", "CANCEL_REQUESTED"]),
      completedRuns: runCount(["COMPLETED"]), failedRuns: runCount(["FAILED", "TIMED_OUT", "DENIED"]),
    };
  }

  private async changeProfileState(
    principal: AgentPrincipal,
    profileId: string,
    state: "ACTIVE" | "SUSPENDED",
  ): Promise<StoredProfile> {
    return this.prisma.$transaction(async (transaction) => {
      const profile = await transaction.agentProfile.findUnique({ where: { id: profileId } });
      if (!profile) throw new AgentNotFoundError();
      const currentVersion = state === "ACTIVE" ? await transaction.agentProfileVersion.findUnique({
        where: { profileId_version: { profileId, version: profile.currentVersion } },
        select: { modelAlias: true },
      }) : null;
      if (state === "ACTIVE" && !currentVersion) {
        throw new AgentConflictError("The current agent version is missing.");
      }
      const modelCatalogueCount = state === "ACTIVE"
        ? await transaction.modelDeployment.count({ where: { workload: "AGENT", firstActivatedAt: { not: null } } })
        : 0;
      const modelRoute = state === "ACTIVE" && modelCatalogueCount > 0 ? await transaction.modelDeployment.findFirst({
        where: { workload: "AGENT", modelAlias: currentVersion!.modelAlias, status: "ACTIVE" },
        select: { id: true },
      }) : null;
      if (state === "ACTIVE" && modelCatalogueCount > 0 && !modelRoute) {
        throw new AgentConflictError(`Activate the '${currentVersion!.modelAlias}' agent model route before activating this profile.`);
      }
      const releaseEvidence = state === "ACTIVE" ? await transaction.evaluationRun.findFirst({
        where: {
          targetType: "AGENT",
          targetReference: `agent:${profile.slug}`,
          targetVersion: String(profile.currentVersion),
          status: "PROMOTED",
        },
        select: { id: true },
      }) : null;
      if (state === "ACTIVE" && !releaseEvidence) {
        throw new AgentConflictError(`Agent activation requires promoted evaluation evidence for agent:${profile.slug} version ${profile.currentVersion}.`);
      }
      const updated = await transaction.agentProfile.update({
        where: { id: profileId },
        data: { status: state, ...(state === "ACTIVE" ? { activeVersion: profile.currentVersion } : {}) },
        include: profileInclude,
      });
      await transaction.auditEvent.create({ data: {
        actorType: "USER", actorId: principal.id,
        action: state === "ACTIVE" ? "agent.profile_activated" : "agent.profile_suspended",
        resourceType: "AgentProfile", resourceId: profileId, outcome: "SUCCESS",
        metadata: {
          activeVersion: state === "ACTIVE" ? profile.currentVersion : profile.activeVersion,
          evaluationRunId: releaseEvidence?.id ?? null,
          modelRouteId: modelRoute?.id ?? null,
        },
      } });
      return updated as StoredProfile;
    });
  }
}
