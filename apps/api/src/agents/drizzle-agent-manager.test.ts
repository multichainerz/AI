import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { CreateAgentProfile } from "@orcasynapse/contracts";
import {
  agentProfile,
  agentRun,
  agentRuntimeControl,
  auditEvent,
  componentCompatibility,
  createTestDatabase,
  hermesRuntimeNode,
  platformArchitectureDecision,
  serviceConnection,
  type TestDatabase,
} from "@orcasynapse/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DrizzleAgentManager } from "./drizzle-agent-manager.js";
import {
  AgentConflictError,
  AgentNotFoundError,
  AgentRuntimeDisabledError,
  type AgentBoundaryVerifier,
  type AgentPrincipal,
} from "./agent-manager.js";

let context: TestDatabase;

beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); });
beforeEach(async () => { await context.reset(); });

const principal: AgentPrincipal = { id: randomUUID(), subject: "local-admin:operator" } as AgentPrincipal;
const otherPrincipal: AgentPrincipal = { id: randomUUID(), subject: "local-admin:someone-else" } as AgentPrincipal;

const passingBoundary: AgentBoundaryVerifier = {
  assertZeroToolBoundary: vi.fn(async () => undefined),
  assertGovernedToolBoundary: vi.fn(async () => undefined),
};

function manager(boundaryVerifier?: AgentBoundaryVerifier) {
  return new DrizzleAgentManager(context.database, boundaryVerifier);
}

function profileInput(overrides: Partial<CreateAgentProfile> = {}): CreateAgentProfile {
  return {
    slug: `agent-${randomUUID().slice(0, 8)}`,
    displayName: "Support agent",
    purpose: "Answer operator questions from approved knowledge.",
    instructions: "Answer only from the supplied knowledge sources.",
    soulMd: "You are a careful operations assistant.",
    skills: [],
    modelAlias: "hermes-agent",
    maxTurns: 1,
    timeoutSeconds: 120,
    maxConcurrentRuns: 1,
    allowPrivateKnowledge: false,
    safeMode: true,
    ...overrides,
  } as CreateAgentProfile;
}

/** Satisfies every release gate activation checks before it flips a profile live. */
async function allowActivation() {
  await context.database
    .insert(componentCompatibility)
    .values({
      key: "hermes-api",
      displayName: "Hermes API",
      category: "AI_SERVICES",
      expectedContract: "Hermes agent API",
      status: "PASSED",
    })
    .onConflictDoUpdate({ target: componentCompatibility.key, set: { status: "PASSED" } });
}

/** Enrols exactly one online, healthy runtime, which submitRun requires. */
async function enrolHealthyRuntime(overrides: Record<string, unknown> = {}) {
  const [connection] = await context.database
    .insert(serviceConnection)
    .values({
      slug: `hermes-${randomUUID().slice(0, 8)}`,
      displayName: "Hermes",
      kind: "HERMES",
      environment: "DEVELOPMENT",
      enabled: true,
      status: "HEALTHY",
      baseUrl: "https://hermes.internal",
      configuration: {},
    })
    .returning({ id: serviceConnection.id });
  await context.database.insert(hermesRuntimeNode).values({
    slug: `node-${randomUUID().slice(0, 8)}`,
    displayName: "VM2",
    baseUrl: "https://hermes.internal",
    status: "ONLINE",
    enrolledAt: new Date(),
    lastSeenAt: new Date(),
    serviceConnectionId: connection!.id,
    ...overrides,
  });
}

async function enableRuntime() {
  await context.database
    .insert(agentRuntimeControl)
    .values({ id: "global", enabled: true, reason: "Enabled for tests", updatedBy: principal.id })
    .onConflictDoUpdate({ target: agentRuntimeControl.id, set: { enabled: true } });
}

/** Creates a profile and takes it all the way to ACTIVE. */
async function activeProfile(overrides: Partial<CreateAgentProfile> = {}) {
  const created = await manager().createProfile(principal, profileInput(overrides));
  await allowActivation();
  return manager().activateProfile(principal, created.id);
}

describe("DrizzleAgentManager profiles", () => {
  it("creates a profile with its first version and a reproducible distribution digest", async () => {
    const input = profileInput();

    const created = await manager().createProfile(principal, input);

    expect(created).toMatchObject({ slug: input.slug, status: "DRAFT", currentVersion: 1, activeVersion: null });
    expect(created.version.distributionDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(created.activeVersionConfiguration).toBeNull();

    // The digest is a pure function of the configuration, so an identical
    // profile under a different slug must produce the same digest.
    const twin = await manager().createProfile(principal, profileInput({ ...input, slug: `${input.slug}-twin` }));
    expect(twin.version.distributionDigest).toBe(created.version.distributionDigest);
  });

  it("rejects a duplicate slug as a conflict", async () => {
    const input = profileInput();
    await manager().createProfile(principal, input);

    await expect(manager().createProfile(principal, input)).rejects.toBeInstanceOf(AgentConflictError);
  });

  it("appends an immutable version instead of editing the current one", async () => {
    const created = await manager().createProfile(principal, profileInput());

    const updated = await manager().updateProfile(principal, created.id, { displayName: "Renamed agent" } as never);

    expect(updated.currentVersion).toBe(2);
    expect(updated.version.displayName).toBe("Renamed agent");
    // Changing the configuration must change the digest.
    expect(updated.version.distributionDigest).not.toBe(created.version.distributionDigest);
    // Version 1 is still on record, unchanged.
    const listed = await manager().listProfiles(principal, true);
    expect(listed.items.find(({ id }) => id === created.id)?.currentVersion).toBe(2);
  });

  it("reports a missing profile distinctly", async () => {
    await expect(manager().updateProfile(principal, randomUUID(), {} as never))
      .rejects.toBeInstanceOf(AgentNotFoundError);
    await expect(manager().activateProfile(principal, randomUUID()))
      .rejects.toBeInstanceOf(AgentNotFoundError);
  });

  it("refuses activation until Hermes compatibility has passed", async () => {
    const created = await manager().createProfile(principal, profileInput());

    await expect(manager().activateProfile(principal, created.id)).rejects.toBeInstanceOf(AgentConflictError);

    await allowActivation();
    const activated = await manager().activateProfile(principal, created.id);
    expect(activated).toMatchObject({ status: "ACTIVE", activeVersion: 1 });
    expect(activated.activeVersionConfiguration?.version).toBe(1);
  });

  it("requires promoted evaluation evidence outside development", async () => {
    const created = await manager().createProfile(principal, profileInput());
    await allowActivation();
    await context.database
      .insert(platformArchitectureDecision)
      .values({ id: "global", targetEnvironment: "PRODUCTION" })
      .onConflictDoUpdate({
        target: platformArchitectureDecision.id,
        set: { targetEnvironment: "PRODUCTION" },
      });

    await expect(manager().activateProfile(principal, created.id))
      .rejects.toThrow(/promoted evaluation evidence/);
    // Standby is not a release into the target environment, so it stays open.
    await expect(manager().standbyProfile(principal, created.id)).resolves.toMatchObject({ status: "STANDBY" });
  });

  it("leaves the active version pinned when a profile is suspended", async () => {
    const active = await activeProfile();

    const suspended = await manager().suspendProfile(principal, active.id);

    expect(suspended.status).toBe("SUSPENDED");
    expect(suspended.activeVersion).toBe(1);
  });

  it("hides profiles that are not released from the default listing", async () => {
    await manager().createProfile(principal, profileInput());
    const active = await activeProfile();

    expect((await manager().listProfiles(principal, false)).items.map(({ id }) => id)).toEqual([active.id]);
    expect((await manager().listProfiles(principal, true)).items).toHaveLength(2);
  });
});

describe("DrizzleAgentManager runs", () => {
  it("refuses to queue work while the runtime control is disabled", async () => {
    const active = await activeProfile();
    await enrolHealthyRuntime();

    await expect(manager().submitRun(principal, { profileId: active.id, input: "hello" } as never))
      .rejects.toBeInstanceOf(AgentRuntimeDisabledError);
  });

  it("refuses to queue work when no healthy runtime is enrolled", async () => {
    const active = await activeProfile();
    await enableRuntime();

    await expect(manager().submitRun(principal, { profileId: active.id, input: "hello" } as never))
      .rejects.toThrow(/online, recently observed, and healthy/);
  });

  it("names the reason when the enrolled runtime is draining", async () => {
    const active = await activeProfile();
    await enableRuntime();
    await enrolHealthyRuntime({ status: "DRAINING" });

    await expect(manager().submitRun(principal, { profileId: active.id, input: "hello" } as never))
      .rejects.toThrow(/draining/);
  });

  it("refuses to queue work against a stale heartbeat", async () => {
    const active = await activeProfile();
    await enableRuntime();
    await enrolHealthyRuntime({ lastSeenAt: new Date(Date.now() - 10 * 60 * 1_000) });

    await expect(manager().submitRun(principal, { profileId: active.id, input: "hello" } as never))
      .rejects.toBeInstanceOf(AgentRuntimeDisabledError);
  });

  it("queues a run pinned to the active version and its distribution digest", async () => {
    const active = await activeProfile();
    await enableRuntime();
    await enrolHealthyRuntime();

    const run = await manager().submitRun(principal, { profileId: active.id, input: "inspect the runtime" } as never);

    expect(run).toMatchObject({
      profileId: active.id,
      profileSlug: active.slug,
      profileVersion: 1,
      status: "QUEUED",
      input: "inspect the runtime",
    });
    expect(run.profileDistributionDigest).toBe(active.version.distributionDigest);
    // The run must carry the version's model alias, not a caller-supplied one.
    expect(run.modelAlias).toBe("hermes-agent");
  });

  it("enforces the configured concurrent-run limit", async () => {
    const active = await activeProfile({ maxConcurrentRuns: 1 });
    await enableRuntime();
    await enrolHealthyRuntime();
    await manager().submitRun(principal, { profileId: active.id, input: "first" } as never);

    await expect(manager().submitRun(principal, { profileId: active.id, input: "second" } as never))
      .rejects.toThrow(/concurrent-run limit/);
  });

  it("refuses to queue work against a profile that is not active", async () => {
    const created = await manager().createProfile(principal, profileInput());
    await enableRuntime();
    await enrolHealthyRuntime();

    await expect(manager().submitRun(principal, { profileId: created.id, input: "hello" } as never))
      .rejects.toThrow(/active agent profile/);
  });

  it("scopes run visibility to the requesting owner unless the caller may see all", async () => {
    const active = await activeProfile();
    await enableRuntime();
    await enrolHealthyRuntime();
    const run = await manager().submitRun(principal, { profileId: active.id, input: "mine" } as never);

    expect((await manager().listRuns(otherPrincipal, false)).items).toHaveLength(0);
    expect((await manager().listRuns(otherPrincipal, true)).items).toHaveLength(1);
    await expect(manager().getRun(otherPrincipal, run.id, false)).rejects.toBeInstanceOf(AgentNotFoundError);
    await expect(manager().getRun(otherPrincipal, run.id, true)).resolves.toMatchObject({ id: run.id });
    await expect(manager().listRunEvents(otherPrincipal, run.id, false))
      .rejects.toBeInstanceOf(AgentNotFoundError);
  });

  it("requests cancellation only for work that is still in flight", async () => {
    const active = await activeProfile();
    await enableRuntime();
    await enrolHealthyRuntime();
    const run = await manager().submitRun(principal, { profileId: active.id, input: "mine" } as never);

    const cancelled = await manager().cancelRun(principal, run.id, false);
    expect(cancelled.status).toBe("CANCEL_REQUESTED");

    await context.database.update(agentRun).set({ status: "COMPLETED" }).where(eq(agentRun.id, run.id));
    await expect(manager().cancelRun(principal, run.id, false)).rejects.toBeInstanceOf(AgentConflictError);
    await expect(manager().cancelRun(principal, randomUUID(), false)).rejects.toBeInstanceOf(AgentNotFoundError);
  });

  it("counts profiles and runs by their governed state", async () => {
    const active = await activeProfile();
    await manager().createProfile(principal, profileInput());
    await enableRuntime();
    await enrolHealthyRuntime();
    await manager().submitRun(principal, { profileId: active.id, input: "mine" } as never);

    const metrics = await manager().metrics();

    expect(metrics).toMatchObject({ profiles: 2, activeProfiles: 1, queuedRuns: 1, runningRuns: 0 });
  });
});

describe("DrizzleAgentManager runtime control", () => {
  it("denies execution fail-closed when the control row is missing", async () => {
    expect(await manager().getRuntimeControl()).toMatchObject({
      enabled: false,
      reason: "Runtime control is missing; execution is denied fail-closed.",
    });
  });

  it("refuses to enable execution without a boundary verifier", async () => {
    await expect(manager().updateRuntimeControl(principal, { enabled: true, reason: "go" } as never))
      .rejects.toBeInstanceOf(AgentRuntimeDisabledError);
  });

  it("records a denial when Hermes fails the boundary check", async () => {
    const failing: AgentBoundaryVerifier = {
      assertZeroToolBoundary: vi.fn(async () => { throw new Error("boundary breached"); }),
      assertGovernedToolBoundary: vi.fn(async () => undefined),
    };

    await expect(manager(failing).updateRuntimeControl(principal, { enabled: true, reason: "go" } as never))
      .rejects.toBeInstanceOf(AgentRuntimeDisabledError);

    const denials = (await context.database.select().from(auditEvent))
      .filter(({ action }) => action === "agent.runtime_enable_denied");
    expect(denials).toHaveLength(1);
    expect(denials[0]?.outcome).toBe("FAILURE");
    // The control row must not have been created by a denied attempt.
    expect(await manager().getRuntimeControl()).toMatchObject({ enabled: false });
  });

  it("enables and disables execution through the same upsert", async () => {
    const enabled = await manager(passingBoundary)
      .updateRuntimeControl(principal, { enabled: true, reason: "First release" } as never);
    expect(enabled).toMatchObject({ enabled: true, reason: "First release", updatedBy: principal.id });

    const disabled = await manager(passingBoundary)
      .updateRuntimeControl(principal, { enabled: false, reason: "Maintenance" } as never);
    expect(disabled).toMatchObject({ enabled: false, reason: "Maintenance" });

    expect(await manager().getRuntimeControl()).toMatchObject({ enabled: false, reason: "Maintenance" });
    expect(await context.database.select().from(agentRuntimeControl)).toHaveLength(1);
  });
});

describe("DrizzleAgentManager audit trail", () => {
  it("records every governed transition", async () => {
    const created = await manager().createProfile(principal, profileInput());
    await manager().updateProfile(principal, created.id, { displayName: "Renamed" } as never);
    await allowActivation();
    await manager().activateProfile(principal, created.id);
    await manager().suspendProfile(principal, created.id);

    const actions = (await context.database.select().from(auditEvent))
      .filter(({ resourceType }) => resourceType === "AgentProfile")
      .map(({ action }) => action);
    expect(actions).toEqual(expect.arrayContaining([
      "agent.profile_created",
      "agent.profile_version_created",
      "agent.profile_activated",
      "agent.profile_suspended",
    ]));

    const [stored] = await context.database
      .select({ status: agentProfile.status })
      .from(agentProfile)
      .where(eq(agentProfile.id, created.id));
    expect(stored?.status).toBe("SUSPENDED");
  });
});
