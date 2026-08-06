import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  agentProfile,
  agentProfileVersion,
  auditEvent,
  chatConversation,
  chatMessage,
  createTestDatabase,
  memoryPolicy,
  type TestDatabase,
} from "@orcasynapse/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMemoryPort, MemoryDistillerPort } from "./agent-processor.js";
import { SessionMemoryDistiller } from "./session-distiller.js";

/**
 * Capture moved off the per-turn path so extraction sees the whole arc and the
 * model is called once per conversation. These cases guard the two things that
 * make that safe: a session is read once, and a session is never lost.
 */

let context: TestDatabase;
const WORKER = randomUUID();

beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); });
beforeEach(async () => { await context.reset(); });

async function profileFor(
  memoryMode: typeof agentProfileVersion.$inferInsert["memoryMode"] = "LEARN_EXCHANGE",
): Promise<string> {
  const [profile] = await context.database
    .insert(agentProfile)
    .values({ slug: `profile-${randomUUID().slice(0, 8)}`, status: "ACTIVE", activeVersion: 1 })
    .returning({ id: agentProfile.id });
  await context.database.insert(agentProfileVersion).values({
    profileId: profile!.id,
    version: 1,
    displayName: "Analyst v1",
    purpose: "Answer internal policy questions with approved evidence.",
    maxConcurrentRuns: 1,
    instructions: "Answer with approved evidence.",
    soulMd: "You are a careful internal analyst who follows approved evidence.",
    modelAlias: "hermes-agent",
    maxTurns: 1,
    timeoutSeconds: 60,
    safeMode: true,
    memoryMode,
  });
  return profile!.id;
}

/** A conversation whose last message is `idleMinutes` old. */
async function conversationWith(
  turns: Array<{ role: "USER" | "ASSISTANT"; content: string; minutesAgo?: number }>,
  options: { profileId?: string | null; idleMinutes?: number; distilledAt?: Date | null } = {},
): Promise<string> {
  const idleMinutes = options.idleMinutes ?? 30;
  const lastMessageAt = new Date(Date.now() - idleMinutes * 60_000);
  const [conversation] = await context.database
    .insert(chatConversation)
    .values({
      ownerSubject: "user:pilot",
      title: "Pilot chat",
      modelAlias: "hermes-agent",
      profileId: options.profileId === undefined ? await profileFor() : options.profileId,
      lastMessageAt,
      memoryDistilledAt: options.distilledAt ?? null,
    })
    .returning({ id: chatConversation.id });

  for (const [index, turn] of turns.entries()) {
    await context.database.insert(chatMessage).values({
      conversationId: conversation!.id,
      ordinal: index,
      role: turn.role,
      status: "COMPLETED",
      content: turn.content,
      // Explicit ages where a case needs one turn to predate a distillation;
      // otherwise spread backwards from the last message, so order is fixed.
      createdAt: turn.minutesAgo === undefined
        ? new Date(lastMessageAt.getTime() - (turns.length - index) * 1_000)
        : new Date(Date.now() - turn.minutesAgo * 60_000),
    });
  }
  return conversation!.id;
}

function memoryPort(): AgentMemoryPort & { captured: Array<{ content: string }[]> } {
  const captured: Array<{ content: string }[]> = [];
  return {
    captured,
    recall: vi.fn(async () => []),
    profile: vi.fn(async () => []),
    capture: vi.fn(async (
      _owner: string,
      _profile: string,
      items: readonly { content: string }[],
    ) => {
      captured.push(items.map(({ content }) => ({ content })));
      return items.length;
    }),
  };
}

function distillerReturning(
  facts: Array<{ fact: string; scope: "STATIC" | "DYNAMIC" | "EPISODIC"; replaces?: string[] }>,
  succeeded = true,
): MemoryDistillerPort & { turns: Array<Array<{ role: string; content: string }>> } {
  const turns: Array<Array<{ role: string; content: string }>> = [];
  return {
    turns,
    distil: vi.fn(async (given: readonly { role: string; content: string }[]) => {
      turns.push(given.map((turn) => ({ ...turn })));
      return { facts: facts.map((f) => ({ ...f, replaces: f.replaces ?? [] })), succeeded };
    }),
  };
}

async function distilledAtOf(conversationId: string): Promise<Date | null> {
  const [row] = await context.database
    .select({ at: chatConversation.memoryDistilledAt })
    .from(chatConversation)
    .where(eq(chatConversation.id, conversationId));
  return row?.at ?? null;
}

describe("SessionMemoryDistiller", () => {
  it("reads the whole session as one exchange, oldest turn first", async () => {
    // The reason capture moved off the per-turn path: "moving next month" and
    // "the move is done" only resolve into one fact if both are visible.
    const id = await conversationWith([
      { role: "USER", content: "I am moving to Bandung next month." },
      { role: "ASSISTANT", content: "Congratulations." },
      { role: "USER", content: "The move is done, I live there now." },
    ]);
    const distiller = distillerReturning([{ fact: "The user lives in Bandung.", scope: "STATIC" }]);
    const memory = memoryPort();

    const outcome = await new SessionMemoryDistiller(context.database, memory, distiller)
      .distilNext(WORKER);

    expect(outcome).toMatchObject({ conversationId: id, facts: 1 });
    expect(distiller.turns).toHaveLength(1);
    expect(distiller.turns[0]).toEqual([
      { role: "user", content: "I am moving to Bandung next month." },
      { role: "assistant", content: "Congratulations." },
      { role: "user", content: "The move is done, I live there now." },
    ]);
    expect(memory.captured[0]).toEqual([{ content: "The user lives in Bandung." }]);
  });

  it("leaves a conversation alone until it has been quiet long enough", async () => {
    await conversationWith([{ role: "USER", content: "I work in Jakarta." }], { idleMinutes: 1 });
    const distiller = distillerReturning([{ fact: "The user works in Jakarta.", scope: "STATIC" }]);

    await expect(new SessionMemoryDistiller(context.database, memoryPort(), distiller).distilNext(WORKER))
      .resolves.toBeNull();
    expect(distiller.distil).not.toHaveBeenCalled();
  });

  it("does not read the same session twice", async () => {
    const id = await conversationWith([{ role: "USER", content: "I work in Jakarta." }]);
    const distiller = distillerReturning([{ fact: "The user works in Jakarta.", scope: "STATIC" }]);
    const sweep = new SessionMemoryDistiller(context.database, memoryPort(), distiller);

    await sweep.distilNext(WORKER);
    await expect(sweep.distilNext(WORKER)).resolves.toBeNull();
    expect(distiller.distil).toHaveBeenCalledTimes(1);
    expect(await distilledAtOf(id)).not.toBeNull();
  });

  it("reads only the turns spoken since the last distillation", async () => {
    // A conversation that resumes must not re-extract what it already stored,
    // or every fact in the earlier turns arrives a second time.
    const distilledAt = new Date(Date.now() - 20 * 60_000);
    await conversationWith(
      [
        { role: "USER", content: "Old turn, already distilled.", minutesAgo: 40 },
        { role: "USER", content: "New turn, said afterwards.", minutesAgo: 15 },
      ],
      { idleMinutes: 15, distilledAt },
    );
    const distiller = distillerReturning([]);

    await new SessionMemoryDistiller(context.database, memoryPort(), distiller).distilNext(WORKER);

    expect(distiller.turns[0]).toEqual([{ role: "user", content: "New turn, said afterwards." }]);
  });

  it("keeps the session for the next sweep when the model could not be reached", async () => {
    // An unreachable model is transient. Marking the session read would lose
    // everything said in it, permanently and silently.
    const id = await conversationWith([{ role: "USER", content: "I work in Jakarta." }]);
    const failing = distillerReturning([], false);

    const outcome = await new SessionMemoryDistiller(context.database, memoryPort(), failing)
      .distilNext(WORKER);

    expect(outcome).toMatchObject({ facts: 0 });
    expect(await distilledAtOf(id)).toBeNull();
    // And the next sweep picks it up again.
    const retry = distillerReturning([{ fact: "The user works in Jakarta.", scope: "STATIC" }]);
    await expect(new SessionMemoryDistiller(context.database, memoryPort(), retry).distilNext(WORKER))
      .resolves.toMatchObject({ conversationId: id, facts: 1 });
  });

  it("marks a session read before distilling, so a crash cannot loop on it", async () => {
    const id = await conversationWith([{ role: "USER", content: "I work in Jakarta." }]);
    const exploding: MemoryDistillerPort = {
      distil: vi.fn(async () => { throw new Error("inference host went away mid-call"); }),
    };

    const outcome = await new SessionMemoryDistiller(context.database, memoryPort(), exploding)
      .distilNext(WORKER);

    expect(outcome).toMatchObject({ conversationId: id, facts: 0 });
    expect(await distilledAtOf(id)).not.toBeNull();
  });

  it("skips a conversation whose agent does not learn", async () => {
    await conversationWith(
      [{ role: "USER", content: "I work in Jakarta." }],
      { profileId: await profileFor("RECALL_ONLY") },
    );
    const distiller = distillerReturning([{ fact: "The user works in Jakarta.", scope: "STATIC" }]);

    await new SessionMemoryDistiller(context.database, memoryPort(), distiller).distilNext(WORKER);

    expect(distiller.distil).not.toHaveBeenCalled();
  });

  it("honours a policy that caps capture below the agent's own mode", async () => {
    // Read at capture, not at submission, so tightening the policy stops work
    // already waiting in the queue.
    await context.database.insert(memoryPolicy).values({
      slug: "locked-down",
      displayName: "Locked down",
      description: "Recall only while the retention review is open.",
      status: "ACTIVE",
      maximumCaptureMode: "RECALL_ONLY",
      firstActivatedAt: new Date(),
    });
    await conversationWith([{ role: "USER", content: "I work in Jakarta." }]);
    const distiller = distillerReturning([{ fact: "The user works in Jakarta.", scope: "STATIC" }]);

    await new SessionMemoryDistiller(context.database, memoryPort(), distiller).distilNext(WORKER);

    expect(distiller.distil).not.toHaveBeenCalled();
  });

  it("ignores a conversation with no agent profile", async () => {
    await conversationWith([{ role: "USER", content: "I work in Jakarta." }], { profileId: null });
    const distiller = distillerReturning([{ fact: "The user works in Jakarta.", scope: "STATIC" }]);

    await expect(new SessionMemoryDistiller(context.database, memoryPort(), distiller).distilNext(WORKER))
      .resolves.toBeNull();
  });

  it("records one audit for the session, scoped and counted", async () => {
    const id = await conversationWith([{ role: "USER", content: "I moved to Bandung." }]);
    const distiller = distillerReturning([
      { fact: "The user works in Bandung.", scope: "STATIC", replaces: ["11111111-1111-4111-8111-111111111111"] },
    ]);

    await new SessionMemoryDistiller(context.database, memoryPort(), distiller).distilNext(WORKER);

    const [event] = await context.database
      .select({ metadata: auditEvent.metadata, resourceId: auditEvent.resourceId })
      .from(auditEvent)
      .where(and(eq(auditEvent.action, "memory.captured"), eq(auditEvent.resourceId, id)));
    expect(event?.metadata).toMatchObject({
      items: 1, superseded: 1, distilled: true, scope: "SESSION", memoryMode: "LEARN_EXCHANGE",
    });
    // The trail records that memory was written, never what it says.
    expect(JSON.stringify(event?.metadata)).not.toContain("Bandung");
  });

  it("takes the longest-waiting conversation first", async () => {
    const older = await conversationWith([{ role: "USER", content: "I work in Jakarta." }], { idleMinutes: 90 });
    await conversationWith([{ role: "USER", content: "I work in Bandung." }], { idleMinutes: 20 });
    const distiller = distillerReturning([]);

    await expect(new SessionMemoryDistiller(context.database, memoryPort(), distiller).distilNext(WORKER))
      .resolves.toMatchObject({ conversationId: older });
  });

  it("writes nothing when the session taught nothing durable", async () => {
    await conversationWith([{ role: "USER", content: "Hello there!" }]);
    const memory = memoryPort();

    const outcome = await new SessionMemoryDistiller(context.database, memory, distillerReturning([]))
      .distilNext(WORKER);

    expect(outcome).toMatchObject({ facts: 0 });
    expect(memory.capture).not.toHaveBeenCalled();
    expect(await context.database.select().from(auditEvent)).toHaveLength(0);
  });
});
