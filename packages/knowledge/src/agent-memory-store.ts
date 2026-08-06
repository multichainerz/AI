import { and, cosineDistance, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { MemoryProfileScope } from "@orcasynapse/contracts";
import { agentMemory, type OrcaSynapseDatabase } from "@orcasynapse/database";

/**
 * Where a new fact sits in the chain of corrections that produced it.
 *
 * Only set for a fact that retires another. A fact starting its own chain keeps
 * the column defaults — version 1, no parent, and a null root meaning "this row
 * is the origin" — so an origin never has to be updated to point at itself.
 */
interface MemoryLineage {
  version: number;
  parentMemoryId: string;
  rootMemoryId: string;
}

export interface RememberedItem {
  content: string;
  embedding: number[];
  /** How long the fact stays useful; decides whether it is always injected. */
  scope?: MemoryProfileScope;
  /** Ids of facts this one makes untrue; superseded in the same transaction. */
  replaces?: readonly string[];
}

export interface MemoryProvenance {
  runId?: string | undefined;
  conversationId?: string | undefined;
  /** Absolute expiry stamped at capture. Null keeps the item until deleted. */
  retentionUntil?: Date | null | undefined;
}

export interface MemoryHit {
  id: string;
  content: string;
  score: number;
  createdAt: Date;
}

export interface MemorySearchOptions {
  limit: number;
  /** Cosine floor. Below this a recalled item is noise, and injecting it spends
   *  prompt budget while making the agent look like it misremembers. */
  minimumScore: number;
}

export const DEFAULT_MEMORY_SEARCH_OPTIONS: MemorySearchOptions = { limit: 6, minimumScore: 0.4 };

/**
 * What an agent remembers, scoped to (owner, agent) inside every statement.
 *
 * This deliberately mirrors DocumentVectorStore: the scope is a predicate in
 * the query rather than a namespace handed to a service, so no argument a
 * caller supplies can widen it. Recall is stricter than document retrieval by
 * default because a wrong memory is worse than a missing one - it is asserted
 * about the person rather than quoted from a source they can check.
 */
export class AgentMemoryStore {
  constructor(
    private readonly database: OrcaSynapseDatabase,
    private readonly embeddingModel: string,
  ) {}

  async remember(
    ownerSubject: string,
    agentProfileId: string,
    items: readonly RememberedItem[],
    provenance: MemoryProvenance = {},
  ): Promise<number> {
    if (items.length === 0) return 0;
    // One transaction: a reader must never see both the old fact and its
    // replacement as current, nor lose the old one without the new one landing.
    return this.database.transaction(async (transaction) => {
      const lineage = new Map<number, MemoryLineage>();
      for (const [index, item] of items.entries()) {
        const replaces = (item.replaces ?? []).filter((id) => id.length > 0);
        if (replaces.length === 0) continue;
        // Read before writing: the new row's place in the chain is derived from
        // what it retires, and after the update those rows are no longer latest.
        const retired = await transaction
          .select({ id: agentMemory.id, version: agentMemory.version, root: agentMemory.rootMemoryId })
          .from(agentMemory)
          .where(and(
            eq(agentMemory.ownerSubject, ownerSubject),
            eq(agentMemory.agentProfileId, agentProfileId),
            inArray(agentMemory.id, [...replaces]),
            eq(agentMemory.isLatest, true),
          ))
          .orderBy(desc(agentMemory.version));
        const head = retired[0];
        if (!head) continue;
        await transaction
          .update(agentMemory)
          .set({
            isLatest: false,
            supersededAt: new Date(),
            supersededReason: `Superseded by a later statement: ${item.content}`.slice(0, 300),
          })
          .where(and(
            eq(agentMemory.ownerSubject, ownerSubject),
            eq(agentMemory.agentProfileId, agentProfileId),
            inArray(agentMemory.id, retired.map((row) => row.id)),
          ));
        // When one fact retires several, the longest-lived chain wins the link:
        // its root is the origin a reader following parents would arrive at.
        lineage.set(index, {
          version: head.version + 1,
          parentMemoryId: head.id,
          rootMemoryId: head.root ?? head.id,
        });
      }
      return this.insertFacts(transaction, ownerSubject, agentProfileId, items, provenance, lineage);
    });
  }

  private async insertFacts(
    executor: OrcaSynapseDatabase | Parameters<Parameters<OrcaSynapseDatabase["transaction"]>[0]>[0],
    ownerSubject: string,
    agentProfileId: string,
    items: readonly RememberedItem[],
    provenance: MemoryProvenance,
    lineage: ReadonlyMap<number, MemoryLineage> = new Map(),
  ): Promise<number> {
    await executor.insert(agentMemory).values(
      items.map((item, index) => ({
        ownerSubject,
        agentProfileId,
        content: item.content,
        // Absent for a fact that starts its own chain: version 1, no parent, and
        // a null root that means "this row is the origin".
        ...lineage.get(index),
        characterCount: item.content.length,
        profileScope: item.scope ?? "EPISODIC",
        embeddingModel: this.embeddingModel,
        embedding: item.embedding,
        sourceRunId: provenance.runId ?? null,
        sourceConversationId: provenance.conversationId ?? null,
        retentionUntil: provenance.retentionUntil ?? null,
      })),
    );
    return items.length;
  }

  /**
   * Hybrid recall: cosine similarity fused with a lexical rank over the same
   * item, matching the document path so non-English recall does not depend on
   * one embedding model alone.
   */
  async recall(
    ownerSubject: string,
    agentProfileId: string,
    query: string,
    queryEmbedding: number[],
    options: MemorySearchOptions = DEFAULT_MEMORY_SEARCH_OPTIONS,
  ): Promise<MemoryHit[]> {
    const similarity = sql<number>`1 - (${cosineDistance(agentMemory.embedding, queryEmbedding)})`;
    const lexical = sql<number>`ts_rank_cd(to_tsvector('simple', ${agentMemory.content}), plainto_tsquery('simple', ${query}))`;
    const fused = sql<number>`(${similarity}) + (0.15 * least(${lexical}, 1.0))`;

    const rows = await this.database
      .select({
        id: agentMemory.id,
        content: agentMemory.content,
        createdAt: agentMemory.createdAt,
        score: fused,
      })
      .from(agentMemory)
      .where(
        and(
          eq(agentMemory.ownerSubject, ownerSubject),
          eq(agentMemory.agentProfileId, agentProfileId),
          gt(similarity, options.minimumScore),
          // A retired fact stays for audit but must never be recalled: the
          // whole point of superseding is that the agent stops asserting it.
          eq(agentMemory.isLatest, true),
          this.unexpired(),
        ),
      )
      .orderBy(desc(fused))
      .limit(options.limit);

    return rows.map((row) => ({
      id: row.id,
      content: row.content,
      createdAt: row.createdAt,
      score: Number(row.score),
    }));
  }

  /** Newest first, for an owner reviewing what an agent has learned. */
  /**
   * The facts that must be present regardless of what was asked.
   *
   * Deliberately not a similarity search. A language preference has nothing in
   * common, vector-wise, with "what should I prepare for the event?", so recall
   * would never surface it however the floor is tuned — and facts like that are
   * exactly the ones meant to colour every answer. Ordering puts STATIC first
   * and then the most recent, so a hard cap trims current detail rather than
   * the standing facts.
   */
  async profile(
    ownerSubject: string,
    agentProfileId: string,
    limit = 10,
  ): Promise<Array<{ id: string; content: string; scope: MemoryProfileScope }>> {
    const rows = await this.database
      .select({ id: agentMemory.id, content: agentMemory.content, scope: agentMemory.profileScope })
      .from(agentMemory)
      .where(and(
        eq(agentMemory.ownerSubject, ownerSubject),
        eq(agentMemory.agentProfileId, agentProfileId),
        inArray(agentMemory.profileScope, ["STATIC", "DYNAMIC"]),
        eq(agentMemory.isLatest, true),
        this.unexpired(),
      ))
      .orderBy(sql`CASE WHEN ${agentMemory.profileScope} = 'STATIC' THEN 0 ELSE 1 END`, desc(agentMemory.createdAt))
      .limit(limit);
    return rows;
  }

  async list(ownerSubject: string, agentProfileId: string, limit = 100): Promise<MemoryHit[]> {
    const rows = await this.database
      .select({ id: agentMemory.id, content: agentMemory.content, createdAt: agentMemory.createdAt })
      .from(agentMemory)
      .where(and(
        eq(agentMemory.ownerSubject, ownerSubject),
        eq(agentMemory.agentProfileId, agentProfileId),
        this.unexpired(),
      ))
      .orderBy(desc(agentMemory.createdAt))
      .limit(limit);
    return rows.map((row) => ({ ...row, score: 0 }));
  }

  /**
   * Deletes one item, but only within the caller's own scope. The owner
   * predicate is part of the statement so a stray id cannot reach another
   * person's memory; the return value reports whether anything matched.
   */
  async forget(ownerSubject: string, memoryId: string): Promise<boolean> {
    const removed = await this.database
      .delete(agentMemory)
      .where(and(eq(agentMemory.id, memoryId), eq(agentMemory.ownerSubject, ownerSubject)))
      .returning({ id: agentMemory.id });
    return removed.length === 1;
  }

  /** Forgets everything for one owner, optionally narrowed to one agent. */
  async purge(ownerSubject: string, agentProfileId?: string): Promise<number> {
    const removed = await this.database
      .delete(agentMemory)
      .where(and(
        eq(agentMemory.ownerSubject, ownerSubject),
        ...(agentProfileId ? [eq(agentMemory.agentProfileId, agentProfileId)] : []),
      ))
      .returning({ id: agentMemory.id });
    return removed.length;
  }

  async countFor(ownerSubject: string, agentProfileId: string): Promise<number> {
    const [row] = await this.database
      .select({ total: sql<number>`count(*)::int` })
      .from(agentMemory)
      .where(and(
        eq(agentMemory.ownerSubject, ownerSubject),
        eq(agentMemory.agentProfileId, agentProfileId),
      ));
    return row?.total ?? 0;
  }

  /**
   * Drops expired items and trims the oldest beyond the cap.
   *
   * Pruning happens on write rather than on a timer, which is how this codebase
   * keeps other append-only tables bounded without adding a moving part.
   */
  async prune(ownerSubject: string, agentProfileId: string, maximumItems: number): Promise<number> {
    const expired = await this.database
      .delete(agentMemory)
      .where(and(
        eq(agentMemory.ownerSubject, ownerSubject),
        eq(agentMemory.agentProfileId, agentProfileId),
        lte(agentMemory.retentionUntil, new Date()),
      ))
      .returning({ id: agentMemory.id });

    const survivors = await this.database
      .select({ id: agentMemory.id })
      .from(agentMemory)
      .where(and(
        eq(agentMemory.ownerSubject, ownerSubject),
        eq(agentMemory.agentProfileId, agentProfileId),
      ))
      .orderBy(desc(agentMemory.createdAt));
    const excess = survivors.slice(maximumItems).map(({ id }) => id);
    if (excess.length === 0) return expired.length;

    const trimmed = await this.database
      .delete(agentMemory)
      .where(and(
        eq(agentMemory.ownerSubject, ownerSubject),
        inArray(agentMemory.id, excess),
      ))
      .returning({ id: agentMemory.id });
    return expired.length + trimmed.length;
  }

  /** An item with no expiry never expires; one with an expiry is live until it passes. */
  private unexpired() {
    return or(isNull(agentMemory.retentionUntil), gt(agentMemory.retentionUntil, new Date()));
  }
}
