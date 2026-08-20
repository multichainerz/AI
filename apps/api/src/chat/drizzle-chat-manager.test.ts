import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { ChatStreamEvent } from "@orcasynapse/contracts";
import { eq } from "drizzle-orm";
import {
  agentProfile,
  agentProfileVersion,
  agentRun,
  agentRunApproval,
  agentRunEvent,
  auditEvent,
  chatArtifact,
  chatConversation,
  chatFeedback,
  chatMessage,
  chatSchedule,
  createTestDatabase,
  division,
  guardrailPolicy,
  chatRunWakeStatement,
  createChatRunWakeHub,
  NO_CHAT_RUN_WAKE,
  type ChatRunWakeHub,
  type TestDatabase,
} from "@orcasynapse/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../agents/agent-manager.js";
import {
  DrizzleChatManager,
  type HermesSessionLifecycle,
} from "./drizzle-chat-manager.js";
import {
  ChatConfigurationError,
  ChatConversationNotFoundError,
  ChatMessageNotFoundError,
  ChatPolicyViolationError,
  ChatRateLimitError,
  type ChatPrincipal,
} from "./chat-manager.js";

let context: TestDatabase;

beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); }, 120_000);
beforeEach(async () => { await context.reset(); });

/*
 * Built the way `requireChatPrincipal` builds one, which the earlier fixture was
 * not: `id` is a *session* row id and the account uuid lives only in `subject`,
 * so a fixture whose subject was the literal "local-admin:operator" could not
 * catch a write path that stored `id` where an account id belonged. The mode is
 * the real enum value for the same reason -- "ADMIN" is not one.
 */
const administratorId = randomUUID();
const principal = {
  id: randomUUID(),
  subject: `local-admin:${administratorId}`,
  identityMode: "ADMINISTRATOR_PREVIEW",
  scopes: [],
} as unknown as ChatPrincipal;
const otherPrincipal = {
  ...principal,
  id: randomUUID(),
  subject: `local-admin:${randomUUID()}`,
} as ChatPrincipal;

/** Writes the AgentRun row a real submission would, so the message FK resolves. */
async function createRun(status: "QUEUED" | "WAITING_FOR_APPROVAL" = "QUEUED") {
  const [profile] = await context.database.select().from(agentProfile).limit(1);
  const [version] = await context.database.select().from(agentProfileVersion).limit(1);
  const [run] = await context.database
    .insert(agentRun)
    .values({
      profileId: profile!.id, profileVersionId: version!.id, profileVersion: 1,
      ownerSubject: principal.subject, requestedBy: randomUUID(),
      sessionId: randomUUID(), input: "Hello",
      outputCharacterLimit: 200_000, modelAlias: "hermes-agent",
      jobId: randomUUID(), status,
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

function nativeSessions(overrides: Partial<HermesSessionLifecycle> = {}): HermesSessionLifecycle {
  return {
    forkSession: vi.fn(async () => "forked" as const),
    deleteSession: vi.fn(async () => undefined),
    ...overrides,
  };
}

function manager(
  agentManager: AgentManager = agents(),
  wake: ChatRunWakeHub = NO_CHAT_RUN_WAKE,
  sessions: HermesSessionLifecycle = nativeSessions(),
) {
  return new DrizzleChatManager(context.database, agentManager, wake, sessions);
}

/**
 * A hub whose `wait` returns the instant it is called, and counts the passes.
 *
 * Stands in for a producer writing faster than any real worker does, which is
 * the only condition under which the read-rate floor is load-bearing.
 */
function relentlessWake(): ChatRunWakeHub & { passes: () => number } {
  let passes = 0;
  return {
    connected: true,
    size: 0,
    passes: () => passes,
    watch: () => ({ wait: async () => { passes += 1; }, close: () => undefined }),
    stop: async () => undefined,
  };
}

/** An ACTIVE profile is the precondition for every conversation. */
async function seedActiveProfile(modelAlias = "hermes-agent") {
  const [profile] = await context.database
    .insert(agentProfile)
    .values({ slug: `agent-${randomUUID().slice(0, 8)}`, status: "ACTIVE", currentVersion: 1, activeVersion: 1 })
    .returning({ id: agentProfile.id });
  await context.database.insert(agentProfileVersion).values({
    profileId: profile!.id, version: 1, displayName: "Support agent", purpose: "Answer questions.",
    instructions: "Answer precisely and state uncertainty.", soulMd: "Careful assistant.",
    modelAlias, maxTurns: 1, timeoutSeconds: 120, maxConcurrentRuns: 1,
  });
  return profile!.id;
}

async function seedActiveGuardrail(overrides: Record<string, unknown> = {}) {
  await context.database.insert(guardrailPolicy).values({
    slug: "baseline", displayName: "Baseline", description: "Conservative baseline.",
    version: "1", status: "ACTIVE", maxInputCharacters: 100, maxOutputCharacters: 5_000,
    firstActivatedAt: new Date(),
    ...overrides,
  });
}

describe("DrizzleChatManager conversations", () => {
  it("refuses to start a conversation without an active profile", async () => {
    await expect(manager().create(principal, {} as never))
      .rejects.toBeInstanceOf(ChatConfigurationError);
  });

  /*
   * The second hole increment A closes, and the one the test above cannot see.
   *
   * `activeProfile(undefined)` used to fall through to
   * `orderBy(desc(updatedAt)).limit(1)` -- omit the id and you were handed
   * whichever profile had been edited most recently. With divisions that is a
   * free read of another division's agent: no UUID to guess, just leave the
   * field out.
   *
   * Note why this needs its own test rather than strengthening the one above:
   * that case seeds no profile at all, so it throws whether the guess exists or
   * not, and would keep passing with the hole wide open. Here a profile *is*
   * active and reachable, so the only way to pass is to refuse to guess.
   */
  it("refuses to guess a profile when the caller names none", async () => {
    await seedActiveProfile();

    await expect(manager().create(principal, {} as never))
      .rejects.toBeInstanceOf(ChatConfigurationError);
  });

  /*
   * The same 404-not-409 rule the agents side asserts, pinned here too, because
   * a caller reaches a profile through two doors and only one of them was ever
   * tested. A profile the caller may not see must be indistinguishable from one
   * that does not exist -- so this is `ChatConversationNotFoundError` (404) and
   * not `ChatConfigurationError`, which would say "not active" and thereby
   * confirm the UUID names a real profile.
   */
  it("answers 404 for a profile the caller cannot see", async () => {
    await seedActiveProfile();

    await expect(manager().create(principal, { profileId: randomUUID() } as never))
      .rejects.toBeInstanceOf(ChatConversationNotFoundError);
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

  it("hands submitRun the caller's division so a division-assigned profile can send", async () => {
    const [group] = await context.database.insert(division)
      .values({ slug: "alpha", displayName: "Alpha" }).returning();
    const profileId = await seedActiveProfile();
    await context.database.update(agentProfile)
      .set({ divisionId: group!.id }).where(eq(agentProfile.id, profileId));

    const person: ChatPrincipal = {
      id: randomUUID(),
      subject: `user:${randomUUID()}`,
      identityMode: "ENTERPRISE",
      scopes: ["chat:use", "agents:use"],
      divisionId: group!.id,
    };
    const created = await manager().create(person, { profileId } as never);
    const agentManager = agents();
    await manager(agentManager).submitMessage(person, created.id, "Hello");

    expect(agentManager.submitRun).toHaveBeenCalledWith(
      expect.objectContaining({ divisionId: group!.id, identityMode: "ENTERPRISE" }),
      expect.objectContaining({ profileId, input: "Hello" }),
      expect.anything(),
    );
  });

  /*
   * Uploads attach to the message that sends them. Stored at pick time with a
   * null messageId (so they survive a closed tab and appear on Files), they
   * bind to the next user message on submit -- and only to it: a later
   * message must not steal them, and an agent deliverable awaiting its own
   * attribution must not be re-homed by someone else's send.
   */
  it("binds pending uploads to the user message that sends them", async () => {
    const conversationId = await conversation();
    const seedArtifact = async (origin: "UPLOADED" | "AGENT", name: string) => {
      const [row] = await context.database.insert(chatArtifact).values({
        conversationId, origin, ownerSubject: principal.subject,
        name, path: name, mediaType: "text/plain",
        sizeBytes: 5, sha256: "0".repeat(64), storage: "INLINE", observedAt: new Date(),
      }).returning({ id: chatArtifact.id });
      return row!.id;
    };
    const pendingId = await seedArtifact("UPLOADED", "notes.txt");
    const agentFileId = await seedArtifact("AGENT", "report.md");

    const first = await manager().submitMessage(principal, conversationId, "read the attached file");

    const bindings = async () => new Map(
      (await context.database.select({ id: chatArtifact.id, messageId: chatArtifact.messageId }).from(chatArtifact))
        .map(({ id, messageId }) => [id, messageId]),
    );
    expect((await bindings()).get(pendingId)).toBe(first.userMessage.id);
    expect((await bindings()).get(agentFileId)).toBeNull();

    // A second message binds nothing retroactively: the upload stays on the
    // bubble that sent it.
    await context.database.update(chatMessage)
      .set({ status: "COMPLETED" })
      .where(eq(chatMessage.id, first.assistantMessage.id));
    const second = await manager().submitMessage(principal, conversationId, "and what does it say?");
    expect(second.userMessage.id).not.toBe(first.userMessage.id);
    expect((await bindings()).get(pendingId)).toBe(first.userMessage.id);
  });

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

  it("blocks on an operator rule and names it without quoting the message", async () => {
    await seedActiveGuardrail({
      rules: [{
        id: randomUUID(), label: "Internal codename", type: "WORD", pattern: "seahorse",
        action: "BLOCK", caseSensitive: false, enabled: true,
      }],
    });
    const conversationId = await conversation();

    await expect(manager().submitMessage(principal, conversationId, "about the seahorse programme"))
      .rejects.toThrow(/Internal codename/);

    const [block] = (await context.database.select().from(auditEvent))
      .filter(({ action }) => action === "guardrail.request_blocked");
    expect(JSON.stringify(block?.metadata)).toContain("Internal codename");
    expect(JSON.stringify(block?.metadata)).not.toContain("seahorse");
    expect(await context.database.select().from(chatMessage)).toHaveLength(0);
  });

  it("keeps a redaction out of the conversation title, not only out of the message", async () => {
    /*
     * The leak this nearly shipped with. `submitMessage` reads `content` three
     * times -- `safeTitle` when the conversation is still unnamed, the stored
     * USER row, and the input handed to `submitRun`. Redacting only the row
     * would leave the matched text sitting in the conversation title, on the
     * sidebar of every screen that lists conversations, which is a more visible
     * place than the message it was removed from.
     */
    await seedActiveGuardrail({
      rules: [{
        id: randomUUID(), label: "Internal codename", type: "WORD", pattern: "seahorse",
        action: "REDACT", caseSensitive: false, enabled: true,
      }],
    });
    const conversationId = await conversation();

    const agentManager = agents();
    await manager(agentManager).submitMessage(principal, conversationId, "about the seahorse programme");

    const [user] = (await context.database.select().from(chatMessage)).filter(({ role }) => role === "USER");
    expect(user?.content).toBe("about the [redacted] programme");

    const [stored] = await context.database
      .select({ title: chatConversation.title })
      .from(chatConversation)
      .where(eq(chatConversation.id, conversationId));
    expect(stored?.title).toBe("about the [redacted] programme");
    expect(stored?.title).not.toContain("seahorse");

    // And the text handed on for execution is the redacted one, so the model
    // never sees what the row and the title no longer show.
    expect(agentManager.submitRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ input: "about the [redacted] programme" }),
      expect.anything(),
    );
  });

  it("refuses chat when the catalogue is enforced but no policy is active", async () => {
    await seedActiveGuardrail({ status: "DRAFT" });
    const conversationId = await conversation();

    await expect(manager().submitMessage(principal, conversationId, "Hello"))
      .rejects.toThrow(/Activate one guardrail policy/);
  });

  /*
   * The silent variant of the test above, and the one that used to fail open.
   *
   * An operator who authors a policy and its rules but never presses Activate
   * has expressed guardrail intent; enforcing nothing while looking configured
   * is the worst available answer. The latch counts authored policies, so this
   * refuses with instructions rather than waving the message through -- and a
   * genuinely fresh install (no policies at all) still chats on the defaults.
   */
  it("refuses chat when only never-activated drafts exist, rather than enforcing nothing", async () => {
    await seedActiveGuardrail({ status: "DRAFT", firstActivatedAt: null });
    const conversationId = await conversation();

    await expect(manager().submitMessage(principal, conversationId, "Hello"))
      .rejects.toThrow(/Activate one guardrail policy/);
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

  it("bounds the activity trail per run, so an older run cannot crowd out a newer one", async () => {
    /*
     * The bound means "the last 500 events of this run", which is what the
     * Prisma include's nested limit meant. Applied once across every run in the
     * conversation and ordered ascending it became "the first 500 events of the
     * conversation" -- so a long-running thread spent its whole allowance on its
     * oldest run and returned nothing for the turn the operator was watching.
     *
     * Two runs, the older one alone over the bound. Before the fix the newer
     * run's events came back empty and the older one's were its first 500; both
     * halves of that are asserted here.
     */
    const { conversationId: id, runId: older } = await conversationWithRun();
    await context.database.update(agentRun).set({ status: "COMPLETED" }).where(eq(agentRun.id, older));
    await context.database
      .update(chatMessage).set({ status: "COMPLETED", completedAt: new Date() })
      .where(eq(chatMessage.agentRunId, older));
    const second = await manager(agents()).submitMessage(principal, id, "And again");
    const newer = second.assistantMessage.agentRunId!;

    const noise = (runId: string, total: number, label: string) =>
      Array.from({ length: total }, (_value, index) => ({
        runId, type: "TOOL_CALL", toolName: `${label}-${index}`,
      }));
    await context.database.insert(agentRunEvent).values(noise(older, 520, "old"));
    await context.database.insert(agentRunEvent).values(noise(newer, 3, "new"));

    const conversation = await manager().get(principal, id);
    const trail = (runId: string) => conversation.messages
      .find((message) => message.agentRunId === runId)!.runtimeEvents;

    // The newest run keeps all three: its own bound, not the conversation's.
    expect(trail(newer).map(({ toolName }) => toolName)).toEqual(["new-0", "new-1", "new-2"]);
    // The older run is bounded to the newest 500 of its own, not the oldest.
    expect(trail(older)).toHaveLength(500);
    expect(trail(older).at(-1)!.toolName).toBe("old-519");
    expect(trail(older).at(0)!.toolName).toBe("old-20");
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
    const sessions = nativeSessions();

    const fork = await manager(agents(), NO_CHAT_RUN_WAKE, sessions).fork(principal, conversationId, {} as never);

    expect(fork.title).toMatch(/\(fork\)$/);
    expect(fork.messageCount).toBe(2);
    const forked = await manager().get(principal, fork.id);
    expect(forked.messages.map(({ content }) => content)).toEqual(["Question", "Answer"]);
    // Forking must not disturb the source.
    expect((await manager().get(principal, conversationId)).messages).toHaveLength(2);
    expect(sessions.forkSession).toHaveBeenCalledWith(conversationId, fork.id);
  });

  it("rejects a historical fork point that Hermes cannot represent faithfully", async () => {
    const conversationId = await completedExchange();
    const source = await manager().get(principal, conversationId);

    await expect(manager().fork(principal, conversationId, { throughMessageId: source.messages[0]!.id } as never))
      .rejects.toThrow(/latest completed message/);
    await expect(manager().fork(principal, conversationId, { throughMessageId: randomUUID() } as never))
      .rejects.toBeInstanceOf(ChatMessageNotFoundError);
  });

  it("keeps a fork usable when a skipped turn sits below the fork point", async () => {
    const profileId = await seedActiveProfile();
    const created = await manager().create(principal, { profileId } as never);
    // Six ordinals at generation three: the assistant turn at 2 failed and the
    // one at 6 failed. The fork therefore copies 1, 3, 4 and 5 - four
    // rows whose highest ordinal is five, not four.
    await context.database
      .update(chatConversation).set({ generation: 3 }).where(eq(chatConversation.id, created.id));
    await context.database.insert(chatMessage).values([
      { conversationId: created.id, ordinal: 1, role: "USER", status: "COMPLETED", content: "Q1", completedAt: new Date() },
      { conversationId: created.id, ordinal: 2, role: "ASSISTANT", status: "FAILED", content: "", errorCode: "HERMES_RUN_ABANDONED", completedAt: new Date() },
      { conversationId: created.id, ordinal: 3, role: "USER", status: "COMPLETED", content: "Q2", completedAt: new Date() },
      { conversationId: created.id, ordinal: 4, role: "ASSISTANT", status: "COMPLETED", content: "A2", completedAt: new Date() },
      { conversationId: created.id, ordinal: 5, role: "USER", status: "COMPLETED", content: "Q3", completedAt: new Date() },
      { conversationId: created.id, ordinal: 6, role: "ASSISTANT", status: "FAILED", content: "", errorCode: "HERMES_EXECUTION_FAILED", completedAt: new Date() },
    ]);

    const fork = await manager().fork(principal, created.id, {} as never);

    // Unwrapped on purpose: before the fix this raises the ChatMessage
    // conversationId/ordinal unique violation, which is the failure to see.
    await manager().submitMessage(principal, fork.id, "Q4");

    const ordinals = (await context.database.select().from(chatMessage))
      .filter(({ conversationId }) => conversationId === fork.id)
      .map(({ ordinal }) => ordinal)
      .sort((left, right) => left - right);
    expect(ordinals).toEqual([1, 3, 4, 5, 7, 8]);
    // The copied ordinals keep their source numbering, so the fork's generation
    // has to be read off the highest of them rather than off the row count.
    const [forked] = await context.database
      .select({ generation: chatConversation.generation })
      .from(chatConversation).where(eq(chatConversation.id, fork.id));
    expect(forked?.generation).toBe(4);
    // Still submittable a second time, so the generation really did advance.
    await context.database
      .update(chatMessage).set({ status: "COMPLETED", content: "A4" })
      .where(eq(chatMessage.status, "PENDING"));
    await expect(manager().submitMessage(principal, fork.id, "Q5")).resolves.toBeDefined();
  });

  it("refuses to fork while Hermes is still producing the current turn", async () => {
    const profileId = await seedActiveProfile();
    const created = await manager().create(principal, { profileId } as never);
    await manager().submitMessage(principal, created.id, "Hello");
    const sessions = nativeSessions();

    await expect(manager(agents(), NO_CHAT_RUN_WAKE, sessions).fork(principal, created.id, {} as never))
      .rejects.toThrow(/Stop the active Hermes run/);
    expect(sessions.forkSession).not.toHaveBeenCalled();
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
    const sessions = nativeSessions();

    await manager(agents(), NO_CHAT_RUN_WAKE, sessions).delete(principal, conversationId);

    expect(await context.database.select().from(chatConversation)).toHaveLength(0);
    expect(await context.database.select().from(chatMessage)).toHaveLength(0);
    expect(sessions.deleteSession).toHaveBeenCalledWith(conversationId);
    await expect(manager().delete(principal, conversationId)).rejects.toBeInstanceOf(ChatConversationNotFoundError);
  });

  it("keeps the local projection when Hermes cannot confirm transcript deletion", async () => {
    const conversationId = await completedExchange();
    const sessions = nativeSessions({ deleteSession: vi.fn(async () => { throw new Error("Hermes offline"); }) });

    await expect(manager(agents(), NO_CHAT_RUN_WAKE, sessions).delete(principal, conversationId))
      .rejects.toThrow("Hermes offline");

    expect(await context.database.select().from(chatConversation)).toHaveLength(1);
    expect(await context.database.select().from(chatMessage)).toHaveLength(2);
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

describe("DrizzleChatManager schedules", () => {
  async function conversationId() {
    const profileId = await seedActiveProfile();
    return (await manager().create(principal, { profileId } as never)).id;
  }

  const hourly = { prompt: "Summarise overnight incidents.", intervalSeconds: 3_600 };

  it("arms the first run one interval out rather than immediately", async () => {
    /*
     * A schedule made due the moment it is created fires while the operator is
     * still looking at the form they submitted. That reads as a bug even though
     * it is what "every hour" literally asks for.
     */
    const id = await conversationId();
    const before = Date.now();

    const schedule = await manager().createSchedule(principal, id, hourly as never);

    expect(schedule.enabled).toBe(true);
    expect(schedule.lastRunAt).toBeNull();
    expect(schedule.lastOutcome).toBeNull();
    expect(new Date(schedule.nextRunAt).getTime()).toBeGreaterThanOrEqual(before + 3_600_000);
  });

  it("honours an explicit first run so a report can land at a stated hour", async () => {
    const id = await conversationId();
    const startAt = new Date(Date.now() + 120_000).toISOString();

    const schedule = await manager().createSchedule(principal, id, { ...hourly, startAt } as never);

    expect(schedule.nextRunAt).toBe(startAt);
  });

  it("refuses a schedule on a conversation owned by somebody else", async () => {
    // The same test `submitMessage` makes. A schedule is a stored intent to
    // call that method later, so it must not be creatable where it could not be
    // called now -- and ownership and existence must produce one error, because
    // reporting them apart discloses that the conversation exists.
    const id = await conversationId();

    await expect(manager().createSchedule(otherPrincipal, id, hourly as never))
      .rejects.toThrow(ChatConversationNotFoundError);
    await expect(manager().listSchedules(otherPrincipal, id))
      .rejects.toThrow(ChatConversationNotFoundError);
  });

  it("refuses to update or delete a schedule owned by somebody else", async () => {
    /*
     * `createSchedule` and `listSchedules` are addressed by conversation and go
     * through `ownedConversation`, which had the only cross-owner case in this
     * file. `updateSchedule` and `deleteSchedule` are addressed by a bare
     * schedule id and are guarded by `ownedSchedule` instead -- and nothing
     * exercised it, so removing its owner predicate left the whole suite green.
     *
     * The blast radius if that regressed is total rather than partial: an update
     * never rewrites `createdBy`, so the dispatcher would go on re-reading the
     * victim's authority and would run an attacker's prompt with the victim's
     * scopes and division, into the victim's own thread.
     */
    const id = await conversationId();
    const schedule = await manager().createSchedule(principal, id, hourly as never);

    await expect(manager().updateSchedule(otherPrincipal, schedule.id, { prompt: "Exfiltrate." } as never))
      .rejects.toThrow(ChatConversationNotFoundError);
    await expect(manager().deleteSchedule(otherPrincipal, schedule.id))
      .rejects.toThrow(ChatConversationNotFoundError);

    // Refused, not merely reported as refused.
    const [row] = await context.database
      .select({ prompt: chatSchedule.prompt })
      .from(chatSchedule)
      .where(eq(chatSchedule.id, schedule.id));
    expect(row!.prompt).toBe(hourly.prompt);
  });

  it("refuses an update that names a revision the schedule has moved past", async () => {
    /*
     * `revision` was stored and returned from the beginning and compared by
     * nothing, so the field advertised a conflict check the product did not
     * perform: two operators editing one schedule took turns overwriting each
     * other with no sign either way.
     */
    const id = await conversationId();
    const schedule = await manager().createSchedule(principal, id, hourly as never);

    const first = await manager().updateSchedule(
      principal, schedule.id, { prompt: "First edit.", expectedRevision: schedule.revision } as never,
    );
    expect(first.revision).toBeGreaterThan(schedule.revision);

    // The second caller still holds the revision it loaded, which has moved.
    await expect(manager().updateSchedule(
      principal, schedule.id, { prompt: "Second edit.", expectedRevision: schedule.revision } as never,
    )).rejects.toThrow(/changed since it was loaded/);

    const [row] = await context.database
      .select({ prompt: chatSchedule.prompt }).from(chatSchedule).where(eq(chatSchedule.id, schedule.id));
    expect(row!.prompt).toBe("First edit.");
  });

  it("still applies an update that names no revision at all", async () => {
    // Optional, so a client that never learned about the field keeps working;
    // this is the half that keeps the addition backward-compatible.
    const id = await conversationId();
    const schedule = await manager().createSchedule(principal, id, hourly as never);

    const updated = await manager().updateSchedule(principal, schedule.id, { prompt: "No revision." } as never);

    expect(updated.prompt).toBe("No revision.");
  });

  it("stores the creator's account id, not the id of the session that created it", async () => {
    /*
     * The column the dispatcher re-reads against `LocalAdministrator` on every
     * fire. `principal.id` is a session row id and matches no account, and no
     * foreign key spans the two -- so writing the wrong one here is invisible
     * until the schedule silently disables itself on its first fire. That is
     * what happened, and this is the assertion that was missing: every other
     * schedule case went through `createSchedule` without ever reading the
     * column back, while the dispatcher's own suite seeded it by hand from a
     * real administrator id, so each half tested a different assumption.
     */
    const id = await conversationId();

    const schedule = await manager().createSchedule(principal, id, hourly as never);

    const [row] = await context.database
      .select({ createdBy: chatSchedule.createdBy, mode: chatSchedule.createdByMode })
      .from(chatSchedule)
      .where(eq(chatSchedule.id, schedule.id));
    expect(row!.createdBy).toBe(administratorId);
    expect(row!.createdBy).not.toBe(principal.id);
    expect(row!.mode).toBe("ADMINISTRATOR_PREVIEW");
  });

  it("refuses a schedule from a sign-in with no account behind it", async () => {
    /*
     * The installation-key recovery session, whose subject is the literal
     * `installation-key-administrator` rather than `local-admin:<uuid>`. It
     * cannot reach this route today -- it carries only `sessions:manage` -- but
     * a schedule whose creator can never be resolved is one that would disable
     * itself on its first fire, so it is refused where the operator can still
     * see why.
     *
     * The conversation is created by that same principal on purpose: ownership
     * is checked before this, and correctly so, which is why a recovery session
     * scheduling on somebody else's conversation is refused for being somebody
     * else's rather than for having no account.
     */
    const recovery = {
      ...principal, subject: "installation-key-administrator",
    } as ChatPrincipal;
    const profileId = await seedActiveProfile();
    const own = await manager().create(recovery, { profileId } as never);

    await expect(manager().createSchedule(recovery, own.id, hourly as never))
      .rejects.toThrow(/not tied to an account/);
  });

  it("refuses a prompt the active policy would block on every fire", async () => {
    // Caught at write time as well as at fire time: this is the one refusal an
    // operator can fix immediately, by shortening what they just typed.
    await seedActiveGuardrail();
    const id = await conversationId();

    await expect(manager().createSchedule(principal, id, { ...hourly, prompt: "x".repeat(101) } as never))
      .rejects.toThrow(/101 characters; the active guardrail policy allows 100/);
  });

  it("re-arms the cadence when a disabled schedule is switched back on", async () => {
    /*
     * `nextRunAt` left in the past would make a schedule disabled for a week
     * fire the instant it returned, which is not what "enable" means to the
     * person clicking it. The stored reason goes with it.
     */
    const id = await conversationId();
    const created = await manager().createSchedule(principal, id, hourly as never);
    await context.database
      .update(chatSchedule)
      .set({ enabled: false, nextRunAt: new Date(Date.now() - 86_400_000), lastOutcome: "DISABLED", lastDetail: "Conversation archived." })
      .where(eq(chatSchedule.id, created.id));

    const resumed = await manager().updateSchedule(principal, created.id, { enabled: true } as never);

    expect(resumed.enabled).toBe(true);
    expect(resumed.lastOutcome).toBeNull();
    expect(resumed.lastDetail).toBeNull();
    expect(new Date(resumed.nextRunAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("leaves the armed time alone when an enabled schedule is edited", async () => {
    const id = await conversationId();
    const created = await manager().createSchedule(principal, id, hourly as never);

    const edited = await manager().updateSchedule(principal, created.id, { prompt: "Different prompt." } as never);

    expect(edited.prompt).toBe("Different prompt.");
    expect(edited.nextRunAt).toBe(created.nextRunAt);
    expect(edited.revision).toBe(created.revision + 1);
  });

  it("deletes a conversation's schedules with it", async () => {
    // The foreign key cascades. Without it a deleted conversation would leave
    // rows the dispatcher still reads and can never satisfy.
    const id = await conversationId();
    await manager().createSchedule(principal, id, hourly as never);

    await manager().delete(principal, id);

    const remaining = await context.database.select().from(chatSchedule);
    expect(remaining).toHaveLength(0);
  });

  it("refuses an interval the database would refuse anyway", async () => {
    // The contract bound and `ChatSchedule_intervalSeconds_check` state the same
    // range. This asserts the database half, so a caller that reaches the
    // manager without the contract cannot write a row the dispatcher would then
    // fire every second.
    const id = await conversationId();

    await expect(manager().createSchedule(principal, id, { ...hourly, intervalSeconds: 30 } as never))
      .rejects.toThrow();
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


describe("DrizzleChatManager event subscription", () => {
  it("waits for the consumer to take one event before producing the next", async () => {
    // Saved events were pushed at the consumer as fast as the database returned
    // them, and a full page sent the loop straight back for another one. The
    // SSE bridge had no way to slow this down, so a subscriber that stopped
    // reading — a resumed run replaying from cursor 0 into a suspended tab —
    // had the whole replay accumulate in this process instead.
    const profileId = await seedActiveProfile();
    const created = await manager().create(principal, { profileId } as never);
    const submission = await manager().submitMessage(principal, created.id, "Replay this");
    await context.database.insert(agentRunEvent).values(
      Array.from({ length: 20 }, (_value, index) => ({
        runId: submission.assistantMessage.agentRunId!,
        type: "MESSAGE_DELTA",
        delta: `token-${index}`,
      })),
    );

    const received: ChatStreamEvent[] = [];
    let release = () => undefined as void;
    const consumed = new Promise<void>((resolve) => { release = resolve; });
    const controller = new AbortController();
    const subscription = manager()
      .subscribe(principal, created.id, submission.assistantMessage.id, null, (event) => {
        received.push(event);
        return consumed;
      }, controller.signal)
      .catch(() => undefined);
    await delay(300);

    const producedWhileBlocked = received.length;
    controller.abort();
    release();
    await subscription;

    // Just the opening `started` frame: everything after it waits its turn.
    expect(producedWhileBlocked).toBe(1);
  });

  it("delivers an event that commits between the drain and the outcome", async () => {
    /*
     * The loop used to drain events, then read the run row in a second
     * statement, and close the stream on a terminal status without looking
     * again. Nothing orders those two statements against a writer, so anything
     * committing between them was delivered to nobody and the turn ended on top
     * of it. It stayed rare only because the loop woke on a timer unrelated to
     * when the worker wrote; the moment anything aligns the two -- a wake
     * channel, a slow query, a loaded host -- it becomes the normal case.
     *
     * `emit` is the injection point because it runs inside the loop, at exactly
     * the spot a concurrent commit would land.
     */
    const profileId = await seedActiveProfile();
    const created = await manager().create(principal, { profileId } as never);
    const submission = await manager().submitMessage(principal, created.id, "Race this");
    const runId = submission.assistantMessage.agentRunId!;
    await context.database.insert(agentRunEvent).values({ runId, type: "MESSAGE_DELTA", delta: "first" });

    let injected = false;
    const received: ChatStreamEvent[] = [];
    await manager().subscribe(principal, created.id, submission.assistantMessage.id, null, async (event) => {
      received.push(event);
      if (event.type !== "delta" || injected) return;
      injected = true;
      // One transaction, the way the finaliser writes it: the trailing event
      // and the outcome become visible at the same instant.
      await context.database.transaction(async (transaction) => {
        await transaction.insert(agentRunEvent).values({ runId, type: "MESSAGE_DELTA", delta: "second" });
        await transaction.update(agentRun)
          .set({ status: "COMPLETED", completedAt: new Date() })
          .where(eq(agentRun.id, runId));
        await transaction.insert(agentRunEvent)
          .values({ runId, type: "RUN_ENDED", status: "COMPLETED", summary: "The run completed." });
      });
    }, new AbortController().signal);

    expect(received.filter((event) => event.type === "delta").map((event) => event.delta)).toEqual(["first", "second"]);
    expect(received.at(-1)?.type).toBe("completed");
  });

  it("ends the stream on the log's marker, not on the run row", async () => {
    /*
     * The two disagree here on purpose. The marker sits in cursor order behind
     * every event this reader has been handed; the run row sits outside that
     * order entirely, so it can only ever be a hint. Whichever one the loop
     * trusts is the difference between a turn that cannot end early and one
     * that can.
     */
    const profileId = await seedActiveProfile();
    const created = await manager().create(principal, { profileId } as never);
    const submission = await manager().submitMessage(principal, created.id, "Answer this");
    const runId = submission.assistantMessage.agentRunId!;
    await context.database.insert(agentRunEvent).values([
      { runId, type: "MESSAGE_DELTA", delta: "answer" },
      { runId, type: "RUN_ENDED", status: "COMPLETED", summary: "The run completed." },
    ]);
    await context.database.update(agentRun)
      .set({ status: "FAILED", failureCode: "SHOULD_NOT_BE_READ", failureMessage: "The run row must lose." })
      .where(eq(agentRun.id, runId));

    const received: ChatStreamEvent[] = [];
    await manager().subscribe(principal, created.id, submission.assistantMessage.id, null, (event) => {
      received.push(event);
    }, new AbortController().signal);

    expect(received.at(-1)?.type).toBe("completed");
    // The marker is what ends the turn, not something the timeline renders: a
    // card reading "the run ended" directly above the answer is noise.
    expect(received.filter((event) => event.type === "activity")).toEqual([]);
  });

  it("holds the read rate to the floor when every wake returns at once", async () => {
    /*
     * The wake makes the read rate follow the write rate rather than a timer,
     * which is the point -- and is also unbounded. This is the one constant
     * standing between a runaway producer and one cursor query per notification,
     * against a pool of ten shared by the whole control plane. It was previously
     * removable with every chat-manager test still green.
     *
     * The margin is deliberately wide: the assertion is "bounded", not "exactly
     * forty a second". Without the floor this figure is in the hundreds.
     */
    const profileId = await seedActiveProfile();
    const created = await manager().create(principal, { profileId } as never);
    const submission = await manager().submitMessage(principal, created.id, "Never ends");
    const wake = relentlessWake();
    const controller = new AbortController();

    const subscription = manager(agents(), wake)
      .subscribe(principal, created.id, submission.assistantMessage.id, null, () => undefined, controller.signal)
      .catch(() => undefined);
    await delay(300);
    controller.abort();
    await subscription;

    expect(wake.passes()).toBeGreaterThan(0);
    expect(wake.passes()).toBeLessThanOrEqual(25);
  });

  it("delivers a frame the worker commits sooner than the poll interval", async () => {
    /*
     * The one test that proves the accelerator is not inert. Everything else
     * about the wake can be green while nothing is ever woken -- which is how
     * the first attempt at this shipped, with the hub optional and its single
     * wiring point uncovered.
     *
     * Timed from the commit, not from subscribe: the loop drains once
     * immediately, so what is being measured is the wait that follows it. Under
     * the poll interval alone this is up to 350 ms; woken, it is the read-rate
     * floor plus a query.
     */
    const profileId = await seedActiveProfile();
    const created = await manager().create(principal, { profileId } as never);
    const submission = await manager().submitMessage(principal, created.id, "Wake me");
    const runId = submission.assistantMessage.agentRunId!;
    const wake = createChatRunWakeHub(context.connectionString);
    const controller = new AbortController();
    try {
      for (let attempt = 0; attempt < 200 && !wake.connected; attempt += 1) await delay(10);
      expect(wake.connected).toBe(true);

      let arrivedAt = 0;
      const subscription = manager(agents(), wake)
        .subscribe(principal, created.id, submission.assistantMessage.id, null, (event) => {
          if (event.type === "delta" && arrivedAt === 0) arrivedAt = Date.now();
        }, controller.signal)
        .catch(() => undefined);
      // Long enough for the first drain to have finished and the loop to be
      // waiting, so the wake is what ends that wait.
      await delay(60);

      const committedAt = Date.now();
      await context.database.transaction(async (transaction) => {
        await transaction.insert(agentRunEvent).values({ runId, type: "MESSAGE_DELTA", delta: "woken" });
        await transaction.execute(chatRunWakeStatement(runId));
      });
      for (let attempt = 0; attempt < 100 && arrivedAt === 0; attempt += 1) await delay(5);
      controller.abort();
      await subscription;

      expect(arrivedAt).toBeGreaterThan(0);
      expect(arrivedAt - committedAt).toBeLessThan(200);
    } finally {
      controller.abort();
      await wake.stop();
    }
  });

  it("releases its wake registration even when the first frame throws", async () => {
    /*
     * The registration is acquired before the first query -- a notification with
     * nothing registered has nothing to latch onto -- which puts it in front of
     * an awaited `emit` that can throw. An SSE socket closing between the route
     * accepting the request and the first write is enough. Registered outside
     * the `try` that closes it, that leaks a watcher for the life of the
     * process, and it leaks one per attempt.
     */
    const profileId = await seedActiveProfile();
    const created = await manager().create(principal, { profileId } as never);
    const submission = await manager().submitMessage(principal, created.id, "Dies on the first frame");
    const wake = createChatRunWakeHub(context.connectionString);
    try {
      await expect(manager(agents(), wake).subscribe(
        principal, created.id, submission.assistantMessage.id, null,
        () => { throw new Error("the socket went away"); },
        new AbortController().signal,
      )).rejects.toThrow("the socket went away");
      expect(wake.size).toBe(0);
    } finally {
      await wake.stop();
    }
  });
});
