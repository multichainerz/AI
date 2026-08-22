import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { AGENT_RUN_ENDED_EVENT_TYPE, type GuardrailRule } from "@orcasynapse/contracts";
import { asc, eq } from "drizzle-orm";
import {
  agentProfile,
  agentProfileVersion,
  agentToolGrant,
  governedTool,
  mcpGatewayCredential,
  runtimeToolsetAdmission,
  toolRuntimeControl,
  toolSet,
  agentRun,
  agentRunEvent,
  agentRuntimeControl,
  auditEvent,
  chatArtifact,
  chatArtifactContent,
  chatConversation,
  chatMessage,
  createTestDatabase,
  division,
  guardrailPolicy,
  hermesRuntimeNode,
  scopedMemoryEntry,
  serviceConnection,
  type TestDatabase,
} from "@orcasynapse/database";
import { HermesRunDetachedError, nativeRunId, nativeSessionChatBody, persistFlattenedUserText, type HermesRunSubmission } from "@orcasynapse/runtime-clients";
import { RunCapabilityIssuer } from "@orcasynapse/security";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DrizzleAgentProcessor, type AgentHermesRuntime } from "./agent-processor.js";
import type { MemoryExtractor } from "./memory-extractor.js";

let context: TestDatabase;

beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); }, 120_000);
beforeEach(async () => { await context.reset(); });

const WORKER_ID = randomUUID();
/*
 * A fixed key, because every test that is not about the capability still needs
 * one: the processor requires an issuer so that forgetting to wire it in
 * production is a compile error rather than a run that silently cannot call
 * tools. Tests asserting the capability itself construct their own.
 */
const CAPABILITIES = new RunCapabilityIssuer(Buffer.alloc(32, 3));

interface Fixture {
  runId: string;
  jobId: string;
  messageId: string;
  externalRunId: string;
  conversationId: string;
  userMessageId: string;
}

/**
 * Everything `boundaryState` insists on before a run may execute.
 *
 * The processor re-reads all of it on every poll, so a fixture that leaves one
 * row out does not fail a run for the reason the test is about -- it fails it
 * as DENIED with a boundary code, which passes an assertion looking only for
 * "not COMPLETED". Each of these is written because the boundary reads it.
 */
async function seed(overrides: Partial<typeof agentRun.$inferInsert> = {}): Promise<Fixture> {
  await context.database.insert(agentRuntimeControl).values({ id: "global", enabled: true });
  const [connection] = await context.database.insert(serviceConnection).values({
    slug: `hermes-${randomUUID().slice(0, 8)}`,
    displayName: "Hermes",
    kind: "HERMES",
    environment: "PRODUCTION",
    enabled: true,
    status: "HEALTHY",
  }).returning({ id: serviceConnection.id });
  await context.database.insert(hermesRuntimeNode).values({
    slug: `node-${randomUUID().slice(0, 8)}`,
    displayName: "Hermes node",
    baseUrl: "https://hermes.internal",
    status: "ONLINE",
    serviceConnectionId: connection!.id,
    enrolledAt: new Date(),
    lastSeenAt: new Date(),
  });

  const [profile] = await context.database.insert(agentProfile).values({
    slug: `profile-${randomUUID().slice(0, 8)}`,
    status: "ACTIVE",
    activeVersion: 1,
  }).returning({ id: agentProfile.id });
  const [version] = await context.database.insert(agentProfileVersion).values({
    profileId: profile!.id,
    version: 1,
    displayName: "Analyst v1",
    purpose: "Answer internal policy questions with approved evidence.",
    maxConcurrentRuns: 1,
    instructions: "Answer with approved evidence.",
    soulMd: "You are a careful internal analyst.",
    modelAlias: "hermes-agent",
    maxTurns: 1,
    timeoutSeconds: 60,
    safeMode: true,
  }).returning({ id: agentProfileVersion.id });

  const jobId = randomUUID();
  const [row] = await context.database.insert(agentRun).values({
    profileId: profile!.id,
    profileVersionId: version!.id,
    profileVersion: 1,
    ownerSubject: "user:pilot",
    requestedBy: randomUUID(),
    sessionId: randomUUID(),
    input: "Summarize the policy.",
    status: "QUEUED",
    jobId,
    outputCharacterLimit: 200_000,
    ...overrides,
  }).returning({ id: agentRun.id, externalRunId: agentRun.externalRunId });

  const [conversation] = await context.database.insert(chatConversation).values({
    ownerSubject: "user:pilot",
    title: "Policy",
    modelAlias: "hermes-agent",
    profileId: profile!.id,
    profileName: "Analyst v1",
  }).returning({ id: chatConversation.id });
  // The assistant row is the one every assertion is about: it is the turn the
  // reader is waiting on, and the only one a finaliser touches.
  const messageId = randomUUID();
  const userMessageId = randomUUID();
  await context.database.insert(chatMessage).values([
    { id: userMessageId, conversationId: conversation!.id, ordinal: 1, role: "USER", status: "COMPLETED", content: "Summarize the policy." },
    { id: messageId, conversationId: conversation!.id, ordinal: 2, role: "ASSISTANT", status: "PENDING", content: "", agentRunId: row!.id },
  ]);

  return {
    runId: row!.id,
    jobId,
    messageId,
    externalRunId: row!.externalRunId ?? "",
    conversationId: conversation!.id,
    userMessageId,
  };
}

function completedState(overrides: Partial<Awaited<ReturnType<AgentHermesRuntime["status"]>>> = {}) {
  return {
    id: "hermes-native-1",
    status: "completed",
    output: "The policy permits it.",
    error: null,
    modelAlias: "hermes-agent",
    sessionId: "session-1",
    inputTokens: 11,
    outputTokens: 5,
    reasoningTokens: null,
    totalTokens: null,
    finishReason: "stop",
    ...overrides,
  };
}

function runtime(overrides: Partial<AgentHermesRuntime> = {}): AgentHermesRuntime {
  return {
    assertAdmittedToolBoundary: async () => undefined,
    start: async () => "hermes-native-1",
    status: async () => completedState(),
    stop: async () => undefined,
    pollIntervalMs: async () => 1,
    ...overrides,
  };
}

/** Moves the lease to somebody else, the way an expired lease being re-offered does. */
async function stealLease(runId: string): Promise<void> {
  await context.database.update(agentRun)
    .set({ processorLeaseOwner: randomUUID(), processorLeaseExpiresAt: new Date(Date.now() + 90_000) })
    .where(eq(agentRun.id, runId));
}

async function events(runId: string) {
  return context.database.select().from(agentRunEvent)
    .where(eq(agentRunEvent.runId, runId)).orderBy(asc(agentRunEvent.cursor));
}

describe("DrizzleAgentProcessor tool boundary", () => {
  /*
   * The increment-C regression, placed where the trap actually is.
   *
   * `admittedToolsets` on the run submission is NOT a control over what the
   * agent may use. It feeds `assertAdmittedToolBoundaryFor`, which reads the
   * runtime's *enabled* toolsets and throws when any of them falls outside the
   * set handed to it. What a node may enable is decided by its desired state,
   * deployment-wide, and cannot vary per run.
   *
   * So the plan's original instruction -- have the worker pass
   * `deployment-admitted INTERSECT the profile's tool set` -- would not have
   * narrowed anything. It would have failed every run of any profile whose set
   * was a strict subset, with an error that reads like runtime drift rather
   * than a design mistake.
   *
   * This asserts the payload carries the DEPLOYMENT-WIDE set. It is written
   * against the call arguments rather than a model reply, and it exists to fail
   * the day somebody implements the intersection that looks obviously correct.
   */
  it("submits the deployment-wide admitted set, never a per-profile narrowing", async () => {
    const { runId, jobId } = await seed();
    await context.database.insert(runtimeToolsetAdmission).values(
      ["clarify", "bfl", "memory"].map((toolsetName) => ({
        toolsetName, admitted: true, admittedBy: randomUUID(), reason: "Admitted for tests.",
      })),
    );
    // A tool set narrower than admission, pointed at by the run's version.
    const [narrow] = await context.database.insert(toolSet)
      .values({ slug: "narrow", displayName: "Narrow", toolsetNames: ["memory"] }).returning();
    await context.database.update(agentProfileVersion)
      .set({ toolSetId: narrow!.id })
      .where(eq(agentProfileVersion.id, (await context.database.select({ id: agentProfileVersion.id })
        .from(agentProfileVersion).limit(1))[0]!.id));

    let submitted: readonly string[] | undefined;
    const processor = new DrizzleAgentProcessor(context.database, runtime({
      start: async (input: { admittedToolsets?: readonly string[] }) => {
        submitted = input.admittedToolsets;
        return "hermes-native-boundary";
      },
    }) as never, CAPABILITIES);
    await processor.process({ runId }, jobId, WORKER_ID);

    expect([...(submitted ?? [])].sort()).toEqual(["bfl", "clarify", "memory"]);
  });
});

/** An ACTIVE governed tool granted to the run's own version, the way the seed grants `remember`. */
async function grantActiveTool(runId: string, slug: string): Promise<void> {
  const [tool] = await context.database.insert(governedTool).values({
    slug,
    displayName: "Remember",
    description: "Save a note for this division.",
    risk: "READ_ONLY",
    status: "ACTIVE",
    handlerKey: `orcasynapse.memory.${slug}`,
    inputSchema: { type: "object", properties: {} },
  }).returning({ id: governedTool.id });
  const [run] = await context.database
    .select({ versionId: agentRun.profileVersionId }).from(agentRun).where(eq(agentRun.id, runId)).limit(1);
  await context.database.insert(agentToolGrant).values({
    profileVersionId: run!.versionId,
    toolId: tool!.id,
    enabled: true,
    allowedGroups: ["orcasynapse:people"],
    allowedAdminRoles: [],
  });
}

/**
 * A live MCP gateway credential: the one thing that makes the governed tool
 * plane answerable at all. `revoked` writes the row an operator's revocation
 * leaves behind, which authenticates nothing.
 */
async function issueGatewayCredential(options: { revoked?: boolean } = {}): Promise<void> {
  await context.database.insert(mcpGatewayCredential).values({
    name: "Hermes MCP client",
    tokenPrefix: `orca_mcp_${randomUUID().slice(0, 8)}`,
    tokenHash: Buffer.alloc(32, 7),
    enabled: true,
    revokedAt: options.revoked ? new Date() : null,
  });
}

async function finalState(runId: string) {
  const [row] = await context.database
    .select({ status: agentRun.status, failureCode: agentRun.failureCode, failureMessage: agentRun.failureMessage })
    .from(agentRun).where(eq(agentRun.id, runId)).limit(1);
  return row!;
}

/*
 * The tool switch, and the run switch, and why they are not the same switch.
 *
 * `ToolRuntimeControl.enabled` governs the MCP gateway: discovery, execution
 * and scope resolution each re-read it and each refuse fail-closed. Nothing
 * here can change that, and nothing here tries to.
 *
 * What the processor decides is narrower -- whether a run whose profile carries
 * an enabled grant on an ACTIVE tool should be *started* while that switch is
 * off. It used to decide "no", unconditionally, and that answer denied every
 * run on every fresh install: the migration grants `remember` and `recall` to
 * every profile version, and nothing ever writes the control row. Two grants
 * nobody chose, over a plane with no credential to authenticate a call with,
 * refusing every conversation in the product.
 *
 * These four tests pin the state machine the fix replaces it with. The second
 * is the one that enters the branch, and it is the reason the branch can still
 * be tested at all: `context.reset()` truncates the seeded tools and grants, so
 * a suite that does not write its own never reaches these lines.
 */
describe("DrizzleAgentProcessor governed tool plane", () => {
  it("starts a run whose only grants are on a plane no credential can reach", async () => {
    const { runId, jobId } = await seed();
    await grantActiveTool(runId, "remember");
    // No ToolRuntimeControl row and no gateway credential: the measured state of
    // a fresh install, immediately after an operator enables agent execution.

    const processor = new DrizzleAgentProcessor(context.database, runtime() as never, CAPABILITIES);
    await processor.process({ runId }, jobId, WORKER_ID);

    expect(await finalState(runId)).toMatchObject({ status: "COMPLETED", failureCode: null });
  });

  it("denies the run once a live credential exists and the tool switch is off", async () => {
    const { runId, jobId } = await seed();
    await grantActiveTool(runId, "remember");
    await issueGatewayCredential();

    const processor = new DrizzleAgentProcessor(context.database, runtime() as never, CAPABILITIES);
    await processor.process({ runId }, jobId, WORKER_ID);

    const state = await finalState(runId);
    expect(state.status).toBe("DENIED");
    expect(state.failureCode).toBe("TOOL_RUNTIME_DISABLED");
    // The message is the only thing an operator sees -- the dashboard prints the
    // code and this string and nothing else -- so it has to name the switch and
    // where to reach it. An endpoint rather than a screen, because the switch
    // has no screen: nothing in apps/web calls `updateToolRuntime` but its own
    // API-client test.
    expect(state.failureMessage).toContain("/api/v1/admin/tooling/runtime");
  });

  it("keeps denying against a credential an operator has revoked", async () => {
    const { runId, jobId } = await seed();
    await grantActiveTool(runId, "remember");
    await issueGatewayCredential({ revoked: true });

    const processor = new DrizzleAgentProcessor(context.database, runtime() as never, CAPABILITIES);
    await processor.process({ runId }, jobId, WORKER_ID);

    // A revoked credential authenticates nothing, so no tool call is reachable
    // and there is nothing for the run to be denied over.
    expect(await finalState(runId)).toMatchObject({ status: "COMPLETED", failureCode: null });
  });

  it("starts the run when the gateway is wired and switched on", async () => {
    const { runId, jobId } = await seed();
    await grantActiveTool(runId, "remember");
    await issueGatewayCredential();
    await context.database.insert(toolRuntimeControl).values({ id: "global", enabled: true });

    const processor = new DrizzleAgentProcessor(context.database, runtime() as never, CAPABILITIES);
    await processor.process({ runId }, jobId, WORKER_ID);

    expect(await finalState(runId)).toMatchObject({ status: "COMPLETED", failureCode: null });
  });
});

/*
 * The gap this closes, and why it is asserted here rather than against the
 * tooling manager.
 *
 * Every MCP call is authorized by `<runId>.<capability>`, and
 * `assertRunIsExecutable` refuses any run whose `toolCapabilityTokenHash` is
 * null. Nothing ever wrote one. `RunCapabilityIssuer` existed, had its own unit
 * test, and was constructed nowhere in production -- so every governed tool
 * call, for every run, was refused. The seeded `remember` and `recall` tools
 * were unreachable by construction rather than by configuration, which is why
 * no amount of installer work on VM2 would have made them callable.
 *
 * The capability is observed *during* the run, through the runtime's `start`
 * hook, because it must not outlive the run and the finaliser clears it. A test
 * reading the row after `process` returns would see null and prove nothing.
 */
describe("DrizzleAgentProcessor run capability", () => {
  it("mints the capability the tool gateway re-derives, at the moment it claims the run", async () => {
    const { runId, jobId } = await seed();
    const issuer = new RunCapabilityIssuer(Buffer.alloc(32, 3));
    // An array rather than a nullable local: the assignment happens inside a
    // callback, and control-flow analysis narrows a `let` to its initializer.
    const observed: Array<{ hash: Uint8Array | null; expiresAt: Date | null }> = [];
    const processor = new DrizzleAgentProcessor(context.database, runtime({
      start: async () => {
        const [row] = await context.database
          .select({ hash: agentRun.toolCapabilityTokenHash, expiresAt: agentRun.toolCapabilityExpiresAt })
          .from(agentRun).where(eq(agentRun.id, runId)).limit(1);
        observed.push({ hash: row?.hash ?? null, expiresAt: row?.expiresAt ?? null });
        return "hermes-native-capability";
      },
    }) as never, issuer);

    await processor.process({ runId }, jobId, WORKER_ID);

    expect(observed).toHaveLength(1);
    expect(observed[0]!.hash).not.toBeNull();
    // The gateway hashes the token it is handed and compares. Deriving the same
    // token from the same key and run id is what makes a retry safe, and it is
    // the property that lets PostgreSQL hold only the digest.
    expect(Buffer.from(observed[0]!.hash!)).toEqual(Buffer.from(issuer.issue(runId).tokenHash));
    // The run deadline, not the lease: a lease is 90s and renews, while a run
    // may legitimately last `timeoutSeconds`. The fixture's version sets 60.
    const expiresAt = observed[0]!.expiresAt!.getTime();
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 61_000);
  });

  /*
   * A capability outliving its run is a token that authorizes tool calls for a
   * run that has already answered. The finaliser has always cleared it; this
   * pins that minting did not quietly change what "cleared" means.
   */
  it("does not let the capability outlive the run", async () => {
    const { runId, jobId } = await seed();
    const processor = new DrizzleAgentProcessor(
      context.database,
      runtime() as never,
      new RunCapabilityIssuer(Buffer.alloc(32, 3)),
    );

    await processor.process({ runId }, jobId, WORKER_ID);

    const [row] = await context.database
      .select({ hash: agentRun.toolCapabilityTokenHash, expiresAt: agentRun.toolCapabilityExpiresAt, status: agentRun.status })
      .from(agentRun).where(eq(agentRun.id, runId)).limit(1);
    expect(row!.status).toBe("COMPLETED");
    expect(row!.hash).toBeNull();
    expect(row!.expiresAt).toBeNull();
  });
});

/**
 * Points the run's profile at a division, the way assigning one in the
 * dashboard does. `seed` leaves it null, which is the deployment-wide case.
 */
async function assignDivision(runId: string, displayName: string): Promise<string> {
  const [created] = await context.database.insert(division).values({
    slug: `div-${randomUUID().slice(0, 8)}`, displayName,
  }).returning({ id: division.id });
  const [run] = await context.database
    .select({ profileId: agentRun.profileId }).from(agentRun).where(eq(agentRun.id, runId)).limit(1);
  await context.database.update(agentProfile)
    .set({ divisionId: created!.id }).where(eq(agentProfile.id, run!.profileId));
  return created!.id;
}

/** The instructions actually handed to Hermes -- the seam every assertion here uses. */
async function submittedInstructions(runId: string, jobId: string): Promise<string> {
  const seen: string[] = [];
  const processor = new DrizzleAgentProcessor(context.database, runtime({
    start: async (input: { instructions?: string }) => {
      seen.push(input.instructions ?? "");
      return "hermes-native-memory";
    },
  }) as never, CAPABILITIES);
  await processor.process({ runId }, jobId, WORKER_ID);
  return seen[0] ?? "";
}

/*
 * Division-scoped memory, asserted where it is decided.
 *
 * The agent is given no memory tool and no division parameter. VM1 selects the
 * rows and puts them in the prompt, so there is nothing for the agent to ask
 * for and nothing to talk it into asking for. That makes the seam the
 * `instructions` argument handed to `hermes.start`, not a model reply.
 *
 * These are the tests the tool design could never have: with a tool, "does
 * division A see division B's rows" depends on what the agent chose to send.
 * Here it depends only on a WHERE clause, which is a thing a test can pin.
 */
describe("DrizzleAgentProcessor division memory", () => {
  it("injects the run division's memory and never another division's", async () => {
    const { runId, jobId } = await seed();
    const alpha = await assignDivision(runId, "Alpha");
    const [beta] = await context.database.insert(division)
      .values({ slug: `div-${randomUUID().slice(0, 8)}`, displayName: "Beta" }).returning({ id: division.id });
    await context.database.insert(scopedMemoryEntry).values([
      { divisionId: alpha, content: "Alpha settled on quarterly reviews." },
      { divisionId: beta!.id, content: "Beta settled on monthly reviews." },
      { divisionId: null, content: "Everyone uses the shared holiday calendar." },
    ]);

    const instructions = await submittedInstructions(runId, jobId);

    expect(instructions).toContain("Alpha settled on quarterly reviews.");
    expect(instructions).not.toContain("Beta settled on monthly reviews.");
    // A deployment-wide row is not this division's row. Divisions read their own
    // memory only; the shared plane is `MEMORY.md`, which Hermes owns.
    expect(instructions).not.toContain("Everyone uses the shared holiday calendar.");
  });

  /*
   * The mistake the recall handler's own comment warns about, pinned on this
   * side too: treating a null division as "no filter" rather than as its own
   * scope hands every division's rows to a run belonging to none. It is the one
   * error here that fails open.
   */
  it("treats a deployment-wide run as its own scope, not as a wildcard", async () => {
    const { runId, jobId } = await seed();
    const [other] = await context.database.insert(division)
      .values({ slug: `div-${randomUUID().slice(0, 8)}`, displayName: "Gamma" }).returning({ id: division.id });
    await context.database.insert(scopedMemoryEntry).values([
      { divisionId: null, content: "The deployment-wide retention rule is ninety days." },
      { divisionId: other!.id, content: "Gamma keeps records for seven years." },
    ]);

    const instructions = await submittedInstructions(runId, jobId);

    expect(instructions).toContain("The deployment-wide retention rule is ninety days.");
    expect(instructions).not.toContain("Gamma keeps records for seven years.");
  });

  /*
   * Relevance, not recency, and the reason it is a cost question rather than a
   * quality one.
   *
   * Recency ordering spends the same budget every turn regardless of what was
   * asked: past the cap, a division's oldest and most settled facts stop being
   * seen at all, while whatever happened to be written yesterday is carried
   * into every request. The note that answers the question is the one worth
   * paying for.
   */
  it("prefers a note that answers the question over newer ones that do not", async () => {
    const { runId, jobId } = await seed();
    const alpha = await assignDivision(runId, "Alpha");
    await context.database.insert(scopedMemoryEntry).values({
      divisionId: alpha, content: "The policy review happens every March.",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    /*
     * Enough newer, unrelated notes to push the relevant one past any
     * recency-ordered cap. This is the arrangement a division reaches by simply
     * being used.
     *
     * The decoys are written as ordinary English, and that is the whole point
     * of them rather than an aesthetic choice. They used to read "Unrelated
     * note number 3 about catering arrangements." -- which shares no word at
     * all with "Summarize the policy.", not even *the*. So this test passed
     * against a tokenizer that kept every stop word, because its fixtures
     * happened to contain none: rewriting one decoy to start with "The" was
     * enough to fail it. Each of these now carries the words a question is
     * likeliest to share with any note -- the, and, for, you, can, are -- so a
     * tokenizer that ORs them into the tsquery injects all forty-five here and
     * this fails, rather than waiting for somebody to write a natural sentence
     * in production.
     */
    await context.database.insert(scopedMemoryEntry).values(
      [...Array(45).keys()].map((index) => ({
        divisionId: alpha,
        content:
          `The catering arrangements for meeting room ${index} are the same as they have always been, `
          + "and you can change them for an event if you ask on the day before.",
        createdAt: new Date(`2026-08-${String((index % 27) + 1).padStart(2, "0")}T00:00:00.000Z`),
      })),
    );

    // The seeded run asks "Summarize the policy."
    const instructions = await submittedInstructions(runId, jobId);

    expect(instructions).toContain("The policy review happens every March.");
    expect(instructions).not.toContain("catering arrangements");
  });

  /*
   * The floor, and why it is not zero.
   *
   * Lexical matching returns nothing for a question sharing no vocabulary with
   * any note -- which includes most greetings and follow-ups. Injecting nothing
   * there would make a division's standing facts invisible exactly when a
   * conversation is getting started.
   */
  it("still carries recent notes when the question matches none of them", async () => {
    const { runId, jobId } = await seed({ input: "Hello." });
    const alpha = await assignDivision(runId, "Alpha");
    await context.database.insert(scopedMemoryEntry).values(
      [...Array(9).keys()].map((index) => ({
        divisionId: alpha, content: `Standing fact number ${index} about invoicing.`,
      })),
    );

    const instructions = await submittedInstructions(runId, jobId);

    expect(instructions).toContain("about invoicing");
    // Bounded, not the whole store: the floor exists so the agent is not blind,
    // not so an unmatched question costs the same as a matched one.
    expect(instructions.match(/Standing fact number/g) ?? []).toHaveLength(5);
  });

  /*
   * The two-character terms a question is most specific about.
   *
   * The tokenizer used to drop everything under three characters, calling it
   * stop-word handling, which meant `Q3`, `AI`, `HR`, `VP` and `EU` never
   * reached the query at all -- while `the` and `and` did. Now that a real stop
   * list does that job, the floor only drops single characters.
   *
   * "Any update on Q3?" leaves *update* and *q3*. The note that answers it says
   * nothing about an update, so `q3` is the only term that can find it: a floor
   * back at three characters empties the query of everything but *update*,
   * matches nothing, and hands back the five newest notes instead -- none of
   * which is the one asked for.
   */
  it("searches on a two-character term a question turns on", async () => {
    const { runId, jobId } = await seed({ input: "Any update on Q3?" });
    const alpha = await assignDivision(runId, "Alpha");
    await context.database.insert(scopedMemoryEntry).values({
      divisionId: alpha,
      content: "Q3 closed ahead of the plan, and the board was told in September.",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await context.database.insert(scopedMemoryEntry).values(
      [...Array(9).keys()].map((index) => ({
        divisionId: alpha,
        content: `The visitor badges for building ${index} are collected at the desk, and you sign them back in.`,
        createdAt: new Date(`2026-08-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`),
      })),
    );

    const instructions = await submittedInstructions(runId, jobId);

    expect(instructions).toContain("Q3 closed ahead of the plan");
    expect(instructions).not.toContain("visitor badges");
  });

  /*
   * A question with no content words, which is the state the stop-word filter
   * is most easily got wrong in.
   *
   * "Can you do that for me?" is six stop words and nothing else, so it carries
   * no lexical signal and belongs on the recency floor. A tokenizer that keeps
   * stop words instead ORs *can*, *you*, *do*, *that* and *for* into the
   * tsquery, every note containing any of them matches, and the request pays
   * for twenty ranked-by-frequency notes chosen by a question that asked for
   * none of them. The count is the assertion: five is the floor, twenty is the
   * match cap.
   */
  it("falls to the floor for a question made only of stop words", async () => {
    const { runId, jobId } = await seed({ input: "Can you do that for me?" });
    const alpha = await assignDivision(runId, "Alpha");
    await context.database.insert(scopedMemoryEntry).values(
      [...Array(12).keys()].map((index) => ({
        divisionId: alpha,
        content: `The invoicing rule number ${index} is that you can send it for approval on the same day.`,
      })),
    );

    const instructions = await submittedInstructions(runId, jobId);

    expect(instructions.match(/The invoicing rule number/g) ?? []).toHaveLength(5);
  });

  /*
   * An empty section would read to the model as "your division has learned
   * nothing", which is a claim rather than an absence -- and on a fresh install
   * it is the only state there is.
   */
  it("says nothing at all when the division has remembered nothing", async () => {
    const { runId, jobId } = await seed();
    await assignDivision(runId, "Delta");

    const instructions = await submittedInstructions(runId, jobId);

    expect(instructions).not.toContain("WHAT YOUR DIVISION HAS LEARNED");
  });
});

/*
 * Extraction: how the store fills without an agent ever calling a tool.
 *
 * The model is shown the exchange and returns text. It is never told a
 * division and never asked where a note should go -- the processor decides
 * that from the run, the same source the read side uses. So the tests that
 * matter are about where a note lands and what happens when extraction fails,
 * not about the quality of what comes back.
 */
describe("DrizzleAgentProcessor run-event retention", () => {
  /** Writes events directly, which is what the stream does one chunk at a time. */
  async function events(runId: string, type: string, count: number) {
    await context.database.insert(agentRunEvent).values(
      Array.from({ length: count }, (_value, index) => ({
        runId, type, ...(type === "MESSAGE_DELTA" ? { delta: `chunk-${index}` } : { toolName: `tool-${index}` }),
      })),
    );
  }

  async function remaining(runId: string) {
    const rows = await context.database
      .select({ type: agentRunEvent.type }).from(agentRunEvent).where(eq(agentRunEvent.runId, runId));
    return {
      deltas: rows.filter(({ type }) => type === "MESSAGE_DELTA").length,
      other: rows.filter(({ type }) => type !== "MESSAGE_DELTA").length,
    };
  }

  it("discards the token chunks of a long-finished run and keeps its activity trail", async () => {
    /*
     * `AgentRunEvent` is one row per streamed chunk and nothing pruned it -- no
     * job, no migration, no delete anywhere. Survivable while every run began
     * with somebody typing; not once an unattended dispatcher could start one on
     * a cadence.
     *
     * Only the deltas go, and only for a terminal run past the window: the
     * transcript reads coalesced text from `ChatMessage.content`, and tool calls
     * and status changes are the trail an operator actually reads.
     */
    const { runId } = await seed();
    await context.database.update(agentRun)
      .set({ status: "COMPLETED", completedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000) })
      .where(eq(agentRun.id, runId));
    await events(runId, "MESSAGE_DELTA", 40);
    await events(runId, "TOOL_CALL", 3);

    const removed = await new DrizzleAgentProcessor(
      context.database, runtime() as never, CAPABILITIES,
    ).pruneRunEvents();

    expect(removed).toBe(40);
    expect(await remaining(runId)).toEqual({ deltas: 0, other: 3 });
  });

  it("leaves a run that is still going entirely alone, however old its events are", async () => {
    // Driven by the run's terminal state, not the event's own age: an event
    // belonging to a live run is never a candidate, and a live run is exactly
    // the one whose stream may still be resuming by cursor.
    const { runId } = await seed();
    await events(runId, "MESSAGE_DELTA", 10);

    const removed = await new DrizzleAgentProcessor(
      context.database, runtime() as never, CAPABILITIES,
    ).pruneRunEvents();

    expect(removed).toBe(0);
    expect(await remaining(runId)).toEqual({ deltas: 10, other: 0 });
  });

  it("keeps a run that finished recently, so the ledger still replays it", async () => {
    const { runId } = await seed();
    await context.database.update(agentRun)
      .set({ status: "COMPLETED", completedAt: new Date() })
      .where(eq(agentRun.id, runId));
    await events(runId, "MESSAGE_DELTA", 10);

    expect(await new DrizzleAgentProcessor(
      context.database, runtime() as never, CAPABILITIES,
    ).pruneRunEvents()).toBe(0);
  });
});

describe("DrizzleAgentProcessor memory extraction", () => {
  function extractor(notes: string[] | (() => never)): MemoryExtractor {
    return { extract: async () => (typeof notes === "function" ? notes() : notes) };
  }

  it("writes what it extracted into the run's own division", async () => {
    const { runId, jobId } = await seed();
    const alpha = await assignDivision(runId, "Alpha");
    const processor = new DrizzleAgentProcessor(
      context.database, runtime() as never, CAPABILITIES,
      extractor(["Alpha reconciles supplier invoices weekly."]),
    );

    await processor.process({ runId }, jobId, WORKER_ID);
    await processor.drainMemoryExtraction();

    const rows = await context.database.select().from(scopedMemoryEntry);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.divisionId).toBe(alpha);
    expect(rows[0]?.runId).toBe(runId);
    expect(rows[0]?.content).toBe("Alpha reconciles supplier invoices weekly.");
  });

  /*
   * The property that lets extraction be permissive about what it keeps.
   *
   * A note lands in the division of the run that produced it, and the model has
   * no say in that -- it returns strings and nothing else. So the worst a bad
   * extraction can do is write a poor note into the division that was already
   * reading the conversation it came from. It cannot cross a division, which is
   * why a wrong note is a quality problem rather than a disclosure.
   */
  it("cannot place a note in a division the run does not belong to", async () => {
    const { runId, jobId } = await seed();
    const alpha = await assignDivision(runId, "Alpha");
    const [beta] = await context.database.insert(division)
      .values({ slug: `div-${randomUUID().slice(0, 8)}`, displayName: "Beta" }).returning({ id: division.id });
    const processor = new DrizzleAgentProcessor(
      context.database, runtime() as never, CAPABILITIES,
      // The extractor tries to name another division, the way a prompt-injected
      // exchange would. There is no parameter for it to name one with.
      extractor([`Route this to division ${beta!.id} instead.`]),
    );

    await processor.process({ runId }, jobId, WORKER_ID);
    await processor.drainMemoryExtraction();

    const rows = await context.database.select().from(scopedMemoryEntry);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.divisionId).toBe(alpha);
  });

  it("keeps notes in the division the run executed under after the profile is re-homed", async () => {
    const { runId, jobId } = await seed();
    const alpha = await assignDivision(runId, "Alpha");
    const processor = new DrizzleAgentProcessor(
      context.database, runtime() as never, CAPABILITIES,
      extractor(["Alpha still owns this note."]),
    );

    await processor.process({ runId }, jobId, WORKER_ID);
    const [beta] = await context.database.insert(division)
      .values({ slug: `div-${randomUUID().slice(0, 8)}`, displayName: "Beta" }).returning({ id: division.id });
    const [run] = await context.database
      .select({ profileId: agentRun.profileId }).from(agentRun).where(eq(agentRun.id, runId)).limit(1);
    await context.database.update(agentProfile)
      .set({ divisionId: beta!.id }).where(eq(agentProfile.id, run!.profileId));
    await processor.drainMemoryExtraction();

    const rows = await context.database.select().from(scopedMemoryEntry);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.divisionId).toBe(alpha);
  });

  /*
   * The one that decides whether this feature is safe to enable at all. A note
   * is worth less than the answer, so extraction failing must cost the note.
   */
  it("still completes the run when extraction throws", async () => {
    const { runId, jobId, messageId } = await seed();
    const processor = new DrizzleAgentProcessor(
      context.database, runtime() as never, CAPABILITIES,
      extractor(() => { throw new Error("The inference endpoint is unreachable."); }),
    );

    const result = await processor.process({ runId }, jobId, WORKER_ID);
    await processor.drainMemoryExtraction();

    expect(result).toMatchObject({ status: "COMPLETED" });
    const [message] = await context.database.select().from(chatMessage).where(eq(chatMessage.id, messageId));
    expect(message?.status).toBe("COMPLETED");
    expect(await context.database.select().from(scopedMemoryEntry)).toHaveLength(0);
  });

  /*
   * Dedup, and why it is more than tidiness.
   *
   * Extraction restates the same durable fact across turns -- that is what
   * makes it durable -- so without this a division accumulates one copy per
   * conversation that touched the subject, and every later run pays context for
   * each of them.
   *
   * It is also what makes the write idempotent, which the sweeper in piece C
   * depends on: a batch retried after a partial failure must not rewrite what
   * it already wrote.
   */
  it("does not write a note the division already has", async () => {
    const { runId, jobId } = await seed();
    const alpha = await assignDivision(runId, "Alpha");
    await context.database.insert(scopedMemoryEntry).values({
      divisionId: alpha, content: "Alpha reconciles supplier invoices weekly.",
    });
    const processor = new DrizzleAgentProcessor(
      context.database, runtime() as never, CAPABILITIES,
      extractor(["Alpha reconciles supplier invoices weekly.", "Alpha uses a two-signature rule."]),
    );

    await processor.process({ runId }, jobId, WORKER_ID);
    await processor.drainMemoryExtraction();

    const rows = await context.database.select().from(scopedMemoryEntry);
    expect(rows).toHaveLength(2);
    expect(rows.map(({ content }) => content).sort()).toEqual([
      "Alpha reconciles supplier invoices weekly.",
      "Alpha uses a two-signature rule.",
    ]);
  });

  /*
   * Dedup is scoped, like everything else here. The same sentence held by two
   * divisions is two facts about two organisations, not one duplicated -- and a
   * dedup that reached across divisions would silently deny one of them a note
   * because another already had it.
   */
  it("treats an identical note in another division as a different note", async () => {
    const { runId, jobId } = await seed();
    const alpha = await assignDivision(runId, "Alpha");
    const [beta] = await context.database.insert(division)
      .values({ slug: `div-${randomUUID().slice(0, 8)}`, displayName: "Beta" }).returning({ id: division.id });
    await context.database.insert(scopedMemoryEntry).values({
      divisionId: beta!.id, content: "Invoices are approved by two people.",
    });
    const processor = new DrizzleAgentProcessor(
      context.database, runtime() as never, CAPABILITIES,
      extractor(["Invoices are approved by two people."]),
    );

    await processor.process({ runId }, jobId, WORKER_ID);
    await processor.drainMemoryExtraction();

    const rows = await context.database.select().from(scopedMemoryEntry);
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.divisionId === alpha)).toHaveLength(1);
  });

  /*
   * The point of the whole piece: the processor slot is released with the
   * answer, not with the note.
   *
   * Asserted as an absence immediately after `process` returns, because that is
   * the only observable difference between running extraction inline and
   * running it on a timer. Written before the sweep on purpose -- reorder these
   * two lines and the test says nothing at all.
   */
  it("does not extract while it holds the processor slot", async () => {
    const { runId, jobId } = await seed();
    await assignDivision(runId, "Alpha");
    const processor = new DrizzleAgentProcessor(
      context.database, runtime() as never, CAPABILITIES,
      extractor(["Something durable."]),
    );

    await processor.process({ runId }, jobId, WORKER_ID);
    expect(await context.database.select().from(scopedMemoryEntry)).toHaveLength(0);

    await processor.drainMemoryExtraction();
    expect(await context.database.select().from(scopedMemoryEntry)).toHaveLength(1);
  });

  /*
   * A run is claimed, not attempted-until-successful.
   *
   * If the mark were written only on success, a run whose extraction fails --
   * an endpoint down, a model refusing -- would be re-claimed on every sweep
   * forever, spending a model call each time and never succeeding for the same
   * reason it failed first. One lost note is the cheaper failure.
   */
  it("does not retry a run whose extraction failed", async () => {
    const { runId, jobId } = await seed();
    await assignDivision(runId, "Alpha");
    let attempts = 0;
    const processor = new DrizzleAgentProcessor(
      context.database, runtime() as never, CAPABILITIES,
      { extract: async () => { attempts += 1; throw new Error("The endpoint is unreachable."); } },
    );

    await processor.process({ runId }, jobId, WORKER_ID);
    await processor.drainMemoryExtraction();
    await processor.drainMemoryExtraction();
    await processor.drainMemoryExtraction();

    expect(attempts).toBe(1);
  });

  /*
   * Two sweeps must not extract the same run twice, which is what `FOR UPDATE
   * SKIP LOCKED` inside the claim is for.
   *
   * Asserted by sweeping twice and counting, per the plan -- reading the SQL and
   * agreeing it looks right is exactly the check that has failed repeatedly in
   * this work.
   */
  it("claims each run once across repeated sweeps", async () => {
    const { runId, jobId } = await seed();
    await assignDivision(runId, "Alpha");
    const processor = new DrizzleAgentProcessor(
      context.database, runtime() as never, CAPABILITIES,
      extractor(["Alpha settles invoices on Fridays."]),
    );
    await processor.process({ runId }, jobId, WORKER_ID);

    const [first, second] = await Promise.all([
      processor.drainMemoryExtraction(),
      processor.drainMemoryExtraction(),
    ]);

    expect(first + second).toBe(1);
    expect(await context.database.select().from(scopedMemoryEntry)).toHaveLength(1);
  });

  /*
   * The lookback, which matters exactly once and then never again: the first
   * sweep after this ships sees every completed run the installation has ever
   * had, all of them unmarked.
   */
  it("leaves runs older than the lookback window alone", async () => {
    const { runId, jobId } = await seed();
    await assignDivision(runId, "Alpha");
    const processor = new DrizzleAgentProcessor(
      context.database, runtime() as never, CAPABILITIES, extractor(["Something durable."]),
    );
    await processor.process({ runId }, jobId, WORKER_ID);
    await context.database.update(agentRun)
      .set({ completedAt: new Date(Date.now() - 48 * 60 * 60 * 1_000) })
      .where(eq(agentRun.id, runId));

    expect(await processor.drainMemoryExtraction()).toBe(0);
    expect(await context.database.select().from(scopedMemoryEntry)).toHaveLength(0);
  });

  /*
   * The switch, checked before the claim rather than after.
   *
   * Checking after would still mark every run as extracted, so everything
   * learned while it was off would be silently discarded and turning it back on
   * would recover none of it. The assertion is therefore on the run staying
   * unclaimed, not merely on no rows being written.
   */
  it("extracts nothing while the deployment switch is off, and forgets nothing", async () => {
    const { runId, jobId } = await seed();
    await assignDivision(runId, "Alpha");
    await context.database.update(agentRuntimeControl).set({ memoryExtractionEnabled: false });
    const processor = new DrizzleAgentProcessor(
      context.database, runtime() as never, CAPABILITIES, extractor(["Something durable."]),
    );

    await processor.process({ runId }, jobId, WORKER_ID);
    expect(await processor.drainMemoryExtraction()).toBe(0);

    expect(await context.database.select().from(scopedMemoryEntry)).toHaveLength(0);
    // Still owed. Turning the switch back on must recover the run, not skip it.
    const [run] = await context.database.select().from(agentRun).where(eq(agentRun.id, runId));
    expect(run?.memoryExtractedAt).toBeNull();

    await context.database.update(agentRuntimeControl).set({ memoryExtractionEnabled: true });
    expect(await processor.drainMemoryExtraction()).toBe(1);
    expect(await context.database.select().from(scopedMemoryEntry)).toHaveLength(1);
  });

  it("records what it kept and what it was offered", async () => {
    const { runId, jobId } = await seed();
    const alpha = await assignDivision(runId, "Alpha");
    await context.database.insert(scopedMemoryEntry).values({
      divisionId: alpha, content: "Already known.",
    });
    const processor = new DrizzleAgentProcessor(
      context.database, runtime() as never, CAPABILITIES,
      extractor(["Already known.", "Newly learned."]),
    );

    await processor.process({ runId }, jobId, WORKER_ID);
    await processor.drainMemoryExtraction();

    const [event] = await context.database.select().from(auditEvent)
      .where(eq(auditEvent.action, "memory.entry_extracted"));
    expect(event?.resourceId).toBe(runId);
    // Both counts, because "kept 1" alone cannot tell a quiet model from an
    // effective dedup, and those want different responses from an operator.
    expect(event?.metadata).toMatchObject({ kept: 1, offered: 2, divisionId: alpha });
  });

  it("writes nothing when there was nothing worth keeping", async () => {
    const { runId, jobId } = await seed();
    const processor = new DrizzleAgentProcessor(
      context.database, runtime() as never, CAPABILITIES, extractor([]),
    );

    await processor.process({ runId }, jobId, WORKER_ID);
    await processor.drainMemoryExtraction();

    expect(await context.database.select().from(scopedMemoryEntry)).toHaveLength(0);
  });
});

describe("DrizzleAgentProcessor finalisation", () => {
  it("writes the end-of-run marker with the completion, and leaves the cursor on the last delivered event", async () => {
    const { runId, jobId, messageId } = await seed();
    const processor = new DrizzleAgentProcessor(context.database, runtime({
      events: async (_runId, onEvent) => {
        await onEvent({
          sourceEventId: "upstream:1",
          type: "MESSAGE_DELTA",
          delta: "The policy ",
          preview: null,
          errorCode: null,
          summary: null,
          status: null,
          toolName: null,
          toolCallKey: null,
          text: null,
          childSessionId: null,
          durationMs: null,
          inputTokens: null,
          outputTokens: null,
          reasoningTokens: null,
          costUsd: null,
          approvalExternalId: null,
          approvalCommand: null,
          approvalChoices: [],
          occurredAt: new Date(),
        });
      },
    }), CAPABILITIES);

    expect(await processor.process({ runId }, jobId, WORKER_ID)).toMatchObject({ status: "COMPLETED" });

    const [run] = await context.database.select().from(agentRun).where(eq(agentRun.id, runId));
    expect(run?.status).toBe("COMPLETED");
    expect(run?.output).toBe("The policy permits it.");

    const written = await events(runId);
    const delta = written.find(({ type }) => type === "MESSAGE_DELTA");
    const markers = written.filter(({ type }) => type === AGENT_RUN_ENDED_EVENT_TYPE);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ status: "COMPLETED", errorCode: null });
    // Invariant: the marker is last, and does not advance the run's cursor. A
    // reader resuming from `lastEventCursor` has to meet the marker again and be
    // told the outcome again, or a reconnect after the end is a silent stream.
    expect(written.at(-1)?.type).toBe(AGENT_RUN_ENDED_EVENT_TYPE);
    expect(run?.lastEventCursor).toBe(Number(delta?.cursor));
    expect(Number(markers[0]!.cursor)).toBeGreaterThan(Number(delta?.cursor));

    const [message] = await context.database.select().from(chatMessage).where(eq(chatMessage.id, messageId));
    expect(message).toMatchObject({ status: "COMPLETED", content: "The policy permits it." });
  });

  it("rolls a completion back whole when the lease moved while Hermes was answering", async () => {
    const { runId, jobId, messageId } = await seed();
    const processor = new DrizzleAgentProcessor(context.database, runtime({
      status: async () => {
        await stealLease(runId);
        return completedState();
      },
    }), CAPABILITIES);

    expect(await processor.process({ runId }, jobId, WORKER_ID)).toEqual({ skipped: true, reason: "lease-lost" });

    // Nothing of the finalisation may survive: a marker written without the
    // status flip ends every subscriber's stream on a run that is still live,
    // and the worker that does hold the lease can no longer report the outcome.
    const [run] = await context.database.select().from(agentRun).where(eq(agentRun.id, runId));
    expect(run?.status).toBe("RUNNING");
    expect(run?.output).toBeNull();
    expect(run?.completedAt).toBeNull();
    expect(await events(runId)).toHaveLength(0);
    const [message] = await context.database.select().from(chatMessage).where(eq(chatMessage.id, messageId));
    expect(message?.status).toBe("PENDING");
  });

  it("rolls a failure back whole when the lease moved before it could be recorded", async () => {
    const { runId, jobId, messageId } = await seed();
    const processor = new DrizzleAgentProcessor(context.database, runtime({
      status: async () => {
        await stealLease(runId);
        return completedState({ status: "cancelled", output: null, finishReason: "cancelled" });
      },
    }), CAPABILITIES);

    expect(await processor.process({ runId }, jobId, WORKER_ID)).toEqual({ skipped: true, reason: "lease-lost" });

    const [run] = await context.database.select().from(agentRun).where(eq(agentRun.id, runId));
    expect(run?.status).toBe("RUNNING");
    expect(run?.failureCode).toBeNull();
    expect(await events(runId)).toHaveLength(0);
    const [message] = await context.database.select().from(chatMessage).where(eq(chatMessage.id, messageId));
    expect(message?.status).toBe("PENDING");
  });
});

describe("DrizzleAgentProcessor inheriting a run", () => {
  /*
   * The failure a restart actually produces, and what it has to say.
   *
   * A worker that dies mid-answer leaves `externalRunId` persisted, so the
   * worker that re-claims the run skips `start` and asks Hermes about a native
   * session turn it never submitted. That cannot be resumed -- see
   * HermesRunDetachedError -- and the run has to end, but ending it as a
   * generic execution failure hides the part that matters: Hermes kept the
   * exchange, so the next message in this conversation is answered with context
   * the reader was told never happened.
   */
  it("ends a run it cannot attach to with a code that names the divergence", async () => {
    const { runId, jobId, messageId } = await seed({
      status: "RUNNING",
      externalRunId: "hermes-native-orphaned",
      startedAt: new Date(),
    });
    const detached = () => Promise.reject(new HermesRunDetachedError("hermes-native-orphaned"));
    const processor = new DrizzleAgentProcessor(context.database, runtime({
      start: async () => { throw new Error("A run with an external id must never be submitted twice."); },
      status: detached,
      events: detached,
    }), CAPABILITIES);

    expect(await processor.process({ runId }, jobId, WORKER_ID)).toMatchObject({ status: "FAILED" });

    const [run] = await context.database.select().from(agentRun).where(eq(agentRun.id, runId));
    expect(run?.status).toBe("FAILED");
    expect(run?.failureCode).toBe("HERMES_RUN_DETACHED");
    expect(run?.failureMessage).toContain("Hermes still holds this exchange");

    const markers = (await events(runId)).filter(({ type }) => type === AGENT_RUN_ENDED_EVENT_TYPE);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ status: "FAILED", errorCode: "HERMES_RUN_DETACHED" });

    const [message] = await context.database.select().from(chatMessage).where(eq(chatMessage.id, messageId));
    expect(message).toMatchObject({ status: "FAILED", errorCode: "HERMES_RUN_DETACHED" });

    // The stream did not degrade; it was never attachable. Recording it as
    // degraded promises an operator that status polling reconciled the gap.
    const audits = await context.database.select().from(auditEvent);
    expect(audits.map(({ action }) => action)).not.toContain("agent.run_event_stream_degraded");
  });
});

async function bindConversation(fixture: Fixture): Promise<void> {
  await context.database.update(agentRun)
    .set({ sessionId: fixture.conversationId })
    .where(eq(agentRun.id, fixture.runId));
}

async function attachUpload(options: {
  conversationId: string;
  messageId: string | null;
  name: string;
  mediaType: string;
  bytes?: Uint8Array;
  sizeBytes?: number;
  storage?: "INLINE" | "NODE";
  createdAt?: Date;
}): Promise<string> {
  const bytes = options.bytes ?? new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const storage = options.storage ?? "INLINE";
  const [row] = await context.database.insert(chatArtifact).values({
    conversationId: options.conversationId,
    messageId: options.messageId,
    origin: "UPLOADED",
    ownerSubject: "user:pilot",
    name: options.name,
    path: options.name,
    mediaType: options.mediaType,
    sizeBytes: options.sizeBytes ?? bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    storage,
    observedAt: options.createdAt ?? new Date(),
    createdAt: options.createdAt ?? new Date(),
  }).returning({ id: chatArtifact.id });
  if (storage === "INLINE") {
    await context.database.insert(chatArtifactContent).values({ artifactId: row!.id, bytes });
  }
  return row!.id;
}

async function submittedStart(runId: string, jobId: string): Promise<HermesRunSubmission> {
  let seen: HermesRunSubmission | undefined;
  const processor = new DrizzleAgentProcessor(context.database, runtime({
    start: async (input) => {
      const [row] = await context.database
        .select({ externalRunId: agentRun.externalRunId })
        .from(agentRun).where(eq(agentRun.id, runId)).limit(1);
      expect(row?.externalRunId).toBe(nativeRunId(runId));
      seen = input;
      return "hermes-native-inject";
    },
  }) as never, CAPABILITIES);
  await processor.process({ runId }, jobId, WORKER_ID);
  if (!seen) throw new Error("Hermes start was not called.");
  return seen;
}

describe("DrizzleAgentProcessor this-turn image inject", () => {
  it("omits images when sessionId is not the conversation that owns uploads", async () => {
    const fixture = await seed();
    await attachUpload({
      conversationId: fixture.conversationId,
      messageId: fixture.userMessageId,
      name: "canonical.png",
      mediaType: "image/png",
      bytes: new Uint8Array([1, 2, 3, 4]),
    });

    const start = await submittedStart(fixture.runId, fixture.jobId);
    expect(start.images).toBeUndefined();
    expect(start.input).toBe("Summarize the policy.");
  });

  it("injects a this-turn PNG and not one bound to an older message", async () => {
    const fixture = await seed();
    await bindConversation(fixture);
    const olderUser = randomUUID();
    await context.database.insert(chatMessage).values({
      id: olderUser, conversationId: fixture.conversationId, ordinal: 0,
      role: "USER", status: "COMPLETED", content: "earlier",
    });
    await attachUpload({
      conversationId: fixture.conversationId,
      messageId: olderUser,
      name: "old.png",
      mediaType: "image/png",
      bytes: new Uint8Array([9, 9, 9]),
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
    });
    const thisTurnId = await attachUpload({
      conversationId: fixture.conversationId,
      messageId: fixture.userMessageId,
      name: "canonical.png",
      mediaType: "image/png",
      bytes: new Uint8Array([1, 2, 3, 4]),
      createdAt: new Date("2026-08-02T00:00:00.000Z"),
    });

    const start = await submittedStart(fixture.runId, fixture.jobId);
    expect(start.images).toEqual([{ mediaType: "image/png", base64: Buffer.from([1, 2, 3, 4]).toString("base64") }]);
    expect(start.input).toBe("Summarize the policy.");
    expect(start.instructions).toContain("canonical.png");
    expect(start.instructions).toContain("on this turn");
    expect(start.instructions).toContain("old.png");
    expect(start.instructions).toContain("on the control plane");
    expect(start.instructions).not.toContain("read_file");
    expect(nativeSessionChatBody(start)).toEqual({
      message: [
        { type: "text", text: "Summarize the policy." },
        { type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.from([1, 2, 3, 4]).toString("base64")}` } },
      ],
      instructions: start.instructions,
      model: "hermes-agent",
    });
    const [stored] = await context.database.select({ input: agentRun.input }).from(agentRun).where(eq(agentRun.id, fixture.runId));
    expect(stored?.input).toBe("Summarize the policy.");
    expect(stored?.input).not.toContain(thisTurnId);
    expect(stored?.input).not.toContain("base64");
  });

  it("still injects when assistant agentRunId is still null at process start", async () => {
    const fixture = await seed();
    await bindConversation(fixture);
    await context.database.update(chatMessage)
      .set({ agentRunId: null })
      .where(eq(chatMessage.id, fixture.messageId));
    await attachUpload({
      conversationId: fixture.conversationId,
      messageId: fixture.userMessageId,
      name: "canonical.png",
      mediaType: "image/png",
      bytes: new Uint8Array([5, 6, 7]),
    });

    const start = await submittedStart(fixture.runId, fixture.jobId);
    expect(start.images).toEqual([{ mediaType: "image/png", base64: Buffer.from([5, 6, 7]).toString("base64") }]);
  });

  it("follows a stamped FAILED assistant rather than a newer PENDING", async () => {
    const fixture = await seed();
    await bindConversation(fixture);
    await context.database.update(chatMessage)
      .set({ status: "FAILED" })
      .where(eq(chatMessage.id, fixture.messageId));
    const newerUser = randomUUID();
    await context.database.insert(chatMessage).values([
      { id: newerUser, conversationId: fixture.conversationId, ordinal: 3, role: "USER", status: "COMPLETED", content: "second" },
      { conversationId: fixture.conversationId, ordinal: 4, role: "ASSISTANT", status: "PENDING", content: "" },
    ]);
    await attachUpload({
      conversationId: fixture.conversationId,
      messageId: fixture.userMessageId,
      name: "first.png",
      mediaType: "image/png",
      bytes: new Uint8Array([1]),
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
    });
    await attachUpload({
      conversationId: fixture.conversationId,
      messageId: newerUser,
      name: "second.png",
      mediaType: "image/png",
      bytes: new Uint8Array([2]),
      createdAt: new Date("2026-08-02T00:00:00.000Z"),
    });

    const start = await submittedStart(fixture.runId, fixture.jobId);
    expect(start.images).toEqual([{ mediaType: "image/png", base64: Buffer.from([1]).toString("base64") }]);
    expect(start.instructions).toContain("first.png (image/png, 1 KB) on this turn");
    expect(start.instructions).toContain("second.png (image/png, 1 KB) on the control plane");
  });

  it("drops the oldest this-turn PNG from the tail when the combined JSON exceeds 9e6", async () => {
    const fixture = await seed();
    await bindConversation(fixture);
    const newestBytes = new Uint8Array(3_400_000).fill(11);
    const oldestBytes = new Uint8Array(3_400_000).fill(22);
    await attachUpload({
      conversationId: fixture.conversationId,
      messageId: fixture.userMessageId,
      name: "oldest.png",
      mediaType: "image/png",
      bytes: oldestBytes,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
    });
    await attachUpload({
      conversationId: fixture.conversationId,
      messageId: fixture.userMessageId,
      name: "newest.png",
      mediaType: "image/png",
      bytes: newestBytes,
      createdAt: new Date("2026-08-02T00:00:00.000Z"),
    });

    const start = await submittedStart(fixture.runId, fixture.jobId);
    expect(start.images).toEqual([{
      mediaType: "image/png",
      base64: Buffer.from(newestBytes).toString("base64"),
    }]);
    expect(start.instructions).toContain("newest.png");
    expect(start.instructions).toContain("on this turn");
    expect(start.instructions).toContain("oldest.png");
    expect(start.instructions).toContain("not inlined this turn (budget)");
  });

  it("skips a this-turn PNG with reason ceiling when the prompt already fills the input ceiling", async () => {
    const fixture = await seed({ input: "x".repeat(128_000) });
    await bindConversation(fixture);
    await attachUpload({
      conversationId: fixture.conversationId,
      messageId: fixture.userMessageId,
      name: "tight.png",
      mediaType: "image/png",
      bytes: new Uint8Array([1, 2, 3]),
    });

    const start = await submittedStart(fixture.runId, fixture.jobId);
    expect(start.images).toBeUndefined();
    expect(start.input).toBe("x".repeat(128_000));
    expect(start.instructions).toContain("not inlined this turn (ceiling)");
  });

  it("skips all inject with reason policy when only never-activated drafts exist", async () => {
    const fixture = await seed();
    await bindConversation(fixture);
    await context.database.insert(guardrailPolicy).values({
      slug: `policy-${randomUUID().slice(0, 8)}`,
      displayName: "Drafted guardrails",
      description: "Written but never activated.",
      version: "1",
      status: "DRAFT",
      maxInputCharacters: 32_000,
      maxOutputCharacters: 64_000,
      firstActivatedAt: null,
      rules: [],
    });
    await attachUpload({
      conversationId: fixture.conversationId,
      messageId: fixture.userMessageId,
      name: "canonical.png",
      mediaType: "image/png",
      bytes: new Uint8Array([1, 2, 3]),
    });
    await attachUpload({
      conversationId: fixture.conversationId,
      messageId: fixture.userMessageId,
      name: "notes.txt",
      mediaType: "text/plain",
      bytes: new TextEncoder().encode("hello notes"),
    });

    const start = await submittedStart(fixture.runId, fixture.jobId);
    expect(start.images).toBeUndefined();
    expect(start.textExcerpts).toBeUndefined();
    expect(start.instructions).toContain("not inlined this turn (policy)");
  });

  it("records skip reasons budget, count, and not-injectable", async () => {
    const fixture = await seed();
    await bindConversation(fixture);
    await attachUpload({
      conversationId: fixture.conversationId,
      messageId: fixture.userMessageId,
      name: "huge.png",
      mediaType: "image/png",
      bytes: new Uint8Array([1]),
      sizeBytes: 8_000_000,
      createdAt: new Date("2026-08-06T00:00:00.000Z"),
    });
    await attachUpload({
      conversationId: fixture.conversationId,
      messageId: fixture.userMessageId,
      name: "vector.svg",
      mediaType: "image/svg+xml",
      bytes: new Uint8Array([1]),
      createdAt: new Date("2026-08-05T12:00:00.000Z"),
    });
    for (const index of [1, 2, 3, 4, 5]) {
      await attachUpload({
        conversationId: fixture.conversationId,
        messageId: fixture.userMessageId,
        name: `shot-${index}.png`,
        mediaType: "image/png",
        bytes: new Uint8Array([index]),
        createdAt: new Date(`2026-08-0${index}T00:00:00.000Z`),
      });
    }

    const start = await submittedStart(fixture.runId, fixture.jobId);
    expect(start.images).toHaveLength(4);
    expect(start.instructions).toContain("huge.png");
    expect(start.instructions).toContain("not inlined this turn (budget)");
    expect(start.instructions).toContain("vector.svg");
    expect(start.instructions).toContain("not inlined this turn (not-injectable)");
    expect(start.instructions).toContain("shot-1.png");
    expect(start.instructions).toContain("not inlined this turn (count)");
    expect(start.instructions).toContain("shot-5.png");
    expect(start.instructions).toContain("on this turn");
  });

  it("injects a scheduled-style upload stamped on the user message", async () => {
    const fixture = await seed();
    await bindConversation(fixture);
    await attachUpload({
      conversationId: fixture.conversationId,
      messageId: fixture.userMessageId,
      name: "schedule.png",
      mediaType: "image/jpeg; charset=binary",
      bytes: new Uint8Array([8, 8, 8]),
    });

    const start = await submittedStart(fixture.runId, fixture.jobId);
    expect(start.images).toEqual([{ mediaType: "image/jpeg", base64: Buffer.from([8, 8, 8]).toString("base64") }]);
    expect(JSON.stringify(nativeSessionChatBody(start))).toContain("data:image/jpeg;base64,");
  });

  it("measures the JSON body budget against the same instructions start receives, including memory", async () => {
    const fixture = await seed();
    await bindConversation(fixture);
    const alpha = await assignDivision(fixture.runId, "Alpha");
    const note = `Alpha settled on quarterly reviews. ${"x".repeat(5_000)}`;
    await context.database.insert(scopedMemoryEntry).values({ divisionId: alpha, content: note });
    // Estimate stays under 9e6 (so bytes are loaded); persist flatten is tiny.
    // The remembered section is what pushes JSON.stringify(nativeSessionChatBody(start)) over the cap.
    await attachUpload({
      conversationId: fixture.conversationId,
      messageId: fixture.userMessageId,
      name: "wide.png",
      mediaType: "image/png",
      bytes: new Uint8Array(6_746_250).fill(7),
    });

    const start = await submittedStart(fixture.runId, fixture.jobId);
    expect(start.instructions).toContain(note);
    expect(start.images).toBeUndefined();
    expect(start.instructions).toContain("not inlined this turn (budget)");
    const posted = JSON.stringify(nativeSessionChatBody(start));
    expect(posted).toContain(note);
    expect(Buffer.byteLength(posted, "utf8")).toBeLessThanOrEqual(9_000_000);
  });
});

async function activatePolicy(overrides: {
  maxInputCharacters?: number;
  rules?: GuardrailRule[];
} = {}): Promise<void> {
  await context.database.insert(guardrailPolicy).values({
    slug: `policy-${randomUUID().slice(0, 8)}`,
    displayName: "Active inject policy",
    description: "Policy used by this-turn text inject tests.",
    version: "1",
    status: "ACTIVE",
    maxInputCharacters: overrides.maxInputCharacters ?? 32_000,
    maxOutputCharacters: 256_000,
    firstActivatedAt: new Date(),
    rules: overrides.rules ?? [],
  });
}

describe("DrizzleAgentProcessor this-turn text inject", () => {
  it("imports inspectInput from @orcasynapse/security", () => {
    const source = readFileSync(new URL("./agent-processor.ts", import.meta.url), "utf8");
    expect(source).toMatch(/inspectInput/);
    expect(source).toMatch(/from "@orcasynapse\/security"/);
    expect(source).not.toContain("apps/api/src/guardrails");
  });

  it("injects a 100k prompt plus a 16k note under the default 128k ceiling", async () => {
    const fixture = await seed({ input: "x".repeat(100_000) });
    await bindConversation(fixture);
    const note = "n".repeat(16_384);
    await attachUpload({
      conversationId: fixture.conversationId,
      messageId: fixture.userMessageId,
      name: "notes.txt",
      mediaType: "text/plain; charset=utf-8",
      bytes: new TextEncoder().encode(note),
    });

    const start = await submittedStart(fixture.runId, fixture.jobId);
    expect(start.textExcerpts).toEqual([{ name: "notes.txt", mediaType: "text/plain; charset=utf-8", text: note }]);
    expect(start.images).toBeUndefined();
    expect(persistFlattenedUserText(start).length).toBeLessThanOrEqual(128_000);
    expect(start.instructions).toContain("in this turn as text");
    expect(start.input).toBe("x".repeat(100_000));
  });

  it("ceiling-skips a 16k note when a 32,000 policy cannot hold a 100k prompt plus the note", async () => {
    const fixture = await seed({ input: "x".repeat(100_000) });
    await bindConversation(fixture);
    await activatePolicy({ maxInputCharacters: 32_000 });
    await attachUpload({
      conversationId: fixture.conversationId,
      messageId: fixture.userMessageId,
      name: "notes.txt",
      mediaType: "text/plain",
      bytes: new TextEncoder().encode("n".repeat(16_384)),
    });

    const start = await submittedStart(fixture.runId, fixture.jobId);
    expect(start.textExcerpts).toBeUndefined();
    expect(start.instructions).toContain("not inlined this turn (ceiling)");
  });

  it("keeps a successful 32,000-policy inject at or under the flattened ceiling", async () => {
    const fixture = await seed();
    await bindConversation(fixture);
    await activatePolicy({ maxInputCharacters: 32_000 });
    await attachUpload({
      conversationId: fixture.conversationId,
      messageId: fixture.userMessageId,
      name: "notes.txt",
      mediaType: "text/plain",
      bytes: new TextEncoder().encode("hello from notes"),
    });

    const start = await submittedStart(fixture.runId, fixture.jobId);
    expect(start.textExcerpts).toEqual([{
      name: "notes.txt",
      mediaType: "text/plain",
      text: "hello from notes",
    }]);
    expect(persistFlattenedUserText(start).length).toBeLessThanOrEqual(32_000);
    expect(start.instructions).toContain("- notes.txt (text/plain, 1 KB) in this turn as text");
  });

  it("guardrail-skips an excerpt that contains a credential", async () => {
    const fixture = await seed();
    await bindConversation(fixture);
    await attachUpload({
      conversationId: fixture.conversationId,
      messageId: fixture.userMessageId,
      name: "keys.txt",
      mediaType: "text/plain",
      bytes: new TextEncoder().encode("-----BEGIN PRIVATE KEY-----\nsecret"),
    });

    const start = await submittedStart(fixture.runId, fixture.jobId);
    expect(start.textExcerpts).toBeUndefined();
    expect(start.instructions).toContain("not inlined this turn (guardrail)");
    expect(start.input).toBe("Summarize the policy.");
  });

  it("guardrail-skips when only the concatenated flatten matches a rule", async () => {
    const fixture = await seed();
    await bindConversation(fixture);
    await activatePolicy({
      rules: [{
        id: "0f9c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f",
        label: "Concatenated flatten",
        type: "REGEX",
        pattern: "policy[\\s\\S]*UNIQUE_FLATTEN_TOKEN",
        action: "BLOCK",
        caseSensitive: false,
        enabled: true,
      }],
    });
    await attachUpload({
      conversationId: fixture.conversationId,
      messageId: fixture.userMessageId,
      name: "notes.txt",
      mediaType: "text/plain",
      bytes: new TextEncoder().encode("UNIQUE_FLATTEN_TOKEN"),
    });

    const start = await submittedStart(fixture.runId, fixture.jobId);
    expect(start.textExcerpts).toBeUndefined();
    expect(start.instructions).toContain("not inlined this turn (guardrail)");
  });

  it("posts a string message when flatten inspect blocks and inject lists are already empty", async () => {
    const fixture = await seed();
    await bindConversation(fixture);
    await activatePolicy({
      rules: [{
        id: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
        label: "Prompt after submit",
        type: "WORD",
        pattern: "policy",
        action: "BLOCK",
        caseSensitive: false,
        enabled: true,
      }],
    });

    const start = await submittedStart(fixture.runId, fixture.jobId);
    expect(start.images).toBeUndefined();
    expect(start.textExcerpts).toBeUndefined();
    expect(typeof nativeSessionChatBody(start).message).toBe("string");
    expect(start.input).toBe("Summarize the policy.");
  });

  it("does not load a 200 KB CSV into a text part", async () => {
    const fixture = await seed();
    await bindConversation(fixture);
    const csv = `${"col,\n".repeat(50_000)}`;
    await attachUpload({
      conversationId: fixture.conversationId,
      messageId: fixture.userMessageId,
      name: "export.csv",
      mediaType: "text/csv",
      bytes: new TextEncoder().encode(csv),
    });

    const start = await submittedStart(fixture.runId, fixture.jobId);
    expect(start.textExcerpts).toBeUndefined();
    expect(start.instructions).toContain("not inlined this turn (not-injectable)");
    expect(JSON.stringify(nativeSessionChatBody(start))).not.toContain("col,");
  });

  it("drops the oldest image before an excerpt when the JSON body exceeds 9e6", async () => {
    const fixture = await seed();
    await bindConversation(fixture);
    const alpha = await assignDivision(fixture.runId, "Alpha");
    const note = `Alpha settled on quarterly reviews. ${"x".repeat(5_000)}`;
    await context.database.insert(scopedMemoryEntry).values({ divisionId: alpha, content: note });
    await attachUpload({
      conversationId: fixture.conversationId,
      messageId: fixture.userMessageId,
      name: "notes.txt",
      mediaType: "text/plain",
      bytes: new TextEncoder().encode("keep this note"),
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
    });
    await attachUpload({
      conversationId: fixture.conversationId,
      messageId: fixture.userMessageId,
      name: "wide.png",
      mediaType: "image/png",
      bytes: new Uint8Array(6_746_250).fill(7),
      createdAt: new Date("2026-08-02T00:00:00.000Z"),
    });

    const start = await submittedStart(fixture.runId, fixture.jobId);
    expect(start.images).toBeUndefined();
    expect(start.textExcerpts).toEqual([{
      name: "notes.txt",
      mediaType: "text/plain",
      text: "keep this note",
    }]);
    expect(start.instructions).toContain("wide.png");
    expect(start.instructions).toContain("not inlined this turn (budget)");
    expect(start.instructions).toContain("in this turn as text");
  });

  it("injects redacted excerpt text when a REDACT rule matches", async () => {
    const fixture = await seed();
    await bindConversation(fixture);
    await activatePolicy({
      rules: [{
        id: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
        label: "Codename",
        type: "WORD",
        pattern: "seahorse",
        action: "REDACT",
        caseSensitive: false,
        enabled: true,
      }],
    });
    await attachUpload({
      conversationId: fixture.conversationId,
      messageId: fixture.userMessageId,
      name: "notes.txt",
      mediaType: "text/plain",
      bytes: new TextEncoder().encode("the seahorse programme"),
    });

    const start = await submittedStart(fixture.runId, fixture.jobId);
    expect(start.textExcerpts).toEqual([{
      name: "notes.txt",
      mediaType: "text/plain",
      text: "the [redacted] programme",
    }]);
  });
});

describe("DrizzleAgentProcessor session inbox", () => {
  it("places the uploaded blob on the node before start", async () => {
    const fixture = await seed();
    await bindConversation(fixture);
    const artifactId = await attachUpload({
      conversationId: fixture.conversationId,
      messageId: fixture.userMessageId,
      name: "brief.pdf",
      mediaType: "application/pdf",
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    });
    let inbox: { sessionId: string; files: Array<{ fileName: string; bytes: Uint8Array }> } | undefined;
    let seen: HermesRunSubmission | undefined;
    const processor = new DrizzleAgentProcessor(context.database, runtime({
      materializeSessionInbox: async (sessionId, files) => {
        inbox = { sessionId, files: files.map((file) => ({ fileName: file.fileName, bytes: file.bytes })) };
      },
      start: async (input) => {
        seen = input;
        return "hermes-native-inbox";
      },
    }), CAPABILITIES);
    await processor.process({ runId: fixture.runId }, fixture.jobId, WORKER_ID);
    expect(inbox?.sessionId).toBe(fixture.conversationId);
    expect(inbox?.files).toEqual([{
      fileName: `${artifactId}-brief.pdf`,
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    }]);
    expect(seen?.instructions).toContain(
      `/var/lib/orcasynapse-hermes/artifacts/${fixture.conversationId}/inbox/${artifactId}-brief.pdf`,
    );
    expect(seen?.instructions).toContain("Native file tools can read and edit it");
  });
});

