import { randomUUID } from "node:crypto";
import { AGENT_RUN_ENDED_EVENT_TYPE } from "@orcasynapse/contracts";
import { asc, eq } from "drizzle-orm";
import {
  agentProfile,
  agentProfileVersion,
  runtimeToolsetAdmission,
  toolSet,
  agentRun,
  agentRunEvent,
  agentRuntimeControl,
  auditEvent,
  chatConversation,
  chatMessage,
  createTestDatabase,
  division,
  hermesRuntimeNode,
  scopedMemoryEntry,
  serviceConnection,
  type TestDatabase,
} from "@orcasynapse/database";
import { HermesRunDetachedError } from "@orcasynapse/runtime-clients";
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
  await context.database.insert(chatMessage).values([
    { conversationId: conversation!.id, ordinal: 1, role: "USER", status: "COMPLETED", content: "Summarize the policy." },
    { id: messageId, conversationId: conversation!.id, ordinal: 2, role: "ASSISTANT", status: "PENDING", content: "", agentRunId: row!.id },
  ]);

  return { runId: row!.id, jobId, messageId, externalRunId: row!.externalRunId ?? "" };
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
    // Enough newer, unrelated notes to push the relevant one past any
    // recency-ordered cap. This is the arrangement a division reaches by simply
    // being used.
    await context.database.insert(scopedMemoryEntry).values(
      [...Array(45).keys()].map((index) => ({
        divisionId: alpha,
        content: `Unrelated note number ${index} about catering arrangements.`,
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

    const rows = await context.database.select().from(scopedMemoryEntry);
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.divisionId === alpha)).toHaveLength(1);
  });

  it("writes nothing when there was nothing worth keeping", async () => {
    const { runId, jobId } = await seed();
    const processor = new DrizzleAgentProcessor(
      context.database, runtime() as never, CAPABILITIES, extractor([]),
    );

    await processor.process({ runId }, jobId, WORKER_ID);

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
