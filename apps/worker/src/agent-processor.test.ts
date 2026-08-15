import { randomUUID } from "node:crypto";
import { AGENT_RUN_ENDED_EVENT_TYPE } from "@orcasynapse/contracts";
import { asc, eq } from "drizzle-orm";
import {
  agentProfile,
  agentProfileVersion,
  agentRun,
  agentRunEvent,
  agentRuntimeControl,
  auditEvent,
  chatConversation,
  chatMessage,
  createTestDatabase,
  hermesRuntimeNode,
  serviceConnection,
  type TestDatabase,
} from "@orcasynapse/database";
import { HermesRunDetachedError } from "@orcasynapse/runtime-clients";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DrizzleAgentProcessor, type AgentHermesRuntime } from "./agent-processor.js";

let context: TestDatabase;

beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); }, 120_000);
beforeEach(async () => { await context.reset(); });

const WORKER_ID = randomUUID();

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
    }));

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
    }));

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
    }));

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
    }));

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
