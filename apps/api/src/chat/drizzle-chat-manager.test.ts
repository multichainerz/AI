import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  agentProfile,
  agentProfileVersion,
  agentRun,
  agentRunApproval,
  auditEvent,
  chatConversation,
  chatFeedback,
  chatMessage,
  chatConversationDocument,
  createTestDatabase,
  document,
  evaluationRun,
  guardrailPolicy,
  type TestDatabase,
} from "@orcasynapse/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../agents/agent-manager.js";
import { boundedConversationHistory, DrizzleChatManager } from "./drizzle-chat-manager.js";
import {
  ChatConfigurationError,
  ChatConversationConflictError,
  ChatConversationNotFoundError,
  ChatMessageNotFoundError,
  ChatPolicyViolationError,
  ChatRateLimitError,
  type ChatPrincipal,
} from "./chat-manager.js";

let context: TestDatabase;

beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); });
beforeEach(async () => { await context.reset(); });

const principal = {
  id: randomUUID(), subject: "local-admin:operator", identityMode: "ADMIN", scopes: [],
} as unknown as ChatPrincipal;
const otherPrincipal = { ...principal, subject: "local-admin:someone-else" } as ChatPrincipal;

/** Writes the AgentRun row a real submission would, so the message FK resolves. */
async function createRun(status: "QUEUED" | "WAITING_FOR_APPROVAL" = "QUEUED") {
  const [profile] = await context.database.select().from(agentProfile).limit(1);
  const [version] = await context.database.select().from(agentProfileVersion).limit(1);
  const [run] = await context.database
    .insert(agentRun)
    .values({
      profileId: profile!.id, profileVersionId: version!.id, profileVersion: 1,
      ownerSubject: principal.subject, requestedBy: randomUUID(),
      sessionId: randomUUID(), memorySessionKey: randomUUID(), input: "Hello",
      conversationHistory: [], outputCharacterLimit: 200_000, modelAlias: "hermes-agent",
      jobId: randomUUID(), effectiveCapabilities: [], status,
    })
    .returning({ id: agentRun.id });
  return run!.id;
}

/** Stands in for Hermes: the agent manager is a separate, already-converted seam. */
function agents(overrides: Partial<AgentManager> = {}) {
  return {
    submitRun: vi.fn(async () => {
      const id = await createRun();
      const [profile] = await context.database.select().from(agentProfile).limit(1);
      return { id, profileId: profile!.id, profileVersion: 1 };
    }),
    cancelRun: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as AgentManager;
}

function manager(agentManager: AgentManager = agents()) {
  return new DrizzleChatManager(context.database, agentManager);
}

/** An ACTIVE profile is the precondition for every conversation. */
async function seedActiveProfile(modelAlias = "hermes-agent") {
  const [profile] = await context.database
    .insert(agentProfile)
    .values({ slug: `agent-${randomUUID().slice(0, 8)}`, status: "ACTIVE", currentVersion: 1, activeVersion: 1 })
    .returning({ id: agentProfile.id });
  await context.database.insert(agentProfileVersion).values({
    profileId: profile!.id, version: 1, displayName: "Support agent", purpose: "Answer questions.",
    instructions: "Answer only from approved knowledge.", soulMd: "Careful assistant.", skills: [],
    modelAlias, maxTurns: 1, timeoutSeconds: 120, maxConcurrentRuns: 1,
  });
  return profile!.id;
}

async function seedActiveGuardrail(overrides: Record<string, unknown> = {}) {
  const [evaluation] = await context.database
    .insert(evaluationRun)
    .values({
      name: "Guardrail baseline", targetType: "POLICY", targetReference: "guardrail:baseline",
      targetVersion: "1", minimumPassRate: 0.9, requiredCategories: ["safety"],
    })
    .returning({ id: evaluationRun.id });
  await context.database.insert(guardrailPolicy).values({
    slug: "baseline", displayName: "Baseline", description: "Conservative baseline.",
    version: "1", status: "ACTIVE", maxInputCharacters: 100, maxOutputCharacters: 5_000,
    activationEvaluationId: evaluation!.id, firstActivatedAt: new Date(),
    ...overrides,
  });
}

describe("DrizzleChatManager conversations", () => {
  it("refuses to start a conversation without an active profile", async () => {
    await expect(manager().create(principal, {} as never))
      .rejects.toBeInstanceOf(ChatConfigurationError);
  });

  it("pins the conversation to the profile's model and rejects a mismatch", async () => {
    const profileId = await seedActiveProfile();

    const created = await manager().create(principal, { profileId } as never);

    expect(created).toMatchObject({
      modelAlias: "hermes-agent", profileName: "Support agent", status: "ACTIVE", messageCount: 0,
    });
    await expect(manager().create(principal, { profileId, modelAlias: "some-other-model" } as never))
      .rejects.toThrow(/uses model 'hermes-agent'/);
  });

  it("stamps a Hermes memory key that Prisma used to default client-side", async () => {
    const profileId = await seedActiveProfile();

    const created = await manager().create(principal, { profileId } as never);

    const [stored] = await context.database
      .select({ hermesMemoryKey: chatConversation.hermesMemoryKey })
      .from(chatConversation).where(eq(chatConversation.id, created.id));
    expect(stored?.hermesMemoryKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("scopes listing and reading to the owner", async () => {
    const profileId = await seedActiveProfile();
    const created = await manager().create(principal, { profileId } as never);

    expect((await manager().list(principal)).items.map(({ id }) => id)).toEqual([created.id]);
    expect((await manager().list(otherPrincipal)).items).toHaveLength(0);
    await expect(manager().get(otherPrincipal, created.id)).rejects.toBeInstanceOf(ChatConversationNotFoundError);
    await expect(manager().update(otherPrincipal, created.id, { title: "Stolen" } as never))
      .rejects.toBeInstanceOf(ChatConversationNotFoundError);
  });

  it("renames and archives a conversation", async () => {
    const profileId = await seedActiveProfile();
    const created = await manager().create(principal, { profileId } as never);

    expect(await manager().update(principal, created.id, { title: "Runbook help" } as never))
      .toMatchObject({ title: "Runbook help" });
    expect(await manager().update(principal, created.id, { status: "ARCHIVED" } as never))
      .toMatchObject({ status: "ARCHIVED", title: "Runbook help" });
  });
});

describe("DrizzleChatManager message submission", () => {
  async function conversation() {
    const profileId = await seedActiveProfile();
    const created = await manager().create(principal, { profileId } as never);
    return created.id;
  }

  it("stores the turn pair, titles the conversation, and links the run", async () => {
    const conversationId = await conversation();

    const submission = await manager().submitMessage(principal, conversationId, "How do I restart Hermes?");

    expect(submission.userMessage).toMatchObject({ role: "USER", status: "COMPLETED", content: "How do I restart Hermes?" });
    expect(submission.assistantMessage).toMatchObject({ role: "ASSISTANT", status: "PENDING", content: "" });
    const [run] = await context.database.select({ id: agentRun.id }).from(agentRun);
    expect(submission.assistantMessage.agentRunId).toBe(run!.id);
    // The first message names the conversation.
    expect((await manager().get(principal, conversationId)).title).toBe("How do I restart Hermes?");
    const [stored] = await context.database
      .select({ generation: chatConversation.generation, lastMessageAt: chatConversation.lastMessageAt })
      .from(chatConversation).where(eq(chatConversation.id, conversationId));
    expect(stored?.generation).toBe(1);
    expect(stored?.lastMessageAt).not.toBeNull();
  });

  it("refuses a second message while a run is in progress", async () => {
    const conversationId = await conversation();
    await manager().submitMessage(principal, conversationId, "First");

    await expect(manager().submitMessage(principal, conversationId, "Second"))
      .rejects.toThrow(/already has a Hermes run in progress/);
  });

  it("abandons a stale pending turn rather than blocking forever", async () => {
    const conversationId = await conversation();
    await manager().submitMessage(principal, conversationId, "First");
    await context.database
      .update(chatMessage)
      .set({ createdAt: new Date(Date.now() - 2 * 60 * 60 * 1_000) })
      .where(eq(chatMessage.status, "PENDING"));

    await expect(manager().submitMessage(principal, conversationId, "Second")).resolves.toBeDefined();

    const abandoned = (await context.database.select().from(chatMessage))
      .filter(({ errorCode }) => errorCode === "HERMES_RUN_ABANDONED");
    expect(abandoned).toHaveLength(1);
  });

  it("refuses new messages on an archived conversation", async () => {
    const conversationId = await conversation();
    await manager().update(principal, conversationId, { status: "ARCHIVED" } as never);

    await expect(manager().submitMessage(principal, conversationId, "Hello"))
      .rejects.toThrow(/Archived conversations/);
  });

  it("fails the pending turn when Hermes submission throws", async () => {
    const conversationId = await conversation();
    const agentManager = agents({
      submitRun: vi.fn(async () => { throw new Error("hermes unreachable"); }) as never,
    });

    await expect(manager(agentManager).submitMessage(principal, conversationId, "Hello")).rejects.toThrow();

    const [assistant] = (await context.database.select().from(chatMessage))
      .filter(({ role }) => role === "ASSISTANT");
    expect(assistant).toMatchObject({ status: "FAILED", errorCode: "HERMES_SUBMISSION_FAILED" });
    const failures = (await context.database.select().from(auditEvent))
      .filter(({ action }) => action === "chat.hermes_run_failed");
    expect(failures).toHaveLength(1);
  });

  it("enforces the guardrail input limit and records the block", async () => {
    await seedActiveGuardrail();
    const conversationId = await conversation();

    await expect(manager().submitMessage(principal, conversationId, "x".repeat(101)))
      .rejects.toBeInstanceOf(ChatPolicyViolationError);

    const blocks = (await context.database.select().from(auditEvent))
      .filter(({ action }) => action === "guardrail.request_blocked");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.metadata).toMatchObject({ reason: "INPUT_CHARACTER_LIMIT", observedCharacters: 101 });
    // Nothing was written to the conversation.
    expect(await context.database.select().from(chatMessage)).toHaveLength(0);
  });

  it("refuses chat when the catalogue is enforced but no policy is active", async () => {
    await seedActiveGuardrail({ status: "DRAFT" });
    const conversationId = await conversation();

    await expect(manager().submitMessage(principal, conversationId, "Hello"))
      .rejects.toThrow(/Activate one evaluated guardrail policy/);
  });

  it("rate-limits a subject across its conversations", async () => {
    const conversationId = await conversation();
    // The limit is twelve user messages per minute.
    for (let index = 0; index < 12; index += 1) {
      await context.database.insert(chatMessage).values({
        conversationId, ordinal: 1_000 + index, role: "USER", status: "COMPLETED", content: `filler ${index}`,
      });
    }

    await expect(manager().submitMessage(principal, conversationId, "One too many"))
      .rejects.toBeInstanceOf(ChatRateLimitError);
  });
});

describe("DrizzleChatManager run control", () => {
  async function conversationWithRun() {
    const profileId = await seedActiveProfile();
    const created = await manager().create(principal, { profileId } as never);
    const agentManager = agents();
    const submission = await manager(agentManager).submitMessage(principal, created.id, "Hello");
    return { conversationId: created.id, runId: submission.assistantMessage.agentRunId!, agentManager };
  }

  it("cancels through the agent manager when a run is linked", async () => {
    const { conversationId, runId, agentManager } = await conversationWithRun();

    await manager(agentManager).cancelActiveRun(principal, conversationId);

    expect(agentManager.cancelRun).toHaveBeenCalledWith(expect.anything(), runId, false);
  });

  it("cancels locally when Hermes was never reached", async () => {
    const profileId = await seedActiveProfile();
    const created = await manager().create(principal, { profileId } as never);
    await context.database.insert(chatMessage).values({
      conversationId: created.id, ordinal: 2, role: "ASSISTANT", status: "PENDING", content: "",
    });

    await manager().cancelActiveRun(principal, created.id);

    const [assistant] = (await context.database.select().from(chatMessage))
      .filter(({ role }) => role === "ASSISTANT");
    expect(assistant).toMatchObject({ status: "CANCELLED", errorCode: "CANCELLED_BEFORE_HERMES_SUBMISSION" });
  });

  it("reports when no run is active", async () => {
    const profileId = await seedActiveProfile();
    const created = await manager().create(principal, { profileId } as never);

    await expect(manager().cancelActiveRun(principal, created.id))
      .rejects.toThrow(/No Hermes run is currently active/);
  });

  it("decides an approval exactly once and scopes it to the run owner", async () => {
    const { runId } = await conversationWithRun();
    await context.database
      .update(agentRun).set({ status: "WAITING_FOR_APPROVAL" }).where(eq(agentRun.id, runId));
    const [approval] = await context.database
      .insert(agentRunApproval)
      .values({
        runId, status: "PENDING", command: "rm -rf /tmp/cache", summary: "Clear the cache",
        choices: ["ALLOW_ONCE", "DENY"], expiresAt: new Date(Date.now() + 600_000),
      })
      .returning({ id: agentRunApproval.id });

    const decided = await manager().decideApproval(principal, approval!.id, { decision: "ALLOW_ONCE" } as never);

    expect(decided).toMatchObject({ status: "APPROVED", decision: "ALLOW_ONCE" });
    await expect(manager().decideApproval(principal, approval!.id, { decision: "DENY" } as never))
      .rejects.toThrow(/already been decided/);
    await expect(manager().decideApproval(otherPrincipal, approval!.id, { decision: "DENY" } as never))
      .rejects.toBeInstanceOf(ChatMessageNotFoundError);
  });
});

describe("DrizzleChatManager forking, deletion and feedback", () => {
  async function completedExchange() {
    const profileId = await seedActiveProfile();
    const created = await manager().create(principal, { profileId } as never);
    await context.database.insert(chatMessage).values([
      { conversationId: created.id, ordinal: 1, role: "USER", status: "COMPLETED", content: "Question", completedAt: new Date() },
      { conversationId: created.id, ordinal: 2, role: "ASSISTANT", status: "COMPLETED", content: "Answer", completedAt: new Date() },
    ]);
    return created.id;
  }

  it("forks completed turns into a new conversation", async () => {
    const conversationId = await completedExchange();

    const fork = await manager().fork(principal, conversationId, {} as never);

    expect(fork.title).toMatch(/\(fork\)$/);
    expect(fork.messageCount).toBe(2);
    const forked = await manager().get(principal, fork.id);
    expect(forked.messages.map(({ content }) => content)).toEqual(["Question", "Answer"]);
    // Forking must not disturb the source.
    expect((await manager().get(principal, conversationId)).messages).toHaveLength(2);
  });

  it("forks only through the named message", async () => {
    const conversationId = await completedExchange();
    const source = await manager().get(principal, conversationId);

    const fork = await manager().fork(principal, conversationId, {
      throughMessageId: source.messages[0]!.id,
    } as never);

    expect((await manager().get(principal, fork.id)).messages.map(({ content }) => content)).toEqual(["Question"]);
    await expect(manager().fork(principal, conversationId, { throughMessageId: randomUUID() } as never))
      .rejects.toBeInstanceOf(ChatMessageNotFoundError);
  });

  it("refuses to delete a conversation with a live run", async () => {
    const profileId = await seedActiveProfile();
    const created = await manager().create(principal, { profileId } as never);
    await manager().submitMessage(principal, created.id, "Hello");

    await expect(manager().delete(principal, created.id))
      .rejects.toThrow(/Stop the active Hermes run/);
  });

  it("deletes a settled conversation and its messages", async () => {
    const conversationId = await completedExchange();

    await manager().delete(principal, conversationId);

    expect(await context.database.select().from(chatConversation)).toHaveLength(0);
    expect(await context.database.select().from(chatMessage)).toHaveLength(0);
    await expect(manager().delete(principal, conversationId)).rejects.toBeInstanceOf(ChatConversationNotFoundError);
  });

  it("replaces feedback on the same message rather than adding a second row", async () => {
    const conversationId = await completedExchange();
    const assistant = (await manager().get(principal, conversationId)).messages
      .find(({ role }) => role === "ASSISTANT")!;

    expect(await manager().setFeedback(principal, assistant.id, { rating: "HELPFUL" } as never))
      .toMatchObject({ rating: "HELPFUL" });
    expect(await manager().setFeedback(principal, assistant.id, { rating: "NOT_HELPFUL", comment: "Wrong" } as never))
      .toMatchObject({ rating: "NOT_HELPFUL", comment: "Wrong" });

    expect(await context.database.select().from(chatFeedback)).toHaveLength(1);
    expect((await manager().get(principal, conversationId)).messages
      .find(({ role }) => role === "ASSISTANT")?.feedback).toMatchObject({ rating: "NOT_HELPFUL" });
  });

  it("refuses feedback on another owner's message and on a pending one", async () => {
    const conversationId = await completedExchange();
    const assistant = (await manager().get(principal, conversationId)).messages
      .find(({ role }) => role === "ASSISTANT")!;

    await expect(manager().setFeedback(otherPrincipal, assistant.id, { rating: "HELPFUL" } as never))
      .rejects.toBeInstanceOf(ChatMessageNotFoundError);
    await expect(manager().setFeedback(principal, randomUUID(), { rating: "HELPFUL" } as never))
      .rejects.toBeInstanceOf(ChatMessageNotFoundError);
  });
});

describe("DrizzleChatManager metrics", () => {
  it("summarises the last day of responses and feedback", async () => {
    const profileId = await seedActiveProfile();
    const created = await manager().create(principal, { profileId } as never);
    await context.database.insert(chatMessage).values([
      { conversationId: created.id, ordinal: 1, role: "USER", status: "COMPLETED", content: "Q" },
      { conversationId: created.id, ordinal: 2, role: "ASSISTANT", status: "COMPLETED", content: "A", totalTokens: 100, latencyMs: 400 },
      { conversationId: created.id, ordinal: 4, role: "ASSISTANT", status: "FAILED", content: "", totalTokens: 0, latencyMs: 200 },
    ]);

    const metrics = await manager().metrics();

    expect(metrics).toMatchObject({
      conversations: 1, responses: 2, completed: 1, failed: 1, cancelled: 0,
      totalTokens: 100, averageLatencyMs: 300, failureRate: 0.5,
    });
    expect(metrics.feedback).toEqual({ helpful: 0, notHelpful: 0 });
  });
});

describe("boundedConversationHistory", () => {
  it("keeps only completed user and assistant pairs, oldest first", () => {
    expect(boundedConversationHistory([
      { role: "USER", status: "COMPLETED", content: "Q1", ordinal: 1 },
      { role: "ASSISTANT", status: "COMPLETED", content: "A1", ordinal: 2 },
      { role: "USER", status: "COMPLETED", content: "Q2", ordinal: 3 },
      { role: "ASSISTANT", status: "PENDING", content: "", ordinal: 4 },
    ])).toEqual([
      { role: "user", content: "Q1" },
      { role: "assistant", content: "A1" },
    ]);
  });

  it("drops the oldest pairs once the character budget is exhausted", () => {
    const long = "x".repeat(20_000);
    const history = boundedConversationHistory([
      { role: "USER", status: "COMPLETED", content: long, ordinal: 1 },
      { role: "ASSISTANT", status: "COMPLETED", content: long, ordinal: 2 },
      { role: "USER", status: "COMPLETED", content: long, ordinal: 3 },
      { role: "ASSISTANT", status: "COMPLETED", content: long, ordinal: 4 },
    ]);

    // Two pairs is 80k characters, over the 64k budget, so only the newest survives.
    expect(history).toHaveLength(2);
  });
});

describe("DrizzleChatManager pinned knowledge", () => {
  async function conversationAndDocument() {
    const profileId = await seedActiveProfile();
    const created = await manager().create(principal, { profileId } as never);
    const [source] = await context.database
      .insert(document)
      .values({
        ownerSubject: principal.subject,
        fileName: "runbook.pdf",
        mediaType: "application/pdf",
        sizeBytes: 4_096,
        sha256: createHash("sha256").update("runbook").digest("hex"),
        classification: "INTERNAL",
        status: "READY",
        retentionUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
      })
      .returning({ id: document.id });
    return { conversationId: created.id, documentId: source!.id };
  }

  it("pins a document and reports it on the conversation", async () => {
    const { conversationId, documentId } = await conversationAndDocument();

    const pinned = await manager().attachDocument(principal, conversationId, documentId);

    expect(pinned.knowledgeDocuments).toEqual([
      expect.objectContaining({ id: documentId, fileName: "runbook.pdf" }),
    ]);
    // Pinning twice is idempotent rather than a conflict.
    expect((await manager().attachDocument(principal, conversationId, documentId)).knowledgeDocuments)
      .toHaveLength(1);
  });

  it("refuses to pin another owner's document", async () => {
    const { conversationId, documentId } = await conversationAndDocument();

    await expect(manager().attachDocument(otherPrincipal, conversationId, documentId))
      .rejects.toBeInstanceOf(ChatConversationNotFoundError);
    await expect(manager().attachDocument(principal, conversationId, randomUUID()))
      .rejects.toBeInstanceOf(ChatMessageNotFoundError);
  });

  it("unpins a document and leaves the conversation unscoped again", async () => {
    const { conversationId, documentId } = await conversationAndDocument();
    await manager().attachDocument(principal, conversationId, documentId);

    const unpinned = await manager().detachDocument(principal, conversationId, documentId);

    expect(unpinned.knowledgeDocuments).toEqual([]);
    expect(await context.database.select().from(chatConversationDocument)).toHaveLength(0);
  });

  it("narrows a submitted run to the pinned documents", async () => {
    const { conversationId, documentId } = await conversationAndDocument();
    await manager().attachDocument(principal, conversationId, documentId);
    const agentManager = agents();

    await manager(agentManager).submitMessage(principal, conversationId, "What does the runbook say?");

    // The run must carry the scope, because the worker reads it from there.
    expect(agentManager.submitRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ knowledgeDocumentIds: [documentId] }),
    );
  });

  it("leaves an unpinned conversation retrieving everything the owner holds", async () => {
    const profileId = await seedActiveProfile();
    const created = await manager().create(principal, { profileId } as never);
    const agentManager = agents();

    await manager(agentManager).submitMessage(principal, created.id, "Anything at all");

    const options = vi.mocked(agentManager.submitRun).mock.calls[0]![2];
    expect(options).not.toHaveProperty("knowledgeDocumentIds");
  });

  it("drops the pin when the document is deleted", async () => {
    const { conversationId, documentId } = await conversationAndDocument();
    await manager().attachDocument(principal, conversationId, documentId);

    await context.database.delete(document).where(eq(document.id, documentId));

    expect((await manager().get(principal, conversationId)).knowledgeDocuments).toEqual([]);
  });
});
