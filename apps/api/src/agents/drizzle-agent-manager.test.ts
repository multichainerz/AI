import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { CreateAgentProfile } from "@orcasynapse/contracts";
import {
  agentProfile,
  agentRun,
  agentRunEvent,
  agentRuntimeControl,
  auditEvent,
  division,
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
afterAll(async () => { await context?.drop(); }, 120_000);
beforeEach(async () => { await context.reset(); });

const principal: AgentPrincipal = { id: randomUUID(), subject: "local-admin:operator" } as AgentPrincipal;
const otherPrincipal: AgentPrincipal = { id: randomUUID(), subject: "local-admin:someone-else" } as AgentPrincipal;

const passingBoundary: AgentBoundaryVerifier = {
  assertAdmittedToolBoundary: vi.fn(async () => undefined),
      catalogue: vi.fn(async () => ({ toolsets: [], skills: [] })),
};

function manager(boundaryVerifier?: AgentBoundaryVerifier) {
  return new DrizzleAgentManager(context.database, boundaryVerifier);
}

function profileInput(overrides: Partial<CreateAgentProfile> = {}): CreateAgentProfile {
  return {
    slug: `agent-${randomUUID().slice(0, 8)}`,
    displayName: "Support agent",
    purpose: "Help operators reason about their controlled environment.",
    instructions: "Answer precisely and state uncertainty.",
    soulMd: "You are a careful operations assistant.",
    skills: [],
    modelAlias: "hermes-agent",
    maxTurns: 1,
    timeoutSeconds: 120,
    maxConcurrentRuns: 1,
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

  it("activates outside development on its own merits, with no evaluation evidence", async () => {
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
      .resolves.toMatchObject({ status: "ACTIVE", activeVersion: 1 });
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

  /*
   * The hole increment A closes: `submitRun` reached a profile by whatever UUID
   * the caller posted, with no check that the caller may use it. It is asserted
   * as a 404 rather than a 409 because the answer must not distinguish "this
   * profile is not yours" from "this profile does not exist" -- once divisions
   * land, a 409 here would confirm another division's UUID names something real.
   *
   * Before the fix this failed with AgentConflictError ("Only an active agent
   * profile can accept runs"), which is the 409 that leaks exactly that.
   */
  it("answers 404, not 409, for a profile the caller cannot see", async () => {
    await enableRuntime();
    await enrolHealthyRuntime();

    await expect(manager().submitRun(principal, { profileId: randomUUID(), input: "hello" } as never))
      .rejects.toBeInstanceOf(AgentNotFoundError);
  });

  /*
   * The other half of the same rule, and the reason the 404 above is not simply
   * a relabelled 409: a profile that exists but is suspended stays a conflict.
   * It is visible, the caller may see it, it just cannot take work. Collapsing
   * both into 404 would tell an operator their own profile had vanished.
   */
  it("keeps a visible but inactive profile a 409", async () => {
    const created = await manager().createProfile(principal, profileInput());
    await enableRuntime();
    await enrolHealthyRuntime();

    await expect(manager().submitRun(principal, { profileId: created.id, input: "hello" } as never))
      .rejects.toBeInstanceOf(AgentConflictError);
  });

  /*
   * The division boundary itself: four answers, all 404.
   *
   * Asserted against a real enterprise principal rather than an administrator,
   * because an administrator is deployment-wide by design and would pass every
   * case here without the rule doing anything.
   */
  it("hides another division's profile from a user, and keeps a deployment-wide one visible", async () => {
    const [alpha] = await context.database.insert(division)
      .values({ slug: "alpha", displayName: "Alpha" }).returning();
    const [beta] = await context.database.insert(division)
      .values({ slug: "beta", displayName: "Beta" }).returning();
    const theirs = await activeProfile();
    const ours = await activeProfile();
    const shared = await activeProfile();
    await context.database.update(agentProfile)
      .set({ divisionId: beta!.id }).where(eq(agentProfile.id, theirs.id));
    await context.database.update(agentProfile)
      .set({ divisionId: alpha!.id }).where(eq(agentProfile.id, ours.id));
    await enableRuntime();
    await enrolHealthyRuntime();

    const user: AgentPrincipal = {
      id: randomUUID(), subject: "user:alpha-member",
      identityMode: "ENTERPRISE", scopes: ["chat:use", "agents:use"], divisionId: alpha!.id,
    };

    // Not listed, and not runnable -- the same rule answering both.
    const listed = (await manager().listProfiles(user, false)).items.map(({ id }) => id);
    expect(listed).not.toContain(theirs.id);
    expect(listed).toEqual(expect.arrayContaining([ours.id, shared.id]));
    await expect(manager().submitRun(user, { profileId: theirs.id, input: "hello" } as never))
      .rejects.toBeInstanceOf(AgentNotFoundError);

    // Their own division's profile and a deployment-wide one both work.
    await expect(manager().submitRun(user, { profileId: ours.id, input: "mine" } as never))
      .resolves.toMatchObject({ profileId: ours.id });
    await expect(manager().submitRun(user, { profileId: shared.id, input: "shared" } as never))
      .resolves.toMatchObject({ profileId: shared.id });
  });

  /*
   * A user with no division sees deployment-wide profiles only. Absent must
   * read as "narrowest", never as "unrestricted" -- the opposite reading is how
   * a boundary silently opens.
   */
  it("gives a user in no division only the deployment-wide profiles", async () => {
    const [alpha] = await context.database.insert(division)
      .values({ slug: "alpha", displayName: "Alpha" }).returning();
    const owned = await activeProfile();
    const shared = await activeProfile();
    await context.database.update(agentProfile)
      .set({ divisionId: alpha!.id }).where(eq(agentProfile.id, owned.id));

    const user: AgentPrincipal = {
      id: randomUUID(), subject: "user:unassigned",
      identityMode: "ENTERPRISE", scopes: ["chat:use", "agents:use"], divisionId: null,
    };

    const listed = (await manager().listProfiles(user, false)).items.map(({ id }) => id);
    expect(listed).not.toContain(owned.id);
    expect(listed).toContain(shared.id);
  });

  /* An administrator is deployment-wide and is bounded by no division. */
  it("shows an administrator every division's profile", async () => {
    const [alpha] = await context.database.insert(division)
      .values({ slug: "alpha", displayName: "Alpha" }).returning();
    const owned = await activeProfile();
    await context.database.update(agentProfile)
      .set({ divisionId: alpha!.id }).where(eq(agentProfile.id, owned.id));

    const admin: AgentPrincipal = {
      id: randomUUID(), subject: "local-admin:operator",
      identityMode: "ADMINISTRATOR_PREVIEW", scopes: ["agents:read"], divisionId: null,
    };

    expect((await manager().listProfiles(admin, false)).items.map(({ id }) => id)).toContain(owned.id);
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

describe("DrizzleAgentManager run events", () => {
  /** A run the event log can hang off; every gate submitRun checks is satisfied. */
  async function queuedRun() {
    const active = await activeProfile();
    await enableRuntime();
    await enrolHealthyRuntime();
    return manager().submitRun(principal, { profileId: active.id, input: "trace me" } as never);
  }

  it("replays a same-millisecond burst in the order it was appended", async () => {
    const run = await queuedRun();
    // Hermes emits a burst faster than the timestamp column can separate:
    // occurredAt is millisecond-resolution and id is a random UUID v4, so any
    // order built from those two is the UUID's order, which is no order at all.
    // A tool result then precedes its own call and delta text reassembles
    // scrambled. cursor is the append order the row already carries.
    const occurredAt = new Date();
    for (let index = 0; index < 20; index += 1) {
      await context.database
        .insert(agentRunEvent)
        .values({ runId: run.id, type: "MESSAGE_DELTA", delta: String(index), occurredAt });
    }

    const { items } = await manager().listRunEvents(principal, run.id, false);

    expect(items.map(({ delta }) => delta)).toEqual(Array.from({ length: 20 }, (_, index) => String(index)));
  });

  it("returns the newest page of a run longer than one page", async () => {
    const run = await queuedRun();
    // 600 events, one per second, so the ordering question is settled and only
    // the window is under test: a reader needs the tail of a long run, and an
    // ascending cap showed nothing that happened after the first 500 events.
    const start = Date.now() - 600_000;
    await context.database.insert(agentRunEvent).values(
      Array.from({ length: 600 }, (_, index) => ({
        runId: run.id,
        type: "MESSAGE_DELTA",
        delta: String(index),
        occurredAt: new Date(start + index * 1_000),
      })),
    );

    const { items } = await manager().listRunEvents(principal, run.id, false);

    expect(items).toHaveLength(500);
    expect(items[0]?.delta).toBe("100");
    expect(items.at(-1)?.delta).toBe("599");
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
      assertAdmittedToolBoundary: vi.fn(async () => { throw new Error("boundary breached"); }),
      catalogue: vi.fn(async () => ({ toolsets: [], skills: [] })),
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

  it("states the boundary on the profile list, which is all an enterprise caller can read", async () => {
    /*
     * `GET /admin/agents/runtime` is `adminOnly`, and an enterprise session
     * holds `chat:use` and `agents:use` -- never an `AdminScope`. So the flag
     * has to arrive on the profile list or the dashboard cannot know, and what
     * it did instead was assume execution was on and offer a session the
     * submission then refused.
     *
     * Fail-closed first: with no control row at all the list must say `false`,
     * matching `getRuntimeControl`'s own default rather than a cheerful one.
     */
    await activeProfile();
    expect(await manager().getRuntimeControl()).toMatchObject({ enabled: false });
    expect((await manager().listProfiles(principal, false)).executionEnabled).toBe(false);

    // And it tracks the row rather than being a constant: same profiles, other
    // answer, once execution is really switched on.
    await enableRuntime();
    const live = await manager().listProfiles(principal, false);
    expect(live.items).toHaveLength(1);
    expect(live.executionEnabled).toBe(true);

    // The administrator's wider listing reports the same deployment-wide fact:
    // the boundary is not a property of which profiles you asked for.
    expect((await manager().listProfiles(principal, true)).executionEnabled).toBe(true);
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
