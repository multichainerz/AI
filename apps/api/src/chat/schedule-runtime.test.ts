import { randomUUID } from "node:crypto";
import {
  agentProfile,
  agentProfileVersion,
  agentRun,
  auditEvent,
  chatConversation,
  chatMessage,
  chatSchedule,
  createTestDatabase,
  division,
  enterpriseUser,
  localAdministrator,
  NO_CHAT_RUN_WAKE,
  type TestDatabase,
} from "@orcasynapse/database";
import { asc, eq } from "drizzle-orm";
import type { AgentManager } from "../agents/agent-manager.js";
import { DrizzleChatManager } from "./drizzle-chat-manager.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChatConversationArchivedError,
  ChatConversationConflictError,
  ChatPolicyViolationError,
  ChatRateLimitError,
  type ChatManager,
  type ChatPrincipal,
} from "./chat-manager.js";
import { ScheduleRuntime } from "./schedule-runtime.js";

let context: TestDatabase;

beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); }, 120_000);
beforeEach(async () => { await context.reset(); });

const logger = { info: () => undefined, error: () => undefined };

/** Only `submitMessage` is reached; the rest of the interface is never called. */
function chat(submitMessage = vi.fn(async () => ({}))) {
  return { submitMessage } as unknown as ChatManager & { submitMessage: typeof submitMessage };
}

async function seedAdministrator(role: "PLATFORM_ADMIN" | "AUDITOR" = "PLATFORM_ADMIN") {
  const [row] = await context.database
    .insert(localAdministrator)
    .values({
      username: `admin-${randomUUID().slice(0, 8)}`,
      displayName: "Operator",
      passwordHash: "x",
      role,
      passwordChangeRequired: false,
    })
    .returning({ id: localAdministrator.id });
  return row!.id;
}

async function seedConversation() {
  const [profile] = await context.database
    .insert(agentProfile)
    .values({ slug: `agent-${randomUUID().slice(0, 8)}`, status: "ACTIVE", currentVersion: 1, activeVersion: 1 })
    .returning({ id: agentProfile.id });
  await context.database.insert(agentProfileVersion).values({
    profileId: profile!.id, version: 1, displayName: "Support agent", purpose: "Answer questions.",
    instructions: "Answer precisely.", soulMd: "Careful assistant.",
    modelAlias: "hermes-agent", maxTurns: 1, timeoutSeconds: 120, maxConcurrentRuns: 1,
  });
  const [conversation] = await context.database
    .insert(chatConversation)
    .values({
      ownerSubject: "local-admin:operator",
      title: "Morning report",
      modelAlias: "hermes-agent",
      profileId: profile!.id,
      profileName: "Support agent",
    })
    .returning({ id: chatConversation.id });
  return conversation!.id;
}

async function seedSchedule(overrides: Record<string, unknown> = {}) {
  const conversationId = await seedConversation();
  const createdBy = await seedAdministrator();
  const [row] = await context.database
    .insert(chatSchedule)
    .values({
      conversationId,
      prompt: "Summarise overnight incidents.",
      intervalSeconds: 3_600,
      // Due a minute ago, so one cycle claims it.
      nextRunAt: new Date(Date.now() - 60_000),
      createdBy,
      createdBySubject: "local-admin:operator",
      createdByMode: "ADMINISTRATOR_PREVIEW",
      ...overrides,
    })
    .returning();
  return row!;
}

async function reload(id: string) {
  const [row] = await context.database.select().from(chatSchedule).where(eq(chatSchedule.id, id));
  return row!;
}

describe("ScheduleRuntime firing", () => {
  it("submits the prompt as an ordinary message and re-arms", async () => {
    const schedule = await seedSchedule();
    const manager = chat();

    const fired = await new ScheduleRuntime(context.database, manager, logger).runCycle();

    expect(fired).toBe(1);
    expect(manager.submitMessage).toHaveBeenCalledTimes(1);
    const [principal, conversationId, prompt] = manager.submitMessage.mock.calls[0] as unknown as [ChatPrincipal, string, string];
    expect(conversationId).toBe(schedule.conversationId);
    expect(prompt).toBe("Summarise overnight incidents.");
    expect(principal.subject).toBe("local-admin:operator");

    const after = await reload(schedule.id);
    expect(after.lastOutcome).toBe("OK");
    expect(after.enabled).toBe(true);
    expect(after.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    expect((await context.database.select().from(auditEvent)).map(({ action }) => action))
      .toEqual(["chat.schedule_fired"]);
  });

  it("claims a due schedule exactly once even when two cycles overlap", async () => {
    /*
     * The whole reason a claim is a conditional UPDATE rather than a read.
     * Two API replicas both reading a row as due would both post a message into
     * somebody's thread, and a duplicate turn is not a survivable duplicate the
     * way a duplicate health probe is.
     */
    const schedule = await seedSchedule();
    const manager = chat();
    const runtime = () => new ScheduleRuntime(context.database, manager, logger);

    await Promise.all([runtime().runCycle(), runtime().runCycle()]);

    expect(manager.submitMessage).toHaveBeenCalledTimes(1);
    expect((await reload(schedule.id)).lastOutcome).toBe("OK");
  });

  it("re-arms from now rather than replaying every window it missed", async () => {
    // A deployment down for a day would otherwise come back and fire ninety-six
    // hourly turns in a burst: a stampede of model calls, and a wall of
    // identical messages for whoever opens the thread.
    const schedule = await seedSchedule({ nextRunAt: new Date(Date.now() - 86_400_000) });
    const manager = chat();

    const fired = await new ScheduleRuntime(context.database, manager, logger).runCycle();

    expect(fired).toBe(1);
    expect(manager.submitMessage).toHaveBeenCalledTimes(1);
    const after = await reload(schedule.id);
    expect(after.nextRunAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("leaves a schedule that is not due yet alone", async () => {
    const schedule = await seedSchedule({ nextRunAt: new Date(Date.now() + 3_600_000) });
    const manager = chat();

    expect(await new ScheduleRuntime(context.database, manager, logger).runCycle()).toBe(0);
    expect(manager.submitMessage).not.toHaveBeenCalled();
    expect((await reload(schedule.id)).lastOutcome).toBeNull();
  });

  it("ignores a disabled schedule however overdue it is", async () => {
    const schedule = await seedSchedule({ enabled: false, nextRunAt: new Date(Date.now() - 86_400_000) });
    const manager = chat();

    expect(await new ScheduleRuntime(context.database, manager, logger).runCycle()).toBe(0);
    expect((await reload(schedule.id)).lastOutcome).toBeNull();
  });
});

describe("ScheduleRuntime refusals", () => {
  it("stays armed when the fire was only rate limited", async () => {
    // A moment, not a property of the schedule. The next tick may well succeed.
    const schedule = await seedSchedule();
    const manager = chat(vi.fn(async () => { throw new ChatRateLimitError(); }));

    await new ScheduleRuntime(context.database, manager, logger).runCycle();

    const after = await reload(schedule.id);
    expect(after.lastOutcome).toBe("SKIPPED");
    expect(after.enabled).toBe(true);
    expect(await context.database.select().from(auditEvent)).toHaveLength(0);
  });

  it("disables itself when the refusal would repeat identically forever", async () => {
    const schedule = await seedSchedule();
    const manager = chat(vi.fn(async () => { throw new ChatPolicyViolationError("Blocked by rule 'Internal codename'."); }));

    await new ScheduleRuntime(context.database, manager, logger).runCycle();

    const after = await reload(schedule.id);
    expect(after.lastOutcome).toBe("DISABLED");
    expect(after.enabled).toBe(false);
    expect(after.lastDetail).toMatch(/Internal codename/);
    expect((await context.database.select().from(auditEvent)).map(({ action }) => action))
      .toEqual(["chat.schedule_disabled"]);
  });

  it("disables itself on an archived conversation", async () => {
    // Archiving is a decision somebody made, and it does not undo itself. This
    // is the only conflict that is permanent, which is why it has its own class.
    const schedule = await seedSchedule();
    const manager = chat(vi.fn(async () => {
      throw new ChatConversationArchivedError("Archived conversations cannot accept new messages.");
    }));

    await new ScheduleRuntime(context.database, manager, logger).runCycle();

    expect((await reload(schedule.id)).enabled).toBe(false);
  });

  it("stays armed when the previous fire's run is still in progress", async () => {
    /*
     * The case that made the feature stop itself. A tool-using turn that outlives
     * its interval, a person typing in the thread, or two catch-up schedules
     * claimed in the same pass after a restart all raise a conflict -- and every
     * one of them clears on its own. Disabling meant the morning report stopped
     * because it was briefly busy, and only a human clicking Resume brought it
     * back.
     */
    const schedule = await seedSchedule();
    const manager = chat(vi.fn(async () => {
      throw new ChatConversationConflictError("This conversation already has a Hermes run in progress.");
    }));

    await new ScheduleRuntime(context.database, manager, logger).runCycle();

    const after = await reload(schedule.id);
    expect(after.lastOutcome).toBe("SKIPPED");
    expect(after.enabled).toBe(true);
    expect(after.lastDetail).toMatch(/run in progress/);
  });

  it("stays armed when another message was submitted at the same time", async () => {
    // The second of the three racing conflicts, and the one that is genuinely a
    // lost race rather than a busy conversation.
    const schedule = await seedSchedule();
    const manager = chat(vi.fn(async () => {
      throw new ChatConversationConflictError("Another message was submitted at the same time.");
    }));

    await new ScheduleRuntime(context.database, manager, logger).runCycle();

    expect((await reload(schedule.id)).enabled).toBe(true);
  });

  it("stays armed on an unrecognised failure", async () => {
    /*
     * Disabling on a database blip would turn one transient outage into every
     * schedule in the deployment needing an operator to switch it back on.
     */
    const schedule = await seedSchedule();
    const manager = chat(vi.fn(async () => { throw new Error("connection terminated unexpectedly"); }));

    await new ScheduleRuntime(context.database, manager, logger).runCycle();

    const after = await reload(schedule.id);
    expect(after.lastOutcome).toBe("SKIPPED");
    expect(after.enabled).toBe(true);
  });

  it("keeps firing the rest of the batch after one schedule refuses", async () => {
    const failing = await seedSchedule();
    const healthy = await seedSchedule();
    let call = 0;
    const manager = chat(vi.fn(async () => {
      call += 1;
      if (call === 1) throw new ChatRateLimitError();
      return {};
    }));

    const fired = await new ScheduleRuntime(context.database, manager, logger).runCycle();

    expect(fired).toBe(2);
    const outcomes = [(await reload(failing.id)).lastOutcome, (await reload(healthy.id)).lastOutcome];
    expect(outcomes.sort()).toEqual(["OK", "SKIPPED"]);
  });
});

describe("ScheduleRuntime end to end", () => {
  /*
   * The claim the other cases in this file do not make.
   *
   * Everywhere above, `submitMessage` is a mock -- which proves the dispatcher
   * calls it and how it reacts, and proves nothing about a turn actually
   * appearing in a conversation. This drives the real `DrizzleChatManager`, so
   * what is asserted is the row a person would see in the thread.
   *
   * Hermes is the only stub left, for the same reason the chat manager's own
   * suite stubs it: the agent manager is a separate, already-converted seam.
   */
  it("puts the prompt and a pending answer in the thread, as an ordinary turn", async () => {
    const schedule = await seedSchedule();
    const agents = {
      submitRun: vi.fn(async () => {
        const [profile] = await context.database.select().from(agentProfile).limit(1);
        const [version] = await context.database.select().from(agentProfileVersion).limit(1);
        const [run] = await context.database
          .insert(agentRun)
          .values({
            profileId: profile!.id, profileVersionId: version!.id, profileVersion: 1,
            ownerSubject: "local-admin:operator", requestedBy: randomUUID(),
            sessionId: randomUUID(), input: "Summarise overnight incidents.",
            outputCharacterLimit: 200_000, modelAlias: "hermes-agent",
            jobId: randomUUID(), status: "QUEUED",
          })
          .returning({ id: agentRun.id });
        return { id: run!.id, profileId: profile!.id, profileVersion: 1 };
      }),
      cancelRun: vi.fn(async () => undefined),
    } as unknown as AgentManager;
    const chatManager = new DrizzleChatManager(
      context.database,
      agents,
      NO_CHAT_RUN_WAKE,
      { forkSession: vi.fn(async () => "forked" as const), deleteSession: vi.fn(async () => undefined) },
    );

    await new ScheduleRuntime(context.database, chatManager, logger).runCycle();

    const messages = await context.database
      .select()
      .from(chatMessage)
      .where(eq(chatMessage.conversationId, schedule.conversationId))
      .orderBy(asc(chatMessage.ordinal));

    // The prompt is stored as a USER turn -- indistinguishable from a typed one,
    // which is the whole design -- and the assistant row is PENDING because the
    // worker has not answered yet.
    expect(messages.map(({ role, content }) => ({ role, content }))).toEqual([
      { role: "USER", content: "Summarise overnight incidents." },
      { role: "ASSISTANT", content: "" },
    ]);
    expect(messages[1]!.status).toBe("PENDING");
    // And a run exists for the worker to claim, which is what makes the answer
    // arrive at all.
    expect(messages[1]!.agentRunId).not.toBeNull();
    expect(agents.submitRun).toHaveBeenCalledTimes(1);
    expect((await reload(schedule.id)).lastOutcome).toBe("OK");
  });
});

describe("ScheduleRuntime authority", () => {
  /*
   * A schedule is a standing grant of one person's authority, and the principal
   * is rebuilt on every fire rather than stored. A stored one would be a frozen
   * grant: the schedule would go on firing with the scopes and division its
   * creator had the day they made it, for as long as the row existed.
   */
  it("stops firing when the creator is disabled, and says why", async () => {
    const schedule = await seedSchedule();
    const manager = chat();
    await context.database
      .update(localAdministrator)
      .set({ disabledAt: new Date() })
      .where(eq(localAdministrator.id, schedule.createdBy!));

    await new ScheduleRuntime(context.database, manager, logger).runCycle();

    expect(manager.submitMessage).not.toHaveBeenCalled();
    const after = await reload(schedule.id);
    expect(after.enabled).toBe(false);
    expect(after.lastOutcome).toBe("DISABLED");
    // The reason has to name the person: "disabled" alone leaves an operator
    // guessing which of the three refusals stopped it.
    expect(after.lastDetail).toMatch(/local-admin:operator can no longer start conversations/);
  });

  it("stops firing when the creator's role no longer carries chat:use", async () => {
    const schedule = await seedSchedule();
    const manager = chat();
    await context.database
      .update(localAdministrator)
      .set({ role: "AUDITOR" })
      .where(eq(localAdministrator.id, schedule.createdBy!));

    await new ScheduleRuntime(context.database, manager, logger).runCycle();

    expect(manager.submitMessage).not.toHaveBeenCalled();
    expect((await reload(schedule.id)).enabled).toBe(false);
  });

  it("rebuilds an enterprise creator with the division it has now", async () => {
    const conversationId = await seedConversation();
    const [group] = await context.database
      .insert(division)
      .values({ slug: `division-${randomUUID().slice(0, 8)}`, displayName: "Operations" })
      .returning({ id: division.id });
    const divisionId = group!.id;
    const [person] = await context.database
      .insert(enterpriseUser)
      .values({
        issuer: "https://idp.example.internal",
        subject: "person@example.internal",
        displayName: "Scheduled reporter",
        enabled: true,
      })
      .returning({ id: enterpriseUser.id });
    const [schedule] = await context.database
      .insert(chatSchedule)
      .values({
        conversationId,
        prompt: "Daily summary.",
        intervalSeconds: 86_400,
        nextRunAt: new Date(Date.now() - 60_000),
        createdBy: person!.id,
        createdBySubject: "person@example.internal",
        createdByMode: "ENTERPRISE",
      })
      .returning();
    const manager = chat();

    await new ScheduleRuntime(context.database, manager, logger).runCycle();

    const [principal] = manager.submitMessage.mock.calls[0] as unknown as [ChatPrincipal];
    expect(principal.identityMode).toBe("ENTERPRISE");
    expect(principal.scopes).toEqual(["chat:use", "agents:use"]);
    expect(principal.divisionId).toBeNull();

    // Moving the person into a division must move their scheduled turns with
    // them, which is the whole reason the principal is re-read.
    await context.database.update(chatSchedule)
      .set({ nextRunAt: new Date(Date.now() - 60_000) })
      .where(eq(chatSchedule.id, schedule!.id));
    await context.database.update(enterpriseUser).set({ divisionId }).where(eq(enterpriseUser.id, person!.id));

    await new ScheduleRuntime(context.database, manager, logger).runCycle();

    const [second] = manager.submitMessage.mock.calls[1] as unknown as [ChatPrincipal];
    expect(second.divisionId).toBe(divisionId);
  });

  it("refuses a mode this release does not recognise rather than guessing", async () => {
    // Firing would mean guessing what somebody is allowed to do.
    const schedule = await seedSchedule({ createdByMode: "SOMETHING_ELSE" });
    const manager = chat();

    await new ScheduleRuntime(context.database, manager, logger).runCycle();

    expect(manager.submitMessage).not.toHaveBeenCalled();
    expect((await reload(schedule.id)).enabled).toBe(false);
  });
});
