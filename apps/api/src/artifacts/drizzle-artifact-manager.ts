import { createHash } from "node:crypto";
import {
  CHAT_ARTIFACT_INLINE_LIMIT_BYTES,
  type ChatArtifact,
  type ChatArtifactList,
  type HermesArtifactReceipt,
  type HermesArtifactUpload,
} from "@orcasynapse/contracts";
import {
  agentProfile,
  agentRun,
  chatArtifact,
  chatArtifactContent,
  chatConversation,
  chatMessage,
  type OrcaSynapseDatabase,
} from "@orcasynapse/database";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { ChatPrincipal } from "../chat/chat-manager.js";
import type { DrizzleHermesRuntimeNodeManager } from "../runtime-nodes/drizzle-runtime-node-manager.js";
import type { NodeSignatureHeaders } from "../runtime-nodes/runtime-node-manager.js";
import {
  ArtifactNotFoundError,
  ArtifactNotRetainedError,
  ArtifactValidationError,
  type ChatArtifactManager,
} from "./artifact-manager.js";

export class DrizzleChatArtifactManager implements ChatArtifactManager {
  constructor(
    private readonly database: OrcaSynapseDatabase,
    private readonly nodeTrust: Pick<DrizzleHermesRuntimeNodeManager, "authenticateNodeRequest">,
  ) {}

  async ingest(nodeId: string, headers: NodeSignatureHeaders, input: HermesArtifactUpload): Promise<HermesArtifactReceipt> {
    await this.nodeTrust.authenticateNodeRequest(
      nodeId,
      { method: "POST", path: `/api/v1/runtime-nodes/${nodeId}/artifacts` },
      headers,
      input,
    );

    /*
     * Attribution comes from the run the control plane already authorized --
     * division, conversation and owner are never taken from anything the node
     * asserts beyond the session identifier itself, which the signature ties
     * to an enrolled node. An unknown session is refused rather than stored
     * division-less: `divisionId: null` has to keep meaning "deployment-wide
     * profile", never "we lost track of whose file this is".
     */
    const [run] = await this.database.select({
      id: agentRun.id,
      profileId: agentRun.profileId,
      ownerSubject: agentRun.ownerSubject,
    }).from(agentRun).where(eq(agentRun.sessionId, input.sessionId))
      .orderBy(desc(agentRun.createdAt)).limit(1);
    if (!run) throw new ArtifactValidationError("The artifact upload names a session this control plane never authorized.");

    const [profile] = await this.database.select({ divisionId: agentProfile.divisionId })
      .from(agentProfile).where(eq(agentProfile.id, run.profileId)).limit(1);
    const [message] = await this.database.select({ id: chatMessage.id, conversationId: chatMessage.conversationId })
      .from(chatMessage).where(eq(chatMessage.agentRunId, run.id)).limit(1);

    const results: HermesArtifactReceipt["results"] = [];
    for (const entry of input.artifacts) {
      const declaredBytes = Number(entry.sizeBytes);
      let content: Buffer | null = null;
      if (entry.contentBase64 !== null) {
        if (declaredBytes > CHAT_ARTIFACT_INLINE_LIMIT_BYTES) {
          throw new ArtifactValidationError(`"${entry.path}" exceeds the 4 MiB inline limit and must be published as metadata only.`);
        }
        content = Buffer.from(entry.contentBase64, "base64");
        if (content.byteLength !== declaredBytes) {
          throw new ArtifactValidationError(`"${entry.path}" decodes to ${content.byteLength} bytes but declares ${declaredBytes}.`);
        }
        if (createHash("sha256").update(content).digest("hex") !== entry.sha256) {
          throw new ArtifactValidationError(`"${entry.path}" does not match its declared content hash.`);
        }
      }
      const storage = content === null ? "NODE" as const : "INLINE" as const;
      const name = entry.path.split("/").pop()!.slice(0, 160);
      const observedAt = new Date(entry.modifiedAt);

      const result = await this.database.transaction(async (transaction) => {
        const [existing] = await transaction.select({ id: chatArtifact.id, sha256: chatArtifact.sha256 })
          .from(chatArtifact)
          .where(and(eq(chatArtifact.runId, run.id), eq(chatArtifact.path, entry.path))).limit(1);
        if (existing && existing.sha256 === entry.sha256) {
          return { path: entry.path, artifactId: existing.id, storage, unchanged: true };
        }
        if (existing) {
          // The file at this path changed since it was last published. The row
          // is the file, not the write event, so it follows the file forward.
          await transaction.update(chatArtifact).set({
            mediaType: entry.mediaType, sizeBytes: declaredBytes, sha256: entry.sha256, storage, observedAt, name,
          }).where(eq(chatArtifact.id, existing.id));
          await transaction.delete(chatArtifactContent).where(eq(chatArtifactContent.artifactId, existing.id));
          if (content) await transaction.insert(chatArtifactContent).values({ artifactId: existing.id, bytes: content });
          return { path: entry.path, artifactId: existing.id, storage, unchanged: false };
        }
        const [created] = await transaction.insert(chatArtifact).values({
          runId: run.id,
          conversationId: message?.conversationId ?? null,
          messageId: message?.id ?? null,
          nodeId,
          divisionId: profile?.divisionId ?? null,
          ownerSubject: run.ownerSubject,
          name, path: entry.path, mediaType: entry.mediaType,
          sizeBytes: declaredBytes, sha256: entry.sha256, storage, observedAt,
        }).returning({ id: chatArtifact.id });
        if (content) await transaction.insert(chatArtifactContent).values({ artifactId: created!.id, bytes: content });
        return { path: entry.path, artifactId: created!.id, storage, unchanged: false };
      });
      results.push(result);
    }

    /*
     * Tombstones last, and only for NODE rows: deleting an inline artifact
     * because the node cleaned its workspace would revoke the exact promise
     * inlining made. A tombstone for an inline row is therefore a no-op, and
     * one for a path never published is too -- reconciliation is idempotent.
     */
    let removed = 0;
    for (const path of input.removedPaths) {
      const dropped = await this.database.delete(chatArtifact)
        .where(and(eq(chatArtifact.runId, run.id), eq(chatArtifact.path, path), eq(chatArtifact.storage, "NODE")))
        .returning({ id: chatArtifact.id });
      removed += dropped.length;
    }

    return { accepted: true, results, removed, serverTime: new Date().toISOString() };
  }
  /** The rows a principal may see, as a WHERE clause -- never a UI filter. */
  private visibility(principal: ChatPrincipal) {
    if (principal.identityMode === "ADMINISTRATOR_PREVIEW") return undefined;
    // Null is a real scope: a deployment-wide profile's artifact belongs to
    // principals with no division, not to everyone. IS NOT DISTINCT FROM,
    // spelled the way drizzle can express it.
    return principal.divisionId == null
      ? isNull(chatArtifact.divisionId)
      : eq(chatArtifact.divisionId, principal.divisionId);
  }

  private static toWire(row: typeof chatArtifact.$inferSelect, conversationTitle: string | null, profileName: string | null): ChatArtifact {
    return {
      id: row.id, runId: row.runId, conversationId: row.conversationId, messageId: row.messageId,
      nodeId: row.nodeId, divisionId: row.divisionId,
      name: row.name, path: row.path, mediaType: row.mediaType,
      sizeBytes: row.sizeBytes, sha256: row.sha256, storage: row.storage,
      conversationTitle, profileName,
      observedAt: row.observedAt.toISOString(), createdAt: row.createdAt.toISOString(),
    };
  }

  async list(principal: ChatPrincipal, filter?: { conversationId?: string }): Promise<ChatArtifactList> {
    const predicates = [this.visibility(principal)];
    if (filter?.conversationId) predicates.push(eq(chatArtifact.conversationId, filter.conversationId));
    const defined = predicates.filter((predicate) => predicate !== undefined);
    const rows = await this.database.select({
      artifact: chatArtifact,
      conversationTitle: chatConversation.title,
      profileName: chatConversation.profileName,
    }).from(chatArtifact)
      .leftJoin(chatConversation, eq(chatArtifact.conversationId, chatConversation.id))
      .where(defined.length === 0 ? undefined : defined.length === 1 ? defined[0] : and(...defined))
      .orderBy(desc(chatArtifact.createdAt))
      .limit(200);
    return { items: rows.map((row) => DrizzleChatArtifactManager.toWire(row.artifact, row.conversationTitle, row.profileName)) };
  }

  async download(principal: ChatPrincipal, artifactId: string): Promise<{ artifact: ChatArtifact; bytes: Buffer }> {
    const visibility = this.visibility(principal);
    const [row] = await this.database.select({
      artifact: chatArtifact,
      conversationTitle: chatConversation.title,
      profileName: chatConversation.profileName,
    }).from(chatArtifact)
      .leftJoin(chatConversation, eq(chatArtifact.conversationId, chatConversation.id))
      .where(visibility ? and(eq(chatArtifact.id, artifactId), visibility) : eq(chatArtifact.id, artifactId))
      .limit(1);
    // Cross-division and nonexistent are the same answer on purpose: a 403
    // would confirm to one division that another division's id exists.
    if (!row) throw new ArtifactNotFoundError();
    if (row.artifact.storage !== "INLINE") throw new ArtifactNotRetainedError();
    const [content] = await this.database.select().from(chatArtifactContent)
      .where(eq(chatArtifactContent.artifactId, artifactId)).limit(1);
    if (!content) throw new ArtifactNotFoundError("This artifact's content is no longer retained.");
    const bytes = Buffer.from(content.bytes);
    if (createHash("sha256").update(bytes).digest("hex") !== row.artifact.sha256) {
      // Loud, not a 404: stored bytes that no longer match their recorded
      // hash are a corruption event an operator must hear about.
      throw new Error(`Artifact ${artifactId} failed its integrity check on read.`);
    }
    return { artifact: DrizzleChatArtifactManager.toWire(row.artifact, row.conversationTitle, row.profileName), bytes };
  }
}
