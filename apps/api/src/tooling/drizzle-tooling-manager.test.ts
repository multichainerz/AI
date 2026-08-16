import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  administratorSession,
  agentProfile,
  agentProfileVersion,
  agentRun,
  agentToolGrant,
  auditEvent,
  createTestDatabase,
  division,
  scopedMemoryEntry,
  governedTool,
  governedToolCall,
  mcpGatewayCredential,
  toolRuntimeControl,
  type TestDatabase,
} from "@orcasynapse/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DrizzleToolingManager } from "./drizzle-tooling-manager.js";
import {
  ToolingConflictError,
  ToolingDeniedError,
  ToolingNotFoundError,
  type ToolBoundaryVerifier,
  type ToolingPrincipal,
} from "./tooling-manager.js";

let context: TestDatabase;

beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); }, 120_000);
beforeEach(async () => { await context.reset(); });

const principal: ToolingPrincipal = { id: randomUUID() } as ToolingPrincipal;
const passingBoundary: ToolBoundaryVerifier = { assertAdmittedToolBoundary: vi.fn(async () => undefined) };

function manager(boundaryVerifier?: ToolBoundaryVerifier) {
  return new DrizzleToolingManager(context.database, boundaryVerifier);
}

function digest(value: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(value, "utf8").digest());
}

async function seedTool(overrides: Record<string, unknown> = {}) {
  const [tool] = await context.database
    .insert(governedTool)
    .values({
      slug: `runtime-tool-${randomUUID().slice(0, 8)}`,
      displayName: "Runtime tool",
      description: "A tool advertised by the enrolled Hermes runtime.",
      risk: "READ_ONLY",
      status: "ACTIVE",
      handlerKey: "hermes.runtime_tool",
      inputSchema: { type: "object" },
      ...overrides,
    })
    .returning();
  return tool!;
}

/**
 * Builds a RUNNING agent run holding a live capability token, plus the profile
 * and version graph every tooling gate re-checks.
 */
async function seedRunnableAgent() {
  const [profile] = await context.database
    .insert(agentProfile)
    .values({ slug: `agent-${randomUUID().slice(0, 8)}`, status: "ACTIVE", currentVersion: 1, activeVersion: 1 })
    .returning();
  const [version] = await context.database
    .insert(agentProfileVersion)
    .values({
      profileId: profile!.id,
      version: 1,
      displayName: "Support agent",
      purpose: "Answer operator questions.",
      instructions: "Answer precisely and state uncertainty.",
      soulMd: "You are a careful operations assistant.",
      skills: [],
      modelAlias: "hermes-agent",
      maxTurns: 1,
      timeoutSeconds: 120,
      maxConcurrentRuns: 1,
    })
    .returning();

  // The requester is an administrator session, which is one of the two identity
  // shapes a grant can name.
  const [session] = await context.database
    .insert(administratorSession)
    .values({
      tokenHash: digest(randomUUID()),
      subject: "local-admin:operator",
      role: "PLATFORM_ADMIN",
      lastSeenAt: new Date(),
      idleExpiresAt: new Date(Date.now() + 900_000),
      absoluteExpiresAt: new Date(Date.now() + 3_600_000),
    })
    .returning();

  const capability = randomBytes(32).toString("base64url");
  const [run] = await context.database
    .insert(agentRun)
    .values({
      profileId: profile!.id,
      profileVersionId: version!.id,
      profileVersion: 1,
      ownerSubject: "local-admin:operator",
      requestedBy: session!.id,
      sessionId: randomUUID(),
      input: "run the requested tool",
      outputCharacterLimit: 200_000,
      modelAlias: "hermes-agent",
      jobId: randomUUID(),
      status: "RUNNING",
      toolCapabilityTokenHash: digest(capability),
      toolCapabilityExpiresAt: new Date(Date.now() + 600_000),
    })
    .returning();

  return {
    profile: profile!,
    version: version!,
    run: run!,
    sessionId: session!.id,
    authorization: `${run!.id}.${capability}`,
  };
}

async function grantTool(profileVersionId: string, toolId: string, overrides: Record<string, unknown> = {}) {
  const [grant] = await context.database
    .insert(agentToolGrant)
    .values({
      profileVersionId,
      toolId,
      enabled: true,
      allowedGroups: [],
      allowedAdminRoles: ["PLATFORM_ADMIN"],
      resourceScope: "OWNER_ONLY",
      ...overrides,
    })
    .returning();
  return grant!;
}

async function enableGateway(approvalTtlMinutes = 15) {
  await context.database
    .insert(toolRuntimeControl)
    .values({ id: "global", enabled: true, reason: "Enabled for tests", approvalTtlMinutes })
    .onConflictDoUpdate({
      target: toolRuntimeControl.id,
      set: { enabled: true, approvalTtlMinutes },
    });
}


describe("DrizzleToolingManager catalogue", () => {
  it("lists generic runtime tool definitions", async () => {
    const supported = await seedTool();

    const listed = await manager().listTools();

    expect(listed.items.map(({ id }) => id)).toEqual([supported.id]);
    expect(listed.items[0]?.inputSchema).toEqual({ type: "object" });
  });

  it("suspends and reactivates a supported tool", async () => {
    const tool = await seedTool();

    await manager().setToolStatus(principal, tool.id, "SUSPENDED");
    expect((await manager().listTools()).items[0]?.status).toBe("SUSPENDED");

    await manager().setToolStatus(principal, tool.id, "ACTIVE");
    expect((await manager().listTools()).items[0]?.status).toBe("ACTIVE");
  });

  it("administers generic tool definitions and rejects unknown identifiers", async () => {
    const generic = await seedTool({ handlerKey: "hermes.custom_tool" });

    await expect(manager().setToolStatus(principal, generic.id, "SUSPENDED"))
      .resolves.toBeUndefined();
    await expect(manager().setToolStatus(principal, randomUUID(), "SUSPENDED"))
      .rejects.toBeInstanceOf(ToolingNotFoundError);
  });
});

describe("DrizzleToolingManager grants", () => {
  it("stores an administrator role grant as a readable enum array", async () => {
    const tool = await seedTool();
    const { version, profile } = await seedRunnableAgent();

    const grant = await manager().upsertGrant(principal, {
      profileVersionId: version.id,
      toolId: tool.id,
      enabled: true,
      allowedGroups: [],
      allowedAdminRoles: ["PLATFORM_ADMIN", "SECURITY_ADMIN"],
      resourceScope: "OWNER_ONLY",
    } as never);

    // The baseline created this column as bytea[]; a role must read back intact.
    expect(grant.allowedAdminRoles).toEqual(["PLATFORM_ADMIN", "SECURITY_ADMIN"]);
    expect(grant).toMatchObject({ profileId: profile.id, profileVersion: 1, toolSlug: tool.slug });
  });

  it("updates the existing grant instead of adding a second one", async () => {
    const tool = await seedTool();
    const { version } = await seedRunnableAgent();
    const input = {
      profileVersionId: version.id, toolId: tool.id, enabled: true,
      allowedGroups: [], allowedAdminRoles: ["PLATFORM_ADMIN"], resourceScope: "OWNER_ONLY",
    };

    const first = await manager().upsertGrant(principal, input as never);
    const second = await manager().upsertGrant(principal, { ...input, enabled: false } as never);

    expect(second.id).toBe(first.id);
    expect(second.enabled).toBe(false);
    expect((await manager().listGrants()).items).toHaveLength(1);
  });

  it("refuses a grant naming a version or tool that does not exist", async () => {
    const tool = await seedTool();
    const { version } = await seedRunnableAgent();

    await expect(manager().upsertGrant(principal, {
      profileVersionId: randomUUID(), toolId: tool.id, enabled: true,
      allowedGroups: [], allowedAdminRoles: ["PLATFORM_ADMIN"], resourceScope: "OWNER_ONLY",
    } as never)).rejects.toBeInstanceOf(ToolingNotFoundError);

    await expect(manager().upsertGrant(principal, {
      profileVersionId: version.id, toolId: randomUUID(), enabled: true,
      allowedGroups: [], allowedAdminRoles: ["PLATFORM_ADMIN"], resourceScope: "OWNER_ONLY",
    } as never)).rejects.toBeInstanceOf(ToolingNotFoundError);
  });
});

describe("DrizzleToolingManager gateway credentials", () => {
  it("returns the token once and stores only its digest", async () => {
    const issued = await manager().issueCredential(principal, "Hermes gateway");

    expect(issued.token).toMatch(/^orcasynapse_mcp_[A-Za-z0-9_-]{43}$/);
    expect(issued.tokenPrefix).toBe(issued.token.slice(0, 20));

    const [stored] = await context.database.select().from(mcpGatewayCredential);
    expect(Buffer.from(stored!.tokenHash)).toEqual(createHash("sha256").update(issued.token).digest());
    // The listing never carries the secret.
    expect(JSON.stringify(await manager().listCredentials())).not.toContain(issued.token);
  });

  it("authenticates a live token and stamps its last use", async () => {
    const issued = await manager().issueCredential(principal, "Hermes gateway");

    expect(await manager().authenticateGateway(issued.token)).toBe(true);
    const [used] = await context.database.select().from(mcpGatewayCredential);
    expect(used?.lastUsedAt).not.toBeNull();
  });

  it("rejects a malformed, unknown, or revoked token", async () => {
    const issued = await manager().issueCredential(principal, "Hermes gateway");

    expect(await manager().authenticateGateway(undefined)).toBe(false);
    expect(await manager().authenticateGateway("not-a-gateway-token")).toBe(false);
    expect(await manager().authenticateGateway(`orcasynapse_mcp_${"z".repeat(43)}`)).toBe(false);

    await manager().revokeCredential(principal, issued.id);
    expect(await manager().authenticateGateway(issued.token)).toBe(false);
    await expect(manager().revokeCredential(principal, issued.id)).rejects.toBeInstanceOf(ToolingNotFoundError);
  });
});

describe("DrizzleToolingManager run-scoped discovery", () => {
  it("refuses discovery while the gateway is disabled", async () => {
    const { authorization } = await seedRunnableAgent();

    await expect(manager().listToolsForRun(authorization)).rejects.toBeInstanceOf(ToolingDeniedError);
  });

  it("refuses discovery without a run authorization", async () => {
    await enableGateway();

    await expect(manager().listToolsForRun(undefined)).rejects.toBeInstanceOf(ToolingDeniedError);
    await expect(manager().listToolsForRun("garbage")).rejects.toBeInstanceOf(ToolingDeniedError);
  });

  it("refuses a capability token that does not match the run", async () => {
    await enableGateway();
    const { run } = await seedRunnableAgent();

    await expect(manager().listToolsForRun(`${run.id}.${randomBytes(32).toString("base64url")}`))
      .rejects.toThrow(/capability is invalid/);
  });

  it("refuses discovery once the capability has expired", async () => {
    await enableGateway();
    const { run, authorization } = await seedRunnableAgent();
    await context.database
      .update(agentRun)
      .set({ toolCapabilityExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(agentRun.id, run.id));

    await expect(manager().listToolsForRun(authorization)).rejects.toThrow(/expired/);
  });

  it("refuses discovery once the profile version is no longer the active one", async () => {
    await enableGateway();
    const { profile, authorization } = await seedRunnableAgent();
    await context.database
      .update(agentProfile)
      .set({ activeVersion: 2, currentVersion: 2 })
      .where(eq(agentProfile.id, profile.id));

    await expect(manager().listToolsForRun(authorization)).rejects.toThrow(/no longer active/);
  });

  it("returns only granted, active tools the requester's role satisfies", async () => {
    await enableGateway();
    const granted = await seedTool();
    const suspended = await seedTool({ status: "SUSPENDED" });
    const ungranted = await seedTool();
    const { version, authorization } = await seedRunnableAgent();
    await grantTool(version.id, granted.id);
    await grantTool(version.id, suspended.id);
    await grantTool(version.id, ungranted.id, { enabled: false });

    const discovered = await manager().listToolsForRun(authorization);

    expect(discovered.items.map(({ id }) => id)).toEqual([granted.id]);
  });

  it("withholds a tool whose grant names a role the requester does not hold", async () => {
    await enableGateway();
    const tool = await seedTool();
    const { version, authorization } = await seedRunnableAgent();
    await grantTool(version.id, tool.id, { allowedAdminRoles: ["AUDITOR"] });

    expect((await manager().listToolsForRun(authorization)).items).toHaveLength(0);
  });
});

describe("DrizzleToolingManager invocation", () => {
  it("records a generic tool call as failed when no local executor is registered", async () => {
    await enableGateway();
    const tool = await seedTool();
    const { version, authorization } = await seedRunnableAgent();
    await grantTool(version.id, tool.id);

    const result = await manager().invoke(tool.slug, {
      authorization,
      requestId: randomUUID(),
      arguments: { operation: "status" },
    });

    expect(result).toMatchObject({ status: "FAILED", isError: true });
    expect(result.data).toMatchObject({ message: expect.stringContaining("No local executor") });
    const [call] = await context.database.select().from(governedToolCall);
    expect(call).toMatchObject({ status: "FAILED", errorCode: "TOOL_EXECUTION_FAILED" });
  });

  it("records a gateway denial without creating a call row", async () => {
    const { run, authorization } = await seedRunnableAgent();

    await manager().recordDeniedInvocation("runtime-tool", {
      authorization,
      requestId: randomUUID(),
      arguments: {},
    }, "The gateway is disabled.");

    const [recorded] = await context.database.select().from(auditEvent);
    expect(recorded).toMatchObject({ action: "tool.call_denied", outcome: "FAILURE", resourceId: run.id });
    expect(await context.database.select().from(governedToolCall)).toHaveLength(0);
  });
});


describe("DrizzleToolingManager runtime control", () => {
  it("denies execution fail-closed when the control row is missing", async () => {
    expect(await manager().getRuntimeControl()).toMatchObject({
      enabled: false,
      reason: "Tool runtime control is missing; execution is denied fail-closed.",
      approvalTtlMinutes: 15,
    });
  });

  it("refuses to enable the gateway without a credential and an active grant", async () => {
    await expect(manager(passingBoundary).updateRuntimeControl(principal, {
      enabled: true, reason: "go", approvalTtlMinutes: 15,
    } as never)).rejects.toBeInstanceOf(ToolingConflictError);

    const denials = (await context.database.select().from(auditEvent))
      .filter(({ action }) => action === "tool.runtime_enable_denied");
    expect(denials).toHaveLength(1);
    expect(await manager().getRuntimeControl()).toMatchObject({ enabled: false });
  });

  it("refuses to enable the gateway when Hermes fails the handoff check", async () => {
    const tool = await seedTool();
    const { version } = await seedRunnableAgent();
    await grantTool(version.id, tool.id);
    await manager().issueCredential(principal, "Hermes gateway");
    const failing: ToolBoundaryVerifier = {
      assertAdmittedToolBoundary: vi.fn(async () => { throw new Error("boundary breached"); }),
    };

    await expect(manager(failing).updateRuntimeControl(principal, {
      enabled: true, reason: "go", approvalTtlMinutes: 15,
    } as never)).rejects.toThrow(/private governed-tool handoff/);

    expect(await manager().getRuntimeControl()).toMatchObject({ enabled: false });
  });

  it("enables the gateway once every precondition holds", async () => {
    const tool = await seedTool();
    const { version } = await seedRunnableAgent();
    await grantTool(version.id, tool.id);
    await manager().issueCredential(principal, "Hermes gateway");

    const enabled = await manager(passingBoundary).updateRuntimeControl(principal, {
      enabled: true, reason: "First release", approvalTtlMinutes: 30,
    } as never);

    expect(enabled).toMatchObject({ enabled: true, reason: "First release", approvalTtlMinutes: 30 });
    // Disabling needs no preconditions, so it never needs a boundary verifier.
    expect(await manager().updateRuntimeControl(principal, {
      enabled: false, reason: "Maintenance", approvalTtlMinutes: 30,
    } as never)).toMatchObject({ enabled: false });
    expect(await context.database.select().from(toolRuntimeControl)).toHaveLength(1);
  });
});

describe("DrizzleToolingManager metrics", () => {
  it("counts the governed surface by its live state", async () => {
    await enableGateway();
    const tool = await seedTool();
    await seedTool({ status: "SUSPENDED" });
    const { version, authorization } = await seedRunnableAgent();
    await grantTool(version.id, tool.id);
    await manager().invoke(tool.slug, { authorization, requestId: randomUUID(), arguments: { operation: "status" } });

    const metrics = await manager().metrics();

    expect(metrics).toMatchObject({
      activeTools: 1, activeGrants: 1, pendingApprovals: 0,
      executingCalls: 0, completedCalls: 0, deniedCalls: 0, failedCalls: 1,
    });
  });

  describe("toolset admission", () => {
    it("admits nothing until an operator says so", async () => {
      // A fresh installation must be tool-free without anyone configuring it,
      // so absence of a row is the same refusal as an explicit revocation.
      await expect(manager().admittedToolsetNames()).resolves.toEqual([]);
      await expect(manager().listToolsetAdmissions()).resolves.toEqual({ items: [] });
    });

    it("records who admitted a toolset and why, and reports it as admitted", async () => {
      const saved = await manager().decideToolsetAdmission(principal, "clarify", {
        admitted: true, reason: "Asks the operator a question; touches no data.",
      });
      expect(saved).toMatchObject({
        toolsetName: "clarify", admitted: true, admittedBy: principal.id,
        reason: "Asks the operator a question; touches no data.",
      });
      await expect(manager().admittedToolsetNames()).resolves.toEqual(["clarify"]);
    });

    it("keeps the reason on record when a toolset is revoked", async () => {
      await manager().decideToolsetAdmission(principal, "clarify", { admitted: true, reason: "Safe to enable." });
      const revoked = await manager().decideToolsetAdmission(principal, "clarify", {
        admitted: false, reason: "Withdrawn pending review.",
      });
      expect(revoked).toMatchObject({ admitted: false, reason: "Withdrawn pending review." });
      // Revocation removes it from the boundary set but not from the record.
      await expect(manager().admittedToolsetNames()).resolves.toEqual([]);
      const { items } = await manager().listToolsetAdmissions();
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ toolsetName: "clarify", admitted: false });
    });

    it("decides a toolset once, not once per attempt", async () => {
      await manager().decideToolsetAdmission(principal, "todo", { admitted: true, reason: "Run-local scratch list." });
      await manager().decideToolsetAdmission(principal, "todo", { admitted: true, reason: "Re-confirmed after review." });
      const { items } = await manager().listToolsetAdmissions();
      expect(items).toHaveLength(1);
      expect(items[0]?.reason).toBe("Re-confirmed after review.");
    });

    it("writes an audit event naming the toolset decision", async () => {
      await manager().decideToolsetAdmission(principal, "clarify", { admitted: true, reason: "Safe to enable." });
      const events = await context.database.select().from(auditEvent);
      expect(events.map((event) => event.action)).toContain("tool.toolset_admitted");
    });
  });
});

describe("run scope", () => {
  /*
   * Increment F's scope injection. The division a tool acts for is derived from
   * the run authorization and from nothing the caller sent.
   */
  it("derives the division from the run's profile", async () => {
    const [finance] = await context.database.insert(division)
      .values({ slug: "finance", displayName: "Finance" }).returning();
    await enableGateway();
    const seeded = await seedRunnableAgent();
    await context.database.update(agentProfile)
      .set({ divisionId: finance!.id }).where(eq(agentProfile.id, seeded.profile.id));

    await expect(manager().runScope(seeded.authorization))
      .resolves.toEqual({ runId: seeded.run.id, divisionId: finance!.id });
  });

  /*
   * A deployment-wide run resolves null, and null is a scope rather than the
   * absence of one. A caller that read it as "no filter" would hand every
   * division's rows to a run that belongs to none of them, so this is asserted
   * explicitly rather than left to a reader's judgement.
   */
  it("resolves a deployment-wide run to null rather than to everything", async () => {
    await enableGateway();
    const seeded = await seedRunnableAgent();

    await expect(manager().runScope(seeded.authorization))
      .resolves.toEqual({ runId: seeded.run.id, divisionId: null });
  });

  /*
   * The property the whole increment rests on: two runs, two divisions, and no
   * way for one authorization to yield the other's scope. There is no parameter
   * to override -- `runScope` takes only the authorization -- so this is the
   * test that the seam has no second input.
   */
  it("gives each run its own division and never the other's", async () => {
    const [alpha] = await context.database.insert(division)
      .values({ slug: "alpha", displayName: "Alpha" }).returning();
    const [beta] = await context.database.insert(division)
      .values({ slug: "beta", displayName: "Beta" }).returning();
    await enableGateway();
    const first = await seedRunnableAgent();
    const second = await seedRunnableAgent();
    await context.database.update(agentProfile)
      .set({ divisionId: alpha!.id }).where(eq(agentProfile.id, first.profile.id));
    await context.database.update(agentProfile)
      .set({ divisionId: beta!.id }).where(eq(agentProfile.id, second.profile.id));

    expect((await manager().runScope(first.authorization)).divisionId).toBe(alpha!.id);
    expect((await manager().runScope(second.authorization)).divisionId).toBe(beta!.id);
  });

  /*
   * A forged capability resolves no scope at all. Pairing a real run id with a
   * capability the caller invented is the obvious attack, and it must fail on
   * the capability rather than succeed on the run id.
   */
  it("refuses a run id carrying somebody else's capability", async () => {
    await enableGateway();
    const first = await seedRunnableAgent();
    const second = await seedRunnableAgent();
    const forged = `${first.run.id}.${second.authorization.split(".")[1]}`;

    await expect(manager().runScope(forged)).rejects.toBeInstanceOf(ToolingDeniedError);
  });

  it("refuses a missing or malformed authorization", async () => {
    await enableGateway();
    await expect(manager().runScope(undefined)).rejects.toBeInstanceOf(ToolingDeniedError);
    await expect(manager().runScope("not-an-authorization")).rejects.toBeInstanceOf(ToolingDeniedError);
  });
});

describe("division-scoped memory", () => {
  async function memoryTools() {
    return {
      remember: await seedTool({ slug: `remember-${randomUUID().slice(0, 8)}`, handlerKey: "orcasynapse.memory.remember" }),
      recall: await seedTool({ slug: `recall-${randomUUID().slice(0, 8)}`, handlerKey: "orcasynapse.memory.recall" }),
    };
  }

  async function runIn(divisionId: string | null) {
    const seeded = await seedRunnableAgent();
    if (divisionId) {
      await context.database.update(agentProfile)
        .set({ divisionId }).where(eq(agentProfile.id, seeded.profile.id));
    }
    return seeded;
  }

  /*
   * Increment F's Done-when, and the reason the increment exists: a run in one
   * division cannot recall what another wrote.
   *
   * Asserted against the tool's own result rather than a model reply, and note
   * what the recall call sends -- only a query string. There is no division in
   * the arguments to tamper with, because the handler takes its scope from the
   * authorization.
   */
  it("does not let a run recall another division's rows", async () => {
    await enableGateway();
    const [alpha] = await context.database.insert(division)
      .values({ slug: "alpha", displayName: "Alpha" }).returning();
    const [beta] = await context.database.insert(division)
      .values({ slug: "beta", displayName: "Beta" }).returning();
    const tools = await memoryTools();
    const first = await runIn(alpha!.id);
    const second = await runIn(beta!.id);
    await grantTool(first.version.id, tools.remember.id);
    await grantTool(first.version.id, tools.recall.id);
    await grantTool(second.version.id, tools.recall.id);

    await manager().invoke(tools.remember.slug, {
      authorization: first.authorization, requestId: randomUUID(),
      arguments: { text: "the alpha quarterly close is on the ninth" },
    });

    const mine = await manager().invoke(tools.recall.slug, {
      authorization: first.authorization, requestId: randomUUID(), arguments: { query: "quarterly" },
    });
    const theirs = await manager().invoke(tools.recall.slug, {
      authorization: second.authorization, requestId: randomUUID(), arguments: { query: "quarterly" },
    });

    expect((mine.data as { entries: unknown[] }).entries).toHaveLength(1);
    expect((theirs.data as { entries: unknown[] }).entries).toHaveLength(0);
  });

  /*
   * The row lands under the division the authorization resolves to, not under
   * anything the arguments claim. A caller passing `divisionId` is passing an
   * argument the handler does not read.
   */
  it("ignores a division the agent tries to name in the arguments", async () => {
    await enableGateway();
    const [alpha] = await context.database.insert(division)
      .values({ slug: "alpha", displayName: "Alpha" }).returning();
    const [beta] = await context.database.insert(division)
      .values({ slug: "beta", displayName: "Beta" }).returning();
    const tools = await memoryTools();
    const run = await runIn(alpha!.id);
    await grantTool(run.version.id, tools.remember.id);

    await manager().invoke(tools.remember.slug, {
      authorization: run.authorization, requestId: randomUUID(),
      arguments: { text: "written by alpha", divisionId: beta!.id, division: "Beta" },
    });

    const rows = await context.database.select().from(scopedMemoryEntry);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.divisionId).toBe(alpha!.id);
  });

  /*
   * A deployment-wide run reads deployment-wide rows and no others. Null is a
   * scope, so it must not behave as "match anything" -- that single misreading
   * would hand every division's memory to a profile that belongs to none.
   */
  it("keeps a deployment-wide run out of every division's rows", async () => {
    await enableGateway();
    const [alpha] = await context.database.insert(division)
      .values({ slug: "alpha", displayName: "Alpha" }).returning();
    const tools = await memoryTools();
    const scoped = await runIn(alpha!.id);
    const wide = await runIn(null);
    await grantTool(scoped.version.id, tools.remember.id);
    await grantTool(wide.version.id, tools.remember.id);
    await grantTool(wide.version.id, tools.recall.id);

    await manager().invoke(tools.remember.slug, {
      authorization: scoped.authorization, requestId: randomUUID(), arguments: { text: "alpha only" },
    });
    await manager().invoke(tools.remember.slug, {
      authorization: wide.authorization, requestId: randomUUID(), arguments: { text: "everyone" },
    });

    const seen = await manager().invoke(tools.recall.slug, {
      authorization: wide.authorization, requestId: randomUUID(), arguments: {},
    });

    const entries = (seen.data as { entries: Array<{ content: string }> }).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.content).toBe("everyone");
  });
});

/*
 * Curated memory: what an administrator writes for a division directly.
 *
 * This exists because extraction has nothing to extract from on a fresh
 * install. A division's standing facts -- how it closes its books, which
 * committee approves what -- are known on day one and would otherwise wait for
 * an agent to infer them from conversations that have not happened.
 *
 * It writes to the same table a run reads, so the entry is subject to the same
 * division selection and needs no separate boundary. The row is deliberately
 * indistinguishable from a remembered one apart from its null `runId`.
 */
describe("administrator-curated division memory", () => {
  it("writes an entry scoped to the division it names", async () => {
    const [finance] = await context.database.insert(division)
      .values({ slug: "finance", displayName: "Finance" }).returning();

    const created = await manager().createScopedMemory(
      principal,
      { content: "Finance closes the books on the fifth working day.", divisionId: finance!.id },
    );

    const [row] = await context.database.select().from(scopedMemoryEntry);
    expect(created.divisionId).toBe(finance!.id);
    expect(row?.divisionId).toBe(finance!.id);
    expect(row?.content).toBe("Finance closes the books on the fifth working day.");
    // Null run id is what distinguishes curated from remembered, and the Memory
    // screen reads it to say which is which.
    expect(row?.runId).toBeNull();
  });

  it("accepts a deployment-wide entry, which is its own scope rather than all of them", async () => {
    const [finance] = await context.database.insert(division)
      .values({ slug: "finance", displayName: "Finance" }).returning();

    await manager().createScopedMemory(
      principal,
      { content: "The company holiday calendar is published each November.", divisionId: null },
    );

    const rows = await context.database.select().from(scopedMemoryEntry);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.divisionId).toBeNull();
    // Not readable by Finance: a deployment-wide row belongs to the null scope,
    // and a division reads its own. Asserted here so the write path cannot be
    // mistaken for a way to broadcast into every division.
    const financeRows = await context.database.select().from(scopedMemoryEntry)
      .where(eq(scopedMemoryEntry.divisionId, finance!.id));
    expect(financeRows).toHaveLength(0);
  });

  it("records an audit event naming who wrote it", async () => {
    await manager().createScopedMemory(
      principal,
      { content: "Legal reviews every vendor contract over fifty thousand.", divisionId: null },
    );

    const events = await context.database.select().from(auditEvent)
      .where(eq(auditEvent.action, "memory.entry_curated"));
    expect(events).toHaveLength(1);
    expect(events[0]?.actorId).toBe(principal.id);
  });
});
