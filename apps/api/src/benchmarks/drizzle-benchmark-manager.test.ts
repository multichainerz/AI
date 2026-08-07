import { randomUUID } from "node:crypto";
import type { CreateBenchmarkSuite } from "@orcasynapse/contracts";
import {
  agentProfile,
  agentProfileVersion,
  auditEvent,
  benchmarkRun,
  createTestDatabase,
  document,
  type TestDatabase,
} from "@orcasynapse/database";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AdminPrincipal } from "../auth/admin-session.js";
import {
  BenchmarkRunNotFoundError,
  BenchmarkSuiteConflictError,
  BenchmarkSuiteNotFoundError,
  BenchmarkTargetUnavailableError,
} from "./benchmark-manager.js";
import { DrizzleBenchmarkManager } from "./drizzle-benchmark-manager.js";

let context: TestDatabase;
let manager: DrizzleBenchmarkManager;

beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); });
beforeEach(async () => {
  await context.reset();
  manager = new DrizzleBenchmarkManager(context.database);
});

const principal = { id: randomUUID(), subject: "local-admin:operator" } as AdminPrincipal;

function suiteInput(overrides: Partial<CreateBenchmarkSuite> = {}): CreateBenchmarkSuite {
  return {
    slug: "chat-baseline",
    displayName: "Chat baseline",
    description: "The questions this installation must keep answering correctly.",
    kind: "CHAT_QUALITY",
    cases: [{
      id: "cites-runbook",
      prompt: "What should we check before promoting?",
      intent: "A promotion question must cite the runbook.",
      assertions: [{ kind: "MUST_INCLUDE", value: "migrations" }],
    }],
    passThreshold: 0.9,
    ...overrides,
  };
}

/** An active agent, which is what a chat or memory suite measures. */
async function activeAgent(slug = "support", modelAlias = "hermes-default"): Promise<string> {
  const [profile] = await context.database
    .insert(agentProfile)
    .values({ slug, status: "ACTIVE", currentVersion: 1, activeVersion: 1 })
    .returning();
  await context.database.insert(agentProfileVersion).values({
    profileId: profile!.id,
    version: 1,
    displayName: "Support",
    purpose: "Answers operational questions.",
    instructions: "Be accurate.",
    modelAlias,
    maxTurns: 1,
    timeoutSeconds: 120,
    maxConcurrentRuns: 2,
  });
  return profile!.id;
}

async function indexedDocument(): Promise<void> {
  await context.database.insert(document).values({
    ownerSubject: principal.subject,
    fileName: "runbook.pdf",
    mediaType: "application/pdf",
    sizeBytes: 2_048,
    status: "READY",
    sha256: "a".repeat(64),
    classification: "INTERNAL",
    retentionUntil: new Date(Date.now() + 86_400_000),
  });
}

describe("benchmark suites", () => {
  it("refuses a second suite with the same name", async () => {
    await manager.createSuite(principal, suiteInput());
    await expect(manager.createSuite(principal, suiteInput()))
      .rejects.toBeInstanceOf(BenchmarkSuiteConflictError);
  });

  it("records the authoring without recording the questions", async () => {
    // A case can quote a customer document, so the trail carries counts only.
    const suite = await manager.createSuite(principal, suiteInput());
    const [event] = await context.database
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.resourceId, suite.id));
    expect(event?.action).toBe("benchmark.suite_created");
    expect(JSON.stringify(event?.metadata)).not.toContain("promoting");
  });

  it("moves the revision when the questions change and leaves it when the name does", async () => {
    const suite = await manager.createSuite(principal, suiteInput());
    expect(suite.revision).toBe(1);

    const renamed = await manager.updateSuite(principal, suite.id, {
      expectedRevision: 1,
      displayName: "Chat baseline (core)",
    });
    // A renamed suite still asks the same questions, and a run already queued
    // against revision 1 is still valid.
    expect(renamed.revision).toBe(1);
    expect(renamed.displayName).toBe("Chat baseline (core)");

    const rewritten = await manager.updateSuite(principal, suite.id, {
      expectedRevision: 1,
      cases: [{
        id: "cites-runbook",
        prompt: "What should we check before promoting?",
        intent: "A promotion question must cite the runbook.",
        assertions: [{ kind: "MUST_INCLUDE", value: "rollback" }],
      }],
    });
    expect(rewritten.revision).toBe(2);
  });

  it("moves the revision when the pass threshold changes", async () => {
    // The threshold decides pass from regression, so a run pinned to the old
    // one was scored against a different bar.
    const suite = await manager.createSuite(principal, suiteInput());
    const stricter = await manager.updateSuite(principal, suite.id, { expectedRevision: 1, passThreshold: 0.95 });
    expect(stricter.revision).toBe(2);
  });

  it("rejects an edit against a stale revision", async () => {
    const suite = await manager.createSuite(principal, suiteInput());
    await manager.updateSuite(principal, suite.id, { expectedRevision: 1, passThreshold: 0.5 });
    await expect(manager.updateSuite(principal, suite.id, { expectedRevision: 1, passThreshold: 0.6 }))
      .rejects.toBeInstanceOf(BenchmarkSuiteConflictError);
  });

  it("reports an edit to a suite that is not there as missing", async () => {
    await expect(manager.updateSuite(principal, randomUUID(), { expectedRevision: 1 }))
      .rejects.toBeInstanceOf(BenchmarkSuiteNotFoundError);
  });

  it("keeps a suite whose result an evaluation cites", async () => {
    // The run rows cascade. Deleting here would remove the evidence a promotion
    // decision was made on.
    await activeAgent();
    const suite = await manager.createSuite(principal, suiteInput());
    const run = await manager.startRun(principal, { suiteId: suite.id });
    await context.database
      .update(benchmarkRun)
      .set({ status: "COMPLETED", completedAt: new Date(), evaluationRunId: randomUUID() })
      .where(eq(benchmarkRun.id, run.id));

    await expect(manager.deleteSuite(principal, suite.id))
      .rejects.toBeInstanceOf(BenchmarkSuiteConflictError);
    expect((await manager.listSuites()).items).toHaveLength(1);
  });

  it("keeps a suite whose run is still going", async () => {
    await activeAgent();
    const suite = await manager.createSuite(principal, suiteInput());
    await manager.startRun(principal, { suiteId: suite.id });
    await expect(manager.deleteSuite(principal, suite.id))
      .rejects.toBeInstanceOf(BenchmarkSuiteConflictError);
  });

  it("deletes a suite whose results nothing relies on", async () => {
    await activeAgent();
    const suite = await manager.createSuite(principal, suiteInput());
    const run = await manager.startRun(principal, { suiteId: suite.id });
    await context.database
      .update(benchmarkRun)
      .set({ status: "COMPLETED", completedAt: new Date(), passRate: 1 })
      .where(eq(benchmarkRun.id, run.id));

    await manager.deleteSuite(principal, suite.id);
    expect((await manager.listSuites()).items).toHaveLength(0);
    expect((await manager.listRuns()).items).toHaveLength(0);
  });
});

describe("starting a run", () => {
  it("queues without a score and records what it will measure", async () => {
    await activeAgent("support", "hermes-lfm2");
    const suite = await manager.createSuite(principal, suiteInput());
    const run = await manager.startRun(principal, { suiteId: suite.id });

    expect(run.status).toBe("QUEUED");
    expect(run.passRate).toBeNull();
    expect(run.startedAt).toBeNull();
    expect(run.totalCases).toBe(1);
    expect(run.suiteRevision).toBe(1);
    expect(run.target).toMatchObject({
      agentProfileSlug: "support",
      agentProfileVersion: 1,
      modelAlias: "hermes-lfm2",
      ownerSubject: principal.subject,
    });
  });

  it("refuses a chat run when no agent is active", async () => {
    // Queuing anyway would complete at 0% and enter the history as a regression
    // the model never caused.
    const suite = await manager.createSuite(principal, suiteInput());
    await expect(manager.startRun(principal, { suiteId: suite.id }))
      .rejects.toBeInstanceOf(BenchmarkTargetUnavailableError);
    expect((await manager.listRuns()).items).toHaveLength(0);
  });

  it("refuses to guess which agent to measure when several are active", async () => {
    await activeAgent("support");
    await activeAgent("research");
    const suite = await manager.createSuite(principal, suiteInput());
    await expect(manager.startRun(principal, { suiteId: suite.id }))
      .rejects.toBeInstanceOf(BenchmarkTargetUnavailableError);

    const named = await activeAgent("triage");
    const run = await manager.startRun(principal, { suiteId: suite.id, agentProfileId: named });
    expect(run.target.agentProfileSlug).toBe("triage");
  });

  it("refuses a retrieval run with nothing indexed, and scores it against the embedding model", async () => {
    const suite = await manager.createSuite(principal, suiteInput({ slug: "retrieval-baseline", kind: "RETRIEVAL" }));
    await expect(manager.startRun(principal, { suiteId: suite.id }))
      .rejects.toBeInstanceOf(BenchmarkTargetUnavailableError);

    await indexedDocument();
    const run = await manager.startRun(principal, { suiteId: suite.id });
    // Retrieval scores move when the vectors change, so the embedding model is
    // the alias that explains them.
    expect(run.target.modelAlias).toBe("Xenova/bge-m3");
    expect(run.target.agentProfileId).toBeNull();
  });

  it("allows one run of a suite at a time", async () => {
    await activeAgent();
    const suite = await manager.createSuite(principal, suiteInput());
    await manager.startRun(principal, { suiteId: suite.id });
    await expect(manager.startRun(principal, { suiteId: suite.id }))
      .rejects.toBeInstanceOf(BenchmarkSuiteConflictError);
  });

  it("reports a run against a suite that is not there as missing", async () => {
    await expect(manager.startRun(principal, { suiteId: randomUUID() }))
      .rejects.toBeInstanceOf(BenchmarkSuiteNotFoundError);
  });
});

describe("reading and stopping runs", () => {
  it("keeps the count a stopped run reached without turning it into a score", async () => {
    await activeAgent();
    const suite = await manager.createSuite(principal, suiteInput());
    const run = await manager.startRun(principal, { suiteId: suite.id });
    await context.database
      .update(benchmarkRun)
      .set({ status: "RUNNING", startedAt: new Date(), totalCases: 3, passedCases: 1 })
      .where(eq(benchmarkRun.id, run.id));

    const cancelled = await manager.cancelRun(principal, run.id);
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.passedCases).toBe(1);
    // A third of a suite is not a score for the suite.
    expect(cancelled.passRate).toBeNull();
    expect(cancelled.completedAt).not.toBeNull();
  });

  it("refuses to stop a run that already finished", async () => {
    await activeAgent();
    const suite = await manager.createSuite(principal, suiteInput());
    const run = await manager.startRun(principal, { suiteId: suite.id });
    await context.database
      .update(benchmarkRun)
      .set({ status: "COMPLETED", completedAt: new Date(), passRate: 1, passedCases: 1 })
      .where(eq(benchmarkRun.id, run.id));

    await expect(manager.cancelRun(principal, run.id))
      .rejects.toBeInstanceOf(BenchmarkSuiteConflictError);
  });

  it("reports an unknown run as missing rather than empty", async () => {
    await expect(manager.getRun(randomUUID())).rejects.toBeInstanceOf(BenchmarkRunNotFoundError);
    await expect(manager.cancelRun(principal, randomUUID())).rejects.toBeInstanceOf(BenchmarkRunNotFoundError);
  });

  it("lists newest first and narrows to one suite", async () => {
    await activeAgent();
    const first = await manager.createSuite(principal, suiteInput());
    const second = await manager.createSuite(principal, suiteInput({ slug: "memory-baseline", kind: "MEMORY" }));
    const older = await manager.startRun(principal, { suiteId: first.id });
    await context.database
      .update(benchmarkRun)
      .set({ queuedAt: new Date(Date.now() - 60_000) })
      .where(eq(benchmarkRun.id, older.id));
    const newer = await manager.startRun(principal, { suiteId: second.id });

    expect((await manager.listRuns()).items.map(({ id }) => id)).toEqual([newer.id, older.id]);
    expect((await manager.listRuns(first.id)).items.map(({ id }) => id)).toEqual([older.id]);
  });
});
