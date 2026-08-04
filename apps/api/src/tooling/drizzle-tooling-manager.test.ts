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
  document,
  documentMemoryPublication,
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
afterAll(async () => { await context?.drop(); });
beforeEach(async () => { await context.reset(); });

const principal: ToolingPrincipal = { id: randomUUID() } as ToolingPrincipal;
const passingBoundary: ToolBoundaryVerifier = { assertGovernedToolBoundary: vi.fn(async () => undefined) };

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
      slug: `document-metadata-${randomUUID().slice(0, 8)}`,
      displayName: "Document metadata",
      description: "Reads metadata for a document the requester owns.",
      risk: "READ_ONLY",
      status: "ACTIVE",
      handlerKey: "builtin.document_metadata_read",
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
      instructions: "Answer only from approved knowledge.",
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
      memorySessionKey: randomUUID(),
      input: "inspect the document",
      conversationHistory: [],
      outputCharacterLimit: 200_000,
      modelAlias: "hermes-agent",
      jobId: randomUUID(),
      effectiveCapabilities: [],
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

async function enableGateway() {
  await context.database
    .insert(toolRuntimeControl)
    .values({ id: "global", enabled: true, reason: "Enabled for tests" })
    .onConflictDoUpdate({ target: toolRuntimeControl.id, set: { enabled: true } });
}

async function seedDocument(ownerSubject: string, withMemory = true) {
  const [stored] = await context.database
    .insert(document)
    .values({
      ownerSubject,
      fileName: "runbook.pdf",
      mediaType: "application/pdf",
      sizeBytes: 4_096,
      classification: "INTERNAL",
      status: "READY",
      sha256: createHash("sha256").update("runbook").digest("hex"),
      retentionUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
    })
    .returning();
  if (withMemory) {
    await context.database.insert(documentMemoryPublication).values({
      documentId: stored!.id,
      ownerSubject,
      scopeTag: "owner",
      status: "READY",
      externalDocumentId: randomUUID(),
      syncedAt: new Date(),
    });
  }
  return stored!;
}

describe("DrizzleToolingManager catalogue", () => {
  it("lists only tools with a handler this release actually implements", async () => {
    const supported = await seedTool();
    await seedTool({ handlerKey: "builtin.not_implemented" });

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

  it("refuses to change the status of a tool it does not govern", async () => {
    const foreign = await seedTool({ handlerKey: "builtin.not_implemented" });

    await expect(manager().setToolStatus(principal, foreign.id, "SUSPENDED"))
      .rejects.toBeInstanceOf(ToolingNotFoundError);
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
  it("reads document metadata for a document the run's owner holds", async () => {
    await enableGateway();
    const tool = await seedTool();
    const { version, run, authorization } = await seedRunnableAgent();
    await grantTool(version.id, tool.id);
    const stored = await seedDocument(run.ownerSubject);

    const result = await manager().invoke(tool.slug, {
      authorization, requestId: randomUUID(), arguments: { documentId: stored.id },
    });

    expect(result).toMatchObject({ status: "COMPLETED", isError: false });
    expect(result.data).toMatchObject({
      documentId: stored.id,
      fileName: "runbook.pdf",
      sizeBytes: "4096",
      classification: "INTERNAL",
    });
    expect((result.data as { memory: { status: string } }).memory.status).toBe("READY");

    const [call] = await context.database.select().from(governedToolCall);
    expect(call?.status).toBe("COMPLETED");
  });

  it("denies a document outside the run owner's scope", async () => {
    await enableGateway();
    const tool = await seedTool();
    const { version, authorization } = await seedRunnableAgent();
    await grantTool(version.id, tool.id);
    const foreign = await seedDocument("local-admin:someone-else");

    const result = await manager().invoke(tool.slug, {
      authorization, requestId: randomUUID(), arguments: { documentId: foreign.id },
    });

    // The failure is recorded against the call rather than thrown, so the agent
    // receives a tool error instead of a transport failure.
    expect(result).toMatchObject({ status: "FAILED", isError: true });
    const [call] = await context.database.select().from(governedToolCall);
    expect(call?.errorCode).toBe("TOOL_EXECUTION_FAILED");
  });

  it("replays the stored result for a repeated request ID", async () => {
    await enableGateway();
    const tool = await seedTool();
    const { version, run, authorization } = await seedRunnableAgent();
    await grantTool(version.id, tool.id);
    const stored = await seedDocument(run.ownerSubject);
    const requestId = randomUUID();

    const first = await manager().invoke(tool.slug, { authorization, requestId, arguments: { documentId: stored.id } });
    const replay = await manager().invoke(tool.slug, { authorization, requestId, arguments: { documentId: stored.id } });

    expect(replay.callId).toBe(first.callId);
    expect(await context.database.select().from(governedToolCall)).toHaveLength(1);
  });

  it("refuses to reuse a request ID for a different document", async () => {
    await enableGateway();
    const tool = await seedTool();
    const { version, run, authorization } = await seedRunnableAgent();
    await grantTool(version.id, tool.id);
    const first = await seedDocument(run.ownerSubject);
    const second = await seedDocument(run.ownerSubject);
    const requestId = randomUUID();
    await manager().invoke(tool.slug, { authorization, requestId, arguments: { documentId: first.id } });

    await expect(manager().invoke(tool.slug, { authorization, requestId, arguments: { documentId: second.id } }))
      .rejects.toThrow(/already used for a different tool invocation/);
  });

  it("rejects arguments that are not exactly one document identifier", async () => {
    await enableGateway();
    const tool = await seedTool();
    const { version, run, authorization } = await seedRunnableAgent();
    await grantTool(version.id, tool.id);
    const stored = await seedDocument(run.ownerSubject);

    for (const args of [{}, { documentId: "not-a-uuid" }, { documentId: stored.id, extra: 1 }]) {
      await expect(manager().invoke(tool.slug, { authorization, requestId: randomUUID(), arguments: args }))
        .rejects.toBeInstanceOf(ToolingDeniedError);
    }
    expect(await context.database.select().from(governedToolCall)).toHaveLength(0);
  });

  it("refuses a consequential tool because no handler is installed", async () => {
    await enableGateway();
    const tool = await seedTool({ risk: "CONSEQUENTIAL" });
    const { version, authorization } = await seedRunnableAgent();
    await grantTool(version.id, tool.id);

    await expect(manager().invoke(tool.slug, {
      authorization, requestId: randomUUID(), arguments: { documentId: randomUUID() },
    })).rejects.toThrow(/consequential tool handler/);
  });

  it("refuses a tool the active version does not grant", async () => {
    await enableGateway();
    const tool = await seedTool();
    const { authorization } = await seedRunnableAgent();

    await expect(manager().invoke(tool.slug, {
      authorization, requestId: randomUUID(), arguments: { documentId: randomUUID() },
    })).rejects.toThrow(/does not grant this tool/);
  });

  it("records a denial without a call row", async () => {
    const { run, authorization } = await seedRunnableAgent();

    await manager().recordDeniedInvocation("document-metadata", {
      authorization, requestId: randomUUID(), arguments: {},
    }, "The gateway is disabled.");

    const [recorded] = await context.database.select().from(auditEvent);
    expect(recorded).toMatchObject({ action: "tool.call_denied", outcome: "FAILURE", resourceId: run.id });
    expect(await context.database.select().from(governedToolCall)).toHaveLength(0);
  });

  it("lists completed calls with their profile and tool identity", async () => {
    await enableGateway();
    const tool = await seedTool();
    const { version, run, profile, authorization } = await seedRunnableAgent();
    await grantTool(version.id, tool.id);
    const stored = await seedDocument(run.ownerSubject);
    await manager().invoke(tool.slug, { authorization, requestId: randomUUID(), arguments: { documentId: stored.id } });

    const listed = await manager().listCalls();

    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({
      profileSlug: profile.slug, profileVersion: 1, toolSlug: tool.slug, risk: "READ_ONLY", status: "COMPLETED",
    });
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
      assertGovernedToolBoundary: vi.fn(async () => { throw new Error("boundary breached"); }),
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
    const { version, run, authorization } = await seedRunnableAgent();
    await grantTool(version.id, tool.id);
    const stored = await seedDocument(run.ownerSubject);
    await manager().invoke(tool.slug, { authorization, requestId: randomUUID(), arguments: { documentId: stored.id } });

    const metrics = await manager().metrics();

    expect(metrics).toMatchObject({
      activeTools: 1, activeGrants: 1, pendingApprovals: 0,
      executingCalls: 0, completedCalls: 1, deniedCalls: 0, failedCalls: 0,
    });
  });
});
