import { randomUUID } from "node:crypto";
import type { BenchmarkCase } from "@orcasynapse/contracts";
import {
  auditEvent,
  benchmarkRun,
  benchmarkSuite,
  createTestDatabase,
  type TestDatabase,
} from "@orcasynapse/database";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BenchmarkRunner,
  medianLatency,
  scoreAssertion,
  scoreCase,
  type BenchmarkCaseExecutor,
  type BenchmarkCaseOutput,
} from "./benchmark-runner.js";

let context: TestDatabase;

beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); });
beforeEach(async () => { await context.reset(); });

const WORKER = randomUUID();
const OWNER = "local-admin:operator";

function output(overrides: Partial<BenchmarkCaseOutput> = {}): BenchmarkCaseOutput {
  return {
    text: "Check the migrations before promoting.",
    citedDocuments: ["runbook.pdf"],
    latencyMs: 900,
    outputTokens: 42,
    failureReason: null,
    ...overrides,
  };
}

const singleCase: BenchmarkCase = {
  id: "cites-runbook",
  prompt: "What should we check before promoting?",
  intent: "A promotion question must cite the runbook.",
  assertions: [{ kind: "MUST_INCLUDE", value: "migrations" }],
};

async function seedSuite(cases: BenchmarkCase[] = [singleCase], revision = 1) {
  const [suite] = await context.database
    .insert(benchmarkSuite)
    .values({
      slug: "chat-baseline",
      displayName: "Chat baseline",
      description: "The questions this installation must keep answering.",
      kind: "CHAT_QUALITY",
      cases,
      passThreshold: 0.9,
      revision,
      updatedAt: new Date(),
    })
    .returning();
  return suite!;
}

async function queueRun(suite: { id: string; slug: string; revision: number }, overrides = {}) {
  const [run] = await context.database
    .insert(benchmarkRun)
    .values({
      suiteId: suite.id,
      suiteSlug: suite.slug,
      suiteRevision: suite.revision,
      kind: "CHAT_QUALITY",
      status: "QUEUED",
      ownerSubject: OWNER,
      requestedBy: randomUUID(),
      totalCases: 1,
      ...overrides,
    })
    .returning();
  return run!;
}

function executor(impl: BenchmarkCaseExecutor["execute"]): BenchmarkCaseExecutor {
  return { execute: vi.fn(impl) };
}

describe("scoring", () => {
  it("matches on substrings so a reworded answer still passes", () => {
    // An exact-match benchmark fails on every rewording and teaches an operator
    // to ignore it.
    expect(scoreAssertion({ kind: "MUST_INCLUDE", value: "Migrations" }, output())).toBe(true);
    expect(scoreAssertion({ kind: "MUST_INCLUDE", value: "rollback" }, output())).toBe(false);
  });

  it("catches what an answer must not say", () => {
    // The regression a pass rate never surfaces: the other tenant's name.
    const leaked = output({ text: "Per the Contoso agreement, check the migrations." });
    expect(scoreAssertion({ kind: "MUST_NOT_INCLUDE", value: "Contoso" }, leaked)).toBe(false);
    expect(scoreAssertion({ kind: "MUST_NOT_INCLUDE", value: "Contoso" }, output())).toBe(true);
  });

  it("matches a citation without pinning the file extension", () => {
    expect(scoreAssertion({ kind: "MUST_CITE_DOCUMENT", value: "runbook" }, output())).toBe(true);
    expect(scoreAssertion({ kind: "MUST_CITE_DOCUMENT", value: "policy" }, output())).toBe(false);
  });

  it("treats an unmeasured latency as a failure, not a fast answer", () => {
    expect(scoreAssertion({ kind: "MAX_LATENCY_MS", value: "1000" }, output())).toBe(true);
    expect(scoreAssertion({ kind: "MAX_LATENCY_MS", value: "800" }, output())).toBe(false);
    expect(scoreAssertion({ kind: "MAX_LATENCY_MS", value: "1000" }, output({ latencyMs: null }))).toBe(false);
  });

  it("fails every assertion of a case that could not run", () => {
    // Otherwise MUST_NOT_INCLUDE passes on an empty answer, and an unreachable
    // model scores as a clean run.
    const result = scoreCase(
      { ...singleCase, assertions: [{ kind: "MUST_NOT_INCLUDE", value: "Contoso" }] },
      output({ text: "", failureReason: "The case could not be executed." }),
    );
    expect(result.passed).toBe(false);
    expect(result.assertions[0]!.passed).toBe(false);
  });

  it("carries the intent into the result so a failure explains itself", () => {
    expect(scoreCase(singleCase, output()).intent).toBe("A promotion question must cite the runbook.");
  });

  it("takes the median rather than the mean", () => {
    // One cold start on a host that loads weights on demand would otherwise
    // redefine what typical means for the whole suite.
    const results = [400, 500, 60_000].map((latencyMs) => scoreCase(singleCase, output({ latencyMs })));
    expect(medianLatency(results)).toBe(500);
    expect(medianLatency([])).toBeNull();
  });
});

describe("claiming and executing", () => {
  it("returns null when nothing is queued", async () => {
    const runner = new BenchmarkRunner(context.database, executor(async () => output()));
    expect(await runner.runNext(WORKER)).toBeNull();
  });

  it("scores a suite and records the result", async () => {
    const suite = await seedSuite();
    const queued = await queueRun(suite);
    const runner = new BenchmarkRunner(context.database, executor(async () => output()));

    const outcome = await runner.runNext(WORKER);
    expect(outcome).toMatchObject({ status: "COMPLETED", passedCases: 1, totalCases: 1 });

    const [stored] = await context.database.select().from(benchmarkRun).where(eq(benchmarkRun.id, queued.id));
    expect(stored?.status).toBe("COMPLETED");
    expect(stored?.passRate).toBe(1);
    expect(stored?.medianLatencyMs).toBe(900);
    expect(stored?.completedAt).not.toBeNull();
    // The lease is given back, or the row looks held forever.
    expect(stored?.leaseOwner).toBeNull();
  });

  it("keeps an excerpt of the answer, not the answer", async () => {
    const suite = await seedSuite();
    await queueRun(suite);
    const runner = new BenchmarkRunner(context.database, executor(async () => output({ text: "x".repeat(9_000) })));
    await runner.runNext(WORKER);

    const [stored] = await context.database.select().from(benchmarkRun);
    const results = stored?.results as Array<{ outputExcerpt: string | null }>;
    expect(results[0]?.outputExcerpt?.length).toBe(2_000);
  });

  it("records what the trail needs without recording the questions", async () => {
    const suite = await seedSuite();
    await queueRun(suite);
    const runner = new BenchmarkRunner(context.database, executor(async () => output()));
    await runner.runNext(WORKER);

    const [event] = await context.database
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.action, "benchmark.run_completed"));
    expect(event?.actorType).toBe("SERVICE");
    expect(JSON.stringify(event?.metadata)).not.toContain("promoting");
  });

  it("fails a run whose suite was edited while it waited", async () => {
    // Executing the new questions under the old revision number would file the
    // result against a document that never asked them.
    const suite = await seedSuite();
    const queued = await queueRun(suite);
    await context.database
      .update(benchmarkSuite)
      .set({ revision: 2 })
      .where(eq(benchmarkSuite.id, suite.id));

    const execute = vi.fn(async () => output());
    const outcome = await new BenchmarkRunner(context.database, { execute }).runNext(WORKER);
    expect(outcome?.status).toBe("FAILED");
    expect(execute).not.toHaveBeenCalled();

    const [stored] = await context.database.select().from(benchmarkRun).where(eq(benchmarkRun.id, queued.id));
    expect(stored?.failureMessage).toContain("revision 1 to 2");
    // Reset, so a refused run never reads as a suite that scored zero.
    expect(stored?.totalCases).toBe(0);
    expect(stored?.passRate).toBeNull();
  });

  it("records a failed case rather than abandoning the suite", async () => {
    // Thirty-nine cases still answer the question the operator asked.
    const suite = await seedSuite([
      singleCase,
      { ...singleCase, id: "second-question", prompt: "And after that?" },
    ]);
    await queueRun(suite, { totalCases: 2 });
    let first = true;
    const runner = new BenchmarkRunner(context.database, executor(async () => {
      if (first) { first = false; throw new Error("Hermes is unreachable."); }
      return output();
    }));

    const outcome = await runner.runNext(WORKER);
    expect(outcome).toMatchObject({ status: "COMPLETED", passedCases: 1, totalCases: 2 });

    const [stored] = await context.database.select().from(benchmarkRun);
    expect(stored?.passRate).toBe(0.5);
    const results = stored?.results as Array<{ passed: boolean; failureReason: string | null }>;
    expect(results[0]).toMatchObject({ passed: false, failureReason: "The case could not be executed." });
  });

  it("stops between cases when an operator cancels, and keeps no score", async () => {
    const suite = await seedSuite([
      singleCase,
      { ...singleCase, id: "second-question", prompt: "And after that?" },
      { ...singleCase, id: "third-question", prompt: "Anything else?" },
    ]);
    const queued = await queueRun(suite, { totalCases: 3 });
    const execute = vi.fn(async () => {
      await context.database
        .update(benchmarkRun)
        .set({ status: "CANCELLED", completedAt: new Date() })
        .where(eq(benchmarkRun.id, queued.id));
      return output();
    });

    const outcome = await new BenchmarkRunner(context.database, { execute }).runNext(WORKER);
    expect(outcome?.status).toBe("CANCELLED");
    // Stopped after the first case rather than running all three out.
    expect(execute).toHaveBeenCalledTimes(1);

    const [stored] = await context.database.select().from(benchmarkRun).where(eq(benchmarkRun.id, queued.id));
    expect(stored?.status).toBe("CANCELLED");
    expect(stored?.passedCases).toBe(1);
    // A third of a suite is not a score for the suite.
    expect(stored?.passRate).toBeNull();
  });

  it("does not write over a run whose lease another worker took", async () => {
    // stopped() reports true for two different reasons: an operator cancelled,
    // or this worker lost the lease. Only the first should record partial
    // results. Writing on the second nulls the new holder's lease and replaces
    // its results with a partial set, which hands the run to a third worker.
    const suite = await seedSuite([
      singleCase,
      { ...singleCase, id: "second-question", prompt: "And after that?" },
    ]);
    const queued = await queueRun(suite, { totalCases: 2 });
    const thief = randomUUID();
    const execute = vi.fn(async () => {
      await context.database
        .update(benchmarkRun)
        .set({ leaseOwner: thief, leaseExpiresAt: new Date(Date.now() + 300_000) })
        .where(eq(benchmarkRun.id, queued.id));
      return output();
    });

    await new BenchmarkRunner(context.database, { execute }).runNext(WORKER);

    const [stored] = await context.database.select().from(benchmarkRun).where(eq(benchmarkRun.id, queued.id));
    expect(stored?.leaseOwner, "the new holder's lease was cleared").toBe(thief);
    expect(stored?.status).toBe("RUNNING");
  });

  it("does not complete a run whose lease another worker holds", async () => {
    // complete() guards on status but not on ownership, unlike renewLease and
    // recordCancelled beside it. A single-case suite gives no top-of-loop check
    // after the case, so a worker that lost its lease mid-case still reaches
    // complete(), matches on id + RUNNING, and writes COMPLETED with a full
    // pass rate over the run its replacement owns -- which attachEvidence then
    // accepts as a PASSED promotion gate.
    const suite = await seedSuite([singleCase]);
    const queued = await queueRun(suite, { totalCases: 1 });
    const thief = randomUUID();
    const execute = vi.fn(async () => {
      await context.database
        .update(benchmarkRun)
        .set({ leaseOwner: thief, leaseExpiresAt: new Date(Date.now() + 300_000) })
        .where(eq(benchmarkRun.id, queued.id));
      return output();
    });

    await new BenchmarkRunner(context.database, { execute }).runNext(WORKER);

    const [stored] = await context.database.select().from(benchmarkRun).where(eq(benchmarkRun.id, queued.id));
    expect(stored?.status, "a dispossessed worker completed the new holder's run").toBe("RUNNING");
    expect(stored?.leaseOwner, "the new holder's lease was cleared").toBe(thief);
  });

  it("does not resurrect a run cancelled during its final case", async () => {
    // The cancel check runs at the top of each iteration, so one landing during
    // the last case is never seen by the loop. `complete()` then wrote the
    // terminal row with no status guard — turning the run an operator stopped
    // into a COMPLETED one with a full pass rate, which `attachEvidence` will
    // accept as a PASSED promotion gate. A single-case suite is the whole
    // window, and it is the shape a smoke suite most often has.
    const suite = await seedSuite([singleCase]);
    const queued = await queueRun(suite, { totalCases: 1 });
    const execute = vi.fn(async () => {
      await context.database
        .update(benchmarkRun)
        .set({ status: "CANCELLED", completedAt: new Date() })
        .where(eq(benchmarkRun.id, queued.id));
      return output();
    });

    await new BenchmarkRunner(context.database, { execute }).runNext(WORKER);

    const [stored] = await context.database.select().from(benchmarkRun).where(eq(benchmarkRun.id, queued.id));
    expect(stored?.status).toBe("CANCELLED");
    expect(stored?.passRate).toBeNull();
  });

  it("publishes progress as it goes, so a crash costs the remaining cases only", async () => {
    const suite = await seedSuite([
      singleCase,
      { ...singleCase, id: "second-question", prompt: "And after that?" },
    ]);
    const queued = await queueRun(suite, { totalCases: 2 });
    const scoredWhenSecondCaseStarted: number[] = [];
    const execute = vi.fn(async () => {
      const [row] = await context.database.select().from(benchmarkRun).where(eq(benchmarkRun.id, queued.id));
      scoredWhenSecondCaseStarted.push((row?.results as unknown[]).length);
      return output();
    });

    await new BenchmarkRunner(context.database, { execute }).runNext(WORKER);
    // The first case's result was already durable before the second one began.
    expect(scoredWhenSecondCaseStarted).toEqual([0, 1]);
  });

  it("takes over a run whose worker died and left the lease to lapse", async () => {
    // "Still going" and "the process running it is gone" are otherwise
    // indistinguishable, and the second has no way out but hand-written SQL.
    const suite = await seedSuite();
    const stranded = await queueRun(suite, {
      status: "RUNNING",
      startedAt: new Date(Date.now() - 3_600_000),
      leaseOwner: randomUUID(),
      leaseExpiresAt: new Date(Date.now() - 600_000),
    });

    const outcome = await new BenchmarkRunner(context.database, executor(async () => output())).runNext(WORKER);
    expect(outcome).toMatchObject({ runId: stranded.id, status: "COMPLETED" });
  });

  it("leaves a run whose lease is still held", async () => {
    const suite = await seedSuite();
    await queueRun(suite, {
      status: "RUNNING",
      startedAt: new Date(),
      leaseOwner: randomUUID(),
      leaseExpiresAt: new Date(Date.now() + 300_000),
    });
    expect(await new BenchmarkRunner(context.database, executor(async () => output())).runNext(WORKER)).toBeNull();
  });

  it("drops a case the contract cannot parse rather than scoring it", async () => {
    // An assertion that cannot be parsed would never fire, and a check that
    // never fires reads as a pass.
    const suite = await seedSuite([
      singleCase,
      { id: "malformed", prompt: "", intent: "", assertions: [] } as unknown as BenchmarkCase,
    ]);
    await queueRun(suite, { totalCases: 2 });

    const outcome = await new BenchmarkRunner(context.database, executor(async () => output())).runNext(WORKER);
    expect(outcome).toMatchObject({ passedCases: 1, totalCases: 1 });
  });
});
