import { randomUUID } from "node:crypto";
import type { BenchmarkCase } from "@orcasynapse/contracts";
import {
  agentProfile,
  agentProfileVersion,
  agentRun,
  createTestDatabase,
  type TestDatabase,
} from "@orcasynapse/database";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentKnowledgeRetriever, AgentMemoryPort } from "./agent-processor.js";
import { LiveBenchmarkExecutor } from "./benchmark-executor.js";
import type { ClaimedBenchmarkRun } from "./benchmark-runner.js";

let context: TestDatabase;

beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); });
beforeEach(async () => { await context.reset(); });

const OWNER = "local-admin:operator";

const benchmarkCase: BenchmarkCase = {
  id: "cites-runbook",
  prompt: "What should we check before promoting?",
  intent: "A promotion question must cite the runbook.",
  assertions: [{ kind: "MUST_INCLUDE", value: "migrations" }],
};

function knowledge(sources: Array<{ fileName: string; excerpt: string }> = []): AgentKnowledgeRetriever {
  return {
    search: vi.fn(async () => sources.map((source) => ({
      documentId: randomUUID(),
      classification: "INTERNAL" as const,
      score: 0.8,
      ...source,
    }))),
  };
}

function memory(
  recalled: string[] = [],
  profileFacts: string[] = [],
): AgentMemoryPort {
  return {
    recall: vi.fn(async () => recalled.map((content) => ({ id: randomUUID(), content }))),
    profile: vi.fn(async () => profileFacts.map((content) => ({
      id: randomUUID(),
      content,
      scope: "STATIC" as const,
    }))),
    capture: vi.fn(async () => 0),
  };
}

async function seedAgent(memoryMode: "DOCUMENTS_ONLY" | "LEARN_EXCHANGE" = "LEARN_EXCHANGE") {
  const [profile] = await context.database
    .insert(agentProfile)
    .values({ slug: "support", status: "ACTIVE", currentVersion: 1, activeVersion: 1 })
    .returning();
  await context.database.insert(agentProfileVersion).values({
    profileId: profile!.id,
    version: 1,
    displayName: "Support",
    purpose: "Answers operational questions.",
    instructions: "Be accurate.",
    modelAlias: "hermes-lfm2",
    maxTurns: 1,
    timeoutSeconds: 120,
    maxConcurrentRuns: 2,
    memoryMode,
    allowPrivateKnowledge: true,
  });
  return profile!.id;
}

function claimed(overrides: Partial<ClaimedBenchmarkRun> = {}): ClaimedBenchmarkRun {
  return {
    id: randomUUID(),
    suiteId: randomUUID(),
    suiteSlug: "chat-baseline",
    suiteRevision: 1,
    kind: "CHAT_QUALITY",
    ownerSubject: OWNER,
    agentProfileId: null,
    agentProfileVersion: 1,
    requestedBy: randomUUID(),
    ...overrides,
  };
}

/** Stands in for the agent processor, which in production picks the run up. */
async function answerQueuedRun(answer: {
  output?: string;
  status?: "COMPLETED" | "FAILED";
  failureMessage?: string;
  elapsedMs?: number;
}) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [pending] = await context.database
      .select({ id: agentRun.id })
      .from(agentRun)
      .where(eq(agentRun.status, "QUEUED"))
      .limit(1);
    if (pending) {
      const startedAt = new Date();
      await context.database
        .update(agentRun)
        .set({
          status: answer.status ?? "COMPLETED",
          output: answer.output ?? "Check the migrations before promoting.",
          sources: [{ fileName: "runbook.pdf", excerpt: "Check migrations." }],
          outputTokens: 42,
          failureMessage: answer.failureMessage ?? null,
          startedAt,
          completedAt: new Date(startedAt.getTime() + (answer.elapsedMs ?? 1_500)),
        })
        .where(eq(agentRun.id, pending.id));
      return pending.id;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("No benchmark agent run was queued.");
}

describe("chat cases", () => {
  it("asks through the real agent path and scores what comes back", async () => {
    const profileId = await seedAgent();
    const executor = new LiveBenchmarkExecutor(context.database, knowledge(), memory(), 10_000, 10);

    const [output] = await Promise.all([
      executor.execute(claimed({ agentProfileId: profileId }), benchmarkCase),
      answerQueuedRun({ elapsedMs: 1_500 }),
    ]);

    expect(output.text).toContain("migrations");
    expect(output.citedDocuments).toEqual(["runbook.pdf"]);
    expect(output.outputTokens).toBe(42);
    // The run's own interval, not the wall clock: queue time behind other work
    // belongs to the installation's load, not to the model.
    expect(output.latencyMs).toBe(1_500);
    expect(output.failureReason).toBeNull();
  });

  it("never lets a benchmark write to agent memory", async () => {
    // A benchmark that captured facts would change the thing it measures, and
    // the second run of a suite would score differently because of the first.
    const profileId = await seedAgent("LEARN_EXCHANGE");
    const executor = new LiveBenchmarkExecutor(context.database, knowledge(), memory(), 10_000, 10);

    await Promise.all([
      executor.execute(claimed({ agentProfileId: profileId }), benchmarkCase),
      answerQueuedRun({}),
    ]);

    const [queued] = await context.database.select().from(agentRun);
    const capabilities = queued?.effectiveCapabilities as string[];
    expect(capabilities).toContain("memory:agent:read");
    expect(capabilities).toContain("knowledge:private:read");
    expect(capabilities).not.toContain("memory:agent:write");
  });

  it("gives each case its own session and no history", async () => {
    // Otherwise a suite silently measures whether case 7 primed case 8.
    const profileId = await seedAgent();
    const executor = new LiveBenchmarkExecutor(context.database, knowledge(), memory(), 10_000, 10);

    await Promise.all([
      executor.execute(claimed({ agentProfileId: profileId }), benchmarkCase),
      answerQueuedRun({}),
    ]);

    const [queued] = await context.database.select().from(agentRun);
    expect(queued?.conversationHistory).toEqual([]);
    expect(queued?.sessionId).toBe(queued?.id);
    expect(queued?.input).toBe(benchmarkCase.prompt);
  });

  it("reports a run that did not complete as unanswered, with the reason", async () => {
    const profileId = await seedAgent();
    const executor = new LiveBenchmarkExecutor(context.database, knowledge(), memory(), 10_000, 10);

    const [output] = await Promise.all([
      executor.execute(claimed({ agentProfileId: profileId }), benchmarkCase),
      answerQueuedRun({ status: "FAILED", failureMessage: "The Hermes runtime is offline." }),
    ]);

    expect(output.failureReason).toBe("The Hermes runtime is offline.");
    expect(output.latencyMs).toBeNull();
  });

  it("gives up on a case nothing ever answers", async () => {
    // Nothing picks the run up, so the deadline is the only thing that ends it.
    const profileId = await seedAgent();
    const executor = new LiveBenchmarkExecutor(context.database, knowledge(), memory(), 60, 10);
    const output = await executor.execute(claimed({ agentProfileId: profileId }), benchmarkCase);
    expect(output.failureReason).toContain("No answer within");
  });

  it("refuses a chat case whose agent version is gone", async () => {
    const profileId = await seedAgent();
    await context.database.delete(agentProfileVersion).where(eq(agentProfileVersion.profileId, profileId));
    const executor = new LiveBenchmarkExecutor(context.database, knowledge(), memory(), 10_000, 10);

    const output = await executor.execute(claimed({ agentProfileId: profileId }), benchmarkCase);
    expect(output.failureReason).toContain("no longer exists");
    expect(await context.database.select().from(agentRun)).toHaveLength(0);
  });
});

describe("retrieval cases", () => {
  it("scores the passages themselves and names the documents they came from", async () => {
    // A retrieval suite asks whether the right document came back, which a
    // generated answer can obscure in both directions.
    const retriever = knowledge([
      { fileName: "runbook.pdf", excerpt: "Check migrations before promoting." },
      { fileName: "policy.md", excerpt: "Two approvals are required." },
    ]);
    const executor = new LiveBenchmarkExecutor(context.database, retriever, memory());

    const output = await executor.execute(claimed({ kind: "RETRIEVAL" }), benchmarkCase);
    expect(output.text).toContain("Check migrations");
    expect(output.citedDocuments).toEqual(["runbook.pdf", "policy.md"]);
    expect(output.latencyMs).not.toBeNull();
    expect(retriever.search).toHaveBeenCalledWith(OWNER, benchmarkCase.prompt, expect.anything());
  });
});

describe("memory cases", () => {
  it("reads what the agent knows, including the facts shown on every message", async () => {
    const store = memory(["The rollback window is 30 minutes."], ["The user works in Jakarta."]);
    const executor = new LiveBenchmarkExecutor(context.database, knowledge(), store);

    const output = await executor.execute(
      claimed({ kind: "MEMORY", agentProfileId: randomUUID() }),
      benchmarkCase,
    );

    expect(output.text).toContain("Jakarta");
    expect(output.text).toContain("rollback window");
    // Recall is measured; capture never is.
    expect(store.capture).not.toHaveBeenCalled();
  });

  it("reports a memory case with no agent as unanswered", async () => {
    const executor = new LiveBenchmarkExecutor(context.database, knowledge(), memory());
    const output = await executor.execute(claimed({ kind: "MEMORY" }), benchmarkCase);
    expect(output.failureReason).toContain("no agent");
  });
});
