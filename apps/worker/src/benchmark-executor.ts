import { randomUUID } from "node:crypto";
import {
  DEFAULT_MEMORY_POLICY,
  type AgentCapability,
  type BenchmarkCase,
} from "@orcasynapse/contracts";
import {
  agentProfileVersion,
  agentRun,
  memoryPolicy,
  type OrcaSynapseDatabase,
} from "@orcasynapse/database";
import { and, eq } from "drizzle-orm";
import type { AgentKnowledgeRetriever } from "./agent-processor.js";
import type {
  BenchmarkCaseExecutor,
  BenchmarkCaseOutput,
  ClaimedBenchmarkRun,
} from "./benchmark-runner.js";

/**
 * Runs a benchmark case against the plane its suite exercises.
 *
 * A chat case goes through the real agent path — the same queue, the same
 * processor, the same profile version, retrieval and boundary checks that a
 * person's message goes through. Nothing about it is a simulation, which is the
 * only way a score means anything about what the installation will actually do.
 */

/** How long one case may take before it is recorded as unanswered. */
const CASE_TIMEOUT_MS = 5 * 60_000;
const POLL_MS = 500;

const TERMINAL = ["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT", "DENIED"] as const;

interface KnowledgeSourceRow {
  fileName?: unknown;
  excerpt?: unknown;
}

function citedNames(sources: unknown): string[] {
  if (!Array.isArray(sources)) return [];
  return sources.flatMap((source: KnowledgeSourceRow) =>
    typeof source?.fileName === "string" ? [source.fileName] : []);
}

/**
 * The capabilities a benchmark run may hold.
 *
 * Agent memory is native to Hermes and deliberately opaque to this projection.
 * Chat benchmarks may still receive document retrieval, but never legacy
 * pgvector memory capabilities.
 */
function benchmarkCapabilities(allowPrivateKnowledge: boolean): AgentCapability[] {
  return allowPrivateKnowledge ? ["knowledge:private:read"] : [];
}

function unanswered(reason: string): BenchmarkCaseOutput {
  return { text: "", citedDocuments: [], latencyMs: null, outputTokens: null, failureReason: reason };
}

export class LiveBenchmarkExecutor implements BenchmarkCaseExecutor {
  constructor(
    private readonly database: OrcaSynapseDatabase,
    private readonly knowledge: AgentKnowledgeRetriever,
    private readonly caseTimeoutMs = CASE_TIMEOUT_MS,
    private readonly pollMs = POLL_MS,
  ) {}

  async execute(run: ClaimedBenchmarkRun, benchmarkCase: BenchmarkCase): Promise<BenchmarkCaseOutput> {
    switch (run.kind) {
      case "CHAT_QUALITY":
        return this.ask(run, benchmarkCase);
      case "RETRIEVAL":
        return this.retrieve(run, benchmarkCase);
      case "MEMORY":
        return this.recall(run, benchmarkCase);
    }
  }

  /**
   * Queues a real agent run and waits for it.
   *
   * The processor in this same worker picks it up on its next tick, so the case
   * takes its turn behind whatever else is running. That is the point: a
   * benchmark measures the installation as it is, including how busy it is.
   */
  private async ask(run: ClaimedBenchmarkRun, benchmarkCase: BenchmarkCase): Promise<BenchmarkCaseOutput> {
    if (!run.agentProfileId || !run.agentProfileVersion || !run.requestedBy) {
      return unanswered("This run has no agent to ask.");
    }
    const [version] = await this.database
      .select()
      .from(agentProfileVersion)
      .where(and(
        eq(agentProfileVersion.profileId, run.agentProfileId),
        eq(agentProfileVersion.version, run.agentProfileVersion),
      ))
      .limit(1);
    if (!version) {
      return unanswered("The agent version this run was pointed at no longer exists.");
    }

    const runId = randomUUID();
    await this.database.insert(agentRun).values({
      id: runId,
      profileId: run.agentProfileId,
      profileVersionId: version.id,
      profileVersion: version.version,
      profileDistributionDigest: version.distributionDigest,
      ownerSubject: run.ownerSubject,
      requestedBy: run.requestedBy,
      // Its own session, and no history: each case must be answerable on its
      // own, or a suite silently measures whether case 7 primed case 8.
      sessionId: runId,
      memorySessionKey: runId,
      input: benchmarkCase.prompt,
      conversationHistory: [],
      modelAlias: version.modelAlias,
      jobId: randomUUID(),
      effectiveCapabilities: benchmarkCapabilities(version.allowPrivateKnowledge),
    });

    const finished = await this.waitFor(runId);
    if (!finished) {
      return unanswered(`No answer within ${Math.round(this.caseTimeoutMs / 1_000)}s.`);
    }
    if (finished.status !== "COMPLETED") {
      return {
        text: finished.output ?? "",
        citedDocuments: citedNames(finished.sources),
        latencyMs: null,
        outputTokens: finished.outputTokens,
        failureReason: finished.failureMessage ?? `The run finished as ${finished.status}.`,
      };
    }
    return {
      text: finished.output ?? "",
      citedDocuments: citedNames(finished.sources),
      // The run's own interval, not the wall clock: queue time behind other
      // work is real but belongs to the installation's load, not to the model,
      // and it would make the same case time differently every run.
      latencyMs: finished.startedAt && finished.completedAt
        ? Math.max(0, finished.completedAt.getTime() - finished.startedAt.getTime())
        : null,
      outputTokens: finished.outputTokens,
      failureReason: null,
    };
  }

  private async waitFor(runId: string) {
    const deadline = Date.now() + this.caseTimeoutMs;
    for (;;) {
      const [row] = await this.database
        .select({
          status: agentRun.status,
          output: agentRun.output,
          sources: agentRun.sources,
          outputTokens: agentRun.outputTokens,
          failureMessage: agentRun.failureMessage,
          startedAt: agentRun.startedAt,
          completedAt: agentRun.completedAt,
        })
        .from(agentRun)
        .where(eq(agentRun.id, runId))
        .limit(1);
      if (row && (TERMINAL as readonly string[]).includes(row.status)) return row;
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
  }

  /**
   * Searches the same vector plane a conversation searches.
   *
   * Scored on the passages themselves rather than on an answer written from
   * them, because a retrieval suite asks whether the right document came back —
   * a question a generated answer can obscure in both directions.
   */
  private async retrieve(run: ClaimedBenchmarkRun, benchmarkCase: BenchmarkCase): Promise<BenchmarkCaseOutput> {
    const policy = await this.knowledgeLimits();
    const startedAt = Date.now();
    const sources = await this.knowledge.search(run.ownerSubject, benchmarkCase.prompt, policy);
    const latencyMs = Date.now() - startedAt;
    return {
      text: sources.map(({ excerpt }) => excerpt).join("\n\n"),
      citedDocuments: sources.map(({ fileName }) => fileName),
      latencyMs,
      outputTokens: null,
      failureReason: null,
    };
  }

  /**
   * Recalls, and never captures.
   *
   * A memory suite asks what this installation already knows about its owner.
   * Seeding a fact to then find it would make the benchmark write to the plane
   * it measures, and every later run would read what the earlier ones left.
   */
  private async recall(run: ClaimedBenchmarkRun, benchmarkCase: BenchmarkCase): Promise<BenchmarkCaseOutput> {
    void run;
    void benchmarkCase;
    return unanswered("Memory is managed internally by Hermes and is not exposed to OrcaSynapse benchmarks.");
  }

  /** The active policy's retrieval bounds, or the shipped defaults. */
  private async knowledgeLimits(): Promise<{ limit: number; minimumScore: number }> {
    const [policy] = await this.database
      .select({
        limit: memoryPolicy.knowledgeRecallLimit,
        minimumScore: memoryPolicy.knowledgeMinimumScore,
      })
      .from(memoryPolicy)
      .where(eq(memoryPolicy.status, "ACTIVE"))
      .limit(1);
    return {
      limit: policy?.limit ?? DEFAULT_MEMORY_POLICY.knowledgeRecallLimit,
      minimumScore: policy?.minimumScore ?? DEFAULT_MEMORY_POLICY.knowledgeMinimumScore,
    };
  }

}
