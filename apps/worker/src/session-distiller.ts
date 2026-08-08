import {
  DEFAULT_MEMORY_POLICY,
  effectiveMemoryMode,
  type AgentMemoryMode,
} from "@orcasynapse/contracts";
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  agentProfile,
  agentProfileVersion,
  auditEvent,
  chatConversation,
  chatMessage,
  memoryPolicy,
  type OrcaSynapseDatabase,
} from "@orcasynapse/database";
import type {
  AgentMemoryPort,
  MemoryDistillerPort,
  MemoryLimits,
} from "./agent-processor.js";

/**
 * Distils a conversation once it goes quiet, rather than once per turn.
 *
 * Two things move at once. Extraction sees the whole arc, so "I am moving to
 * Bandung next month" and a later "the move is done" resolve into one correct
 * fact instead of two that contradict each other. And the model is called once
 * per conversation instead of once per message, which on the pilot's hardware
 * is the difference between 30-70s of work after every answer and 30-70s once.
 *
 * Runs that belong to no conversation still capture at run end: there is no
 * session to wait for, and deferring them would mean never capturing at all.
 */

/**
 * How long a conversation must be quiet before it is read.
 *
 * Long enough that a pause for thought does not split one session into two
 * distillations, short enough that a fact stated now is available within the
 * hour. A conversation resumed after this simply distils again, and the second
 * pass reads only what was said since.
 */
const IDLE_MS = 10 * 60_000;

/** Bounded per tick so one busy installation cannot monopolise the worker. */
const MAXIMUM_TURNS = 40;

// Same values the per-turn path uses; see agent-processor.ts for why the
// supersession floor sits below the recall floor.
const SUPERSESSION_CANDIDATES = 8;
const SUPERSESSION_FLOOR = 0.25;

export interface DistilledSession {
  conversationId: string;
  facts: number;
  superseded: number;
}

export class SessionMemoryDistiller {
  constructor(
    private readonly database: OrcaSynapseDatabase,
    private readonly memory: AgentMemoryPort,
    private readonly distiller: MemoryDistillerPort,
    private readonly idleMs = IDLE_MS,
  ) {}

  /**
   * Distils the single longest-waiting idle conversation, or returns null.
   *
   * One per tick, deliberately: distillation holds an inference connection for
   * up to two minutes, and the worker also embeds documents on the same host.
   */
  /**
   * Distils one named conversation, whatever else is waiting.
   *
   * `distilNext` takes the longest-waiting session, which is right for the
   * worker and wrong for anything that needs a *particular* conversation
   * stored before it can proceed. The quality harness learned this the hard
   * way: draining the queue distilled unrelated sessions first, so a case asked
   * its question 53 seconds before its own fact was written and scored a
   * failure that had nothing to do with memory.
   */
  async distilOne(conversationId: string, workerId: string): Promise<DistilledSession | null> {
    const [candidate] = await this.database
      .select({
        id: chatConversation.id,
        ownerSubject: chatConversation.ownerSubject,
        profileId: chatConversation.profileId,
        distilledAt: chatConversation.memoryDistilledAt,
      })
      .from(chatConversation)
      .where(eq(chatConversation.id, conversationId))
      .limit(1);
    if (!candidate?.profileId) return null;

    await this.database
      .update(chatConversation)
      .set({ memoryDistilledAt: new Date() })
      .where(eq(chatConversation.id, candidate.id));
    try {
      return await this.distilConversation({ ...candidate, profileId: candidate.profileId }, workerId);
    } catch (cause) {
      console.error("OrcaSynapse could not distil conversation", candidate.id, cause);
      return { conversationId: candidate.id, facts: 0, superseded: 0 };
    }
  }

  async distilNext(workerId: string): Promise<DistilledSession | null> {
    const cutoff = new Date(Date.now() - this.idleMs);
    const [candidate] = await this.database
      .select({
        id: chatConversation.id,
        ownerSubject: chatConversation.ownerSubject,
        profileId: chatConversation.profileId,
        distilledAt: chatConversation.memoryDistilledAt,
      })
      .from(chatConversation)
      .where(and(
        lt(chatConversation.lastMessageAt, cutoff),
        or(
          isNull(chatConversation.memoryDistilledAt),
          lt(chatConversation.memoryDistilledAt, chatConversation.lastMessageAt),
        ),
        sql`${chatConversation.profileId} IS NOT NULL`,
      ))
      .orderBy(asc(chatConversation.lastMessageAt))
      .limit(1);
    if (!candidate?.profileId) return null;

    // Stamped before the work, not after. A distillation that crashes must not
    // leave the conversation to be retried forever, and re-reading turns that
    // were already distilled would duplicate every fact in them.
    await this.database
      .update(chatConversation)
      .set({ memoryDistilledAt: new Date() })
      .where(eq(chatConversation.id, candidate.id));

    try {
      return await this.distilConversation(
        { ...candidate, profileId: candidate.profileId },
        workerId,
      );
    } catch (cause) {
      console.error("OrcaSynapse could not distil conversation", candidate.id, cause);
      return { conversationId: candidate.id, facts: 0, superseded: 0 };
    }
  }

  private async distilConversation(
    conversation: { id: string; ownerSubject: string; profileId: string; distilledAt: Date | null },
    workerId: string,
  ): Promise<DistilledSession | null> {
    const empty = { conversationId: conversation.id, facts: 0, superseded: 0 };
    const { limits, ceiling, distil } = await this.policy();
    if (!distil) return empty;

    const mode = await this.captureMode(conversation.profileId, ceiling);
    if (mode !== "LEARN_USER" && mode !== "LEARN_EXCHANGE") return empty;

    const turns = await this.turnsSince(conversation.id, conversation.distilledAt);
    if (!turns.some((turn) => turn.role === "user")) return empty;

    const [candidates, profile] = await Promise.all([
      // The last user turn is the query: a correction lives at the end of a
      // session, so that is what the retired fact most likely resembles.
      this.memory.recall(
        conversation.ownerSubject,
        conversation.profileId,
        [...turns].reverse().find((turn) => turn.role === "user")?.content ?? "",
        { ...limits, recallLimit: SUPERSESSION_CANDIDATES, recallMinimumScore: SUPERSESSION_FLOOR },
      ),
      this.memory.profile(conversation.ownerSubject, conversation.profileId),
    ]);
    const known = new Map<string, string>();
    for (const fact of [...profile, ...candidates]) known.set(fact.id, fact.content);

    // LEARN_USER means the model's own output is not memory material. `mode`
    // gated entry to this method but nothing filtered the turns afterwards, so
    // the session sweep distilled assistant answers under the mode that
    // promises it will not — the same defect the per-turn path had.
    const offered = mode === "LEARN_EXCHANGE" ? turns : turns.filter((turn) => turn.role === "user");
    const extraction = await this.distiller.distil(
      offered,
      [...known].map(([id, content]) => ({ id, content })),
    );
    if (!extraction.succeeded) {
      // Rewound so the next sweep tries again: an unreachable model is a
      // transient failure, and marking the session read would lose the session.
      await this.database
        .update(chatConversation)
        .set({ memoryDistilledAt: conversation.distilledAt })
        .where(eq(chatConversation.id, conversation.id));
      console.error("OrcaSynapse could not distil session for conversation", conversation.id);
      return empty;
    }
    if (extraction.facts.length === 0) return empty;

    const items = extraction.facts.map(({ fact, scope, replaces }) => ({
      content: fact,
      scope,
      replaces,
    }));
    const stored = await this.memory.capture(
      conversation.ownerSubject,
      conversation.profileId,
      items,
      { runId: conversation.id, conversationId: conversation.id },
      limits,
    );
    if (stored === 0) return empty;

    const superseded = items.reduce((total, item) => total + item.replaces.length, 0);
    await this.database.insert(auditEvent).values({
      actorType: "SERVICE",
      actorId: workerId,
      action: "memory.captured",
      resourceType: "ChatConversation",
      resourceId: conversation.id,
      outcome: "SUCCESS",
      // Counts and mode only, matching the per-turn trail: it records that
      // memory was written, never what it says about the person.
      metadata: {
        items: stored,
        memoryMode: mode,
        profileId: conversation.profileId,
        distilled: true,
        superseded,
        scope: "SESSION",
      },
    });
    return { conversationId: conversation.id, facts: stored, superseded };
  }

  /** The turns spoken since the last distillation, oldest first. */
  private async turnsSince(
    conversationId: string,
    since: Date | null,
  ): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
    const rows = await this.database
      .select({
        role: chatMessage.role,
        content: chatMessage.content,
        createdAt: chatMessage.createdAt,
      })
      .from(chatMessage)
      .where(and(
        eq(chatMessage.conversationId, conversationId),
        eq(chatMessage.status, "COMPLETED"),
        inArray(chatMessage.role, ["USER", "ASSISTANT"]),
        ...(since ? [sql`${chatMessage.createdAt} > ${since}`] : []),
      ))
      // createdAt cannot separate a turn from its answer. The USER row and the
      // ASSISTANT row are written by one statement inside one transaction, so
      // both take the same CURRENT_TIMESTAMP, and a fork copies a whole
      // conversation in one statement so every row in it ties. Ordering by that
      // alone leaves the pair wherever the plan happened to put it: an index
      // scan returns them in heap order and looks right, while the sort the
      // planner picks once the table has statistics does not. Read backwards,
      // the exchange teaches the model that the assistant asked the questions.
      // ordinal is what records who spoke first, and it is unique per
      // conversation, so it settles every tie.
      .orderBy(desc(chatMessage.createdAt), desc(chatMessage.ordinal))
      .limit(MAXIMUM_TURNS);
    return rows
      .reverse()
      .map((row) => ({
        role: row.role === "USER" ? ("user" as const) : ("assistant" as const),
        content: row.content,
      }))
      .filter((turn) => turn.content.trim().length > 0);
  }

  /** The mode frozen on the profile's active version, capped by the policy. */
  private async captureMode(
    profileId: string,
    ceiling: AgentMemoryMode | null,
  ): Promise<AgentMemoryMode> {
    const [version] = await this.database
      .select({ memoryMode: agentProfileVersion.memoryMode })
      .from(agentProfile)
      .innerJoin(agentProfileVersion, and(
        eq(agentProfileVersion.profileId, agentProfile.id),
        eq(agentProfileVersion.version, agentProfile.activeVersion),
      ))
      .where(eq(agentProfile.id, profileId))
      .limit(1);
    return effectiveMemoryMode(version?.memoryMode ?? "DOCUMENTS_ONLY", ceiling);
  }

  /**
   * The active policy, read now rather than when the conversation started.
   *
   * A session distilled an hour after its last message must honour the boundary
   * in force at capture, so suspending the policy stops work already waiting.
   */
  private async policy(): Promise<{
    limits: MemoryLimits;
    ceiling: AgentMemoryMode | null;
    distil: boolean;
  }> {
    const [policy] = await this.database
      .select({
        mode: memoryPolicy.maximumCaptureMode,
        retentionDays: memoryPolicy.retentionDays,
        maximumItemsPerOwner: memoryPolicy.maximumItemsPerOwner,
        recallLimit: memoryPolicy.recallLimit,
        recallMinimumScore: memoryPolicy.recallMinimumScore,
        distillCapture: memoryPolicy.distillCapture,
      })
      .from(memoryPolicy)
      .where(eq(memoryPolicy.status, "ACTIVE"))
      .limit(1);
    if (!policy) {
      return {
        ceiling: null,
        distil: DEFAULT_MEMORY_POLICY.distillCapture,
        limits: {
          recallLimit: DEFAULT_MEMORY_POLICY.recallLimit,
          recallMinimumScore: DEFAULT_MEMORY_POLICY.recallMinimumScore,
          retentionDays: DEFAULT_MEMORY_POLICY.retentionDays,
          maximumItemsPerOwner: DEFAULT_MEMORY_POLICY.maximumItemsPerOwner,
        },
      };
    }
    return {
      ceiling: policy.mode,
      distil: policy.distillCapture,
      limits: {
        recallLimit: policy.recallLimit,
        recallMinimumScore: policy.recallMinimumScore,
        retentionDays: policy.retentionDays,
        maximumItemsPerOwner: policy.maximumItemsPerOwner,
      },
    };
  }
}
