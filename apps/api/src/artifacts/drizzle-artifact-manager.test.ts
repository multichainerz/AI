import { createHash, randomUUID } from "node:crypto";
import {
  agentProfile,
  agentProfileVersion,
  agentRun,
  auditEvent,
  chatArtifact,
  chatArtifactContent,
  chatConversation,
  chatMessage,
  createTestDatabase,
  division,
  hermesRuntimeNode,
  type TestDatabase,
} from "@orcasynapse/database";
import type { HermesArtifactUpload } from "@orcasynapse/contracts";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatPrincipal } from "../chat/chat-manager.js";
import { ArtifactNotFoundError, ArtifactNotRetainedError, ArtifactValidationError } from "./artifact-manager.js";
import { DrizzleChatArtifactManager } from "./drizzle-artifact-manager.js";

let context: TestDatabase;
beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); }, 120_000);
beforeEach(async () => { await context.reset(); });

const NODE_ID = "9de260d7-bc51-4558-9d20-06916d393072";
const DIVISION_ID = "5b7f0f9e-8c1d-4f2a-9d3e-1a2b3c4d5e6f";
const RUN_ID = "c2a4e6f8-1b3d-4f5a-8c7e-9d0b1a2c3e4f";
const SESSION_ID = "hermes-session-artifact-test";
const NOW = "2026-08-19T00:00:00.000Z";
const headers = { timestamp: NOW, nonce: randomUUID(), signature: "signed" };

function sha(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function upload(over: Partial<HermesArtifactUpload> = {}, file?: { path?: string; bytes?: Buffer; inline?: boolean }): HermesArtifactUpload {
  const bytes = file?.bytes ?? Buffer.from("# Findings\n\nAll clear.\n", "utf8");
  return {
    format: "orcasynapse-hermes-artifacts/v1",
    observedAt: NOW,
    sessionId: SESSION_ID,
    removedPaths: [],
    artifacts: [{
      path: file?.path ?? "out/findings.md",
      mediaType: "text/markdown",
      sizeBytes: String(bytes.byteLength),
      sha256: sha(bytes),
      modifiedAt: NOW,
      contentBase64: file?.inline === false ? null : bytes.toString("base64"),
    }],
    ...over,
  };
}

/** A division-bound profile with one authorized run and its chat message. */
async function seed({ divisionBound = true, withMessage = true } = {}) {
  const db = context.database;
  await db.insert(hermesRuntimeNode).values({
    id: NODE_ID, slug: "vm2", displayName: "Hermes VM2", baseUrl: "https://hermes.internal", status: "ONLINE",
  });
  if (divisionBound) {
    await db.insert(division).values({ id: DIVISION_ID, slug: "atlas", displayName: "Atlas" });
  }
  const [profile] = await db.insert(agentProfile).values({
    slug: "analyst", status: "ACTIVE", divisionId: divisionBound ? DIVISION_ID : null,
  }).returning({ id: agentProfile.id });
  const [version] = await db.insert(agentProfileVersion).values({
    profileId: profile!.id, version: 1, displayName: "Analyst", purpose: "test",
    // maxTurns 1 + safeMode true: the phase-5 boundary check on this table.
    instructions: "be brief", modelAlias: "hermes-agent", maxTurns: 1,
    timeoutSeconds: 600, maxConcurrentRuns: 1,
  }).returning({ id: agentProfileVersion.id });
  await db.insert(agentRun).values({
    id: RUN_ID, profileId: profile!.id, profileVersionId: version!.id, profileVersion: 1,
    ownerSubject: "operator@example.test", requestedBy: randomUUID(), status: "RUNNING",
    input: "produce the findings file", sessionId: SESSION_ID,
  });
  if (!withMessage) return { conversationId: null, messageId: null };
  const [conversation] = await db.insert(chatConversation).values({
    ownerSubject: "operator@example.test", title: "Findings", modelAlias: "hermes-agent",
  }).returning({ id: chatConversation.id });
  const [message] = await db.insert(chatMessage).values({
    conversationId: conversation!.id, ordinal: 1, role: "ASSISTANT", content: "", status: "PENDING", agentRunId: RUN_ID,
  }).returning({ id: chatMessage.id });
  return { conversationId: conversation!.id, messageId: message!.id };
}

function manager() {
  const authenticateNodeRequest = vi.fn(async () => ({ id: NODE_ID }));
  return {
    artifacts: new DrizzleChatArtifactManager(context.database, { authenticateNodeRequest } as never),
    authenticateNodeRequest,
  };
}

describe("DrizzleChatArtifactManager", () => {
  it("stores an inline artifact stamped with the run's division and conversation", async () => {
    const { conversationId, messageId } = await seed();
    const { artifacts, authenticateNodeRequest } = manager();

    const receipt = await artifacts.ingest(NODE_ID, headers, upload());

    expect(authenticateNodeRequest).toHaveBeenCalledWith(
      NODE_ID,
      { method: "POST", path: `/api/v1/runtime-nodes/${NODE_ID}/artifacts` },
      headers,
      expect.anything(),
    );
    expect(receipt.results).toMatchObject([{ path: "out/findings.md", storage: "INLINE", unchanged: false }]);

    const [row] = await context.database.select().from(chatArtifact);
    expect(row).toMatchObject({
      runId: RUN_ID, nodeId: NODE_ID, divisionId: DIVISION_ID,
      conversationId, messageId, ownerSubject: "operator@example.test",
      name: "findings.md", storage: "INLINE",
    });
    const [content] = await context.database.select().from(chatArtifactContent);
    expect(Buffer.from(content!.bytes).toString("utf8")).toContain("All clear.");
    const [ingested] = await context.database.select().from(auditEvent);
    expect(ingested).toMatchObject({
      action: "chat.artifact_ingested",
      resourceType: "AgentRun",
      resourceId: RUN_ID,
      outcome: "SUCCESS",
    });
  });

  it("refuses a session this control plane never authorized", async () => {
    // An artifact that cannot be attributed has no tenant. Storing it with a
    // null division would make null ambiguous between "deployment-wide
    // profile" and "lost track", so the upload is refused outright.
    await seed();
    const { artifacts } = manager();

    await expect(artifacts.ingest(NODE_ID, headers, upload({ sessionId: "never-issued" })))
      .rejects.toThrow(ArtifactValidationError);
    expect(await context.database.select().from(chatArtifact)).toHaveLength(0);
  });

  it("stamps null division only for a deployment-wide profile", async () => {
    await seed({ divisionBound: false });
    const { artifacts } = manager();

    await artifacts.ingest(NODE_ID, headers, upload());

    const [row] = await context.database.select().from(chatArtifact);
    expect(row!.divisionId).toBeNull();
  });

  it("rejects content that disagrees with its declared hash or size", async () => {
    await seed();
    const { artifacts } = manager();

    const lying = upload();
    lying.artifacts[0]!.sha256 = sha("something else entirely");
    await expect(artifacts.ingest(NODE_ID, headers, lying)).rejects.toThrow(/content hash/);

    const short = upload();
    short.artifacts[0]!.sizeBytes = "9999";
    await expect(artifacts.ingest(NODE_ID, headers, short)).rejects.toThrow(/declares 9999/);
    expect(await context.database.select().from(chatArtifact)).toHaveLength(0);
  });

  it("refuses inline bytes past the 4 MiB limit but records the file as metadata", async () => {
    await seed();
    const { artifacts } = manager();

    // Inline over the limit: rejected, never truncated.
    const big = Buffer.alloc(64, 7);
    const over = upload({}, { bytes: big });
    over.artifacts[0]!.sizeBytes = String(5 * 1024 * 1024);
    await expect(artifacts.ingest(NODE_ID, headers, over)).rejects.toThrow(/inline limit/);

    // The same file as metadata only: accepted and listed honestly as NODE.
    const metadataOnly = upload({}, { bytes: big, inline: false });
    metadataOnly.artifacts[0]!.sizeBytes = String(5 * 1024 * 1024);
    metadataOnly.artifacts[0]!.sha256 = sha(big);
    const receipt = await artifacts.ingest(NODE_ID, headers, metadataOnly);

    expect(receipt.results).toMatchObject([{ storage: "NODE", unchanged: false }]);
    expect(await context.database.select().from(chatArtifactContent)).toHaveLength(0);
    const [row] = await context.database.select().from(chatArtifact);
    expect(row).toMatchObject({ storage: "NODE", sizeBytes: 5 * 1024 * 1024 });
  });

  it("is idempotent per (run, path) and follows the file when it changes", async () => {
    await seed();
    const { artifacts } = manager();

    await artifacts.ingest(NODE_ID, headers, upload());
    const again = await artifacts.ingest(NODE_ID, headers, upload());
    expect(again.results).toMatchObject([{ unchanged: true }]);
    expect(await context.database.select().from(chatArtifact)).toHaveLength(1);

    const revised = Buffer.from("# Findings\n\nOne regression.\n", "utf8");
    const changed = await artifacts.ingest(NODE_ID, headers, upload({}, { bytes: revised }));
    expect(changed.results).toMatchObject([{ unchanged: false }]);

    const rows = await context.database.select().from(chatArtifact);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sha256).toBe(sha(revised));
    const [content] = await context.database.select().from(chatArtifactContent)
      .where(eq(chatArtifactContent.artifactId, rows[0]!.id));
    expect(Buffer.from(content!.bytes).toString("utf8")).toContain("One regression.");
  });

  it("drops a NODE row on its tombstone but never an inline one", async () => {
    await seed();
    const { artifacts } = manager();

    const big = Buffer.alloc(16, 3);
    const nodeOnly = upload({}, { path: "out/huge.bin", bytes: big, inline: false });
    nodeOnly.artifacts[0]!.sizeBytes = String(5 * 1024 * 1024);
    nodeOnly.artifacts[0]!.sha256 = sha(big);
    await artifacts.ingest(NODE_ID, headers, nodeOnly);
    await artifacts.ingest(NODE_ID, headers, upload());
    expect(await context.database.select().from(chatArtifact)).toHaveLength(2);

    // Both files left the node's disk. Only the row whose bytes were never
    // retained goes; deleting the inline one would revoke the promise
    // inlining made. The receipt says how many actually went.
    const reconcile = upload({ artifacts: [], removedPaths: ["out/huge.bin", "out/findings.md"] });
    const receipt = await artifacts.ingest(NODE_ID, headers, reconcile);

    expect(receipt.removed).toBe(1);
    const rows = await context.database.select().from(chatArtifact);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ path: "out/findings.md", storage: "INLINE" });
  });

  it("attributes a run with no chat message to the run alone", async () => {
    await seed({ withMessage: false });
    const { artifacts } = manager();

    await artifacts.ingest(NODE_ID, headers, upload());

    const [row] = await context.database.select().from(chatArtifact);
    expect(row).toMatchObject({ runId: RUN_ID, conversationId: null, messageId: null, divisionId: DIVISION_ID });
  });

  it("deletes a conversation's files with the conversation, bytes included", async () => {
    /*
     * An operator ruling, reversing the original `set null`: a deleted chat
     * leaves nothing behind in the artifact store. The cascade chain is
     * conversation -> artifact -> content, so the inline bytes cannot survive
     * their own metadata row.
     */
    const { conversationId } = await seed();
    const { artifacts } = manager();
    await artifacts.ingest(NODE_ID, headers, upload());
    expect(await context.database.select().from(chatArtifactContent)).toHaveLength(1);

    await context.database.delete(chatConversation).where(eq(chatConversation.id, conversationId!));

    expect(await context.database.select().from(chatArtifact)).toHaveLength(0);
    expect(await context.database.select().from(chatArtifactContent)).toHaveLength(0);
  });
});

describe("division-scoped reads", () => {
  const member = (divisionId: string | null): ChatPrincipal => ({
    id: randomUUID(), subject: "person@example.test", identityMode: "ENTERPRISE", scopes: ["chat:use"], divisionId,
  });
  const administrator: ChatPrincipal = {
    id: randomUUID(), subject: "admin", identityMode: "ADMINISTRATOR_PREVIEW", scopes: ["chat:use"],
  };

  it("bounds an enterprise principal to its own division, with null matched explicitly", async () => {
    await seed();
    const { artifacts } = manager();
    await artifacts.ingest(NODE_ID, headers, upload());

    const inDivision = await artifacts.list(member(DIVISION_ID));
    expect(inDivision.items).toMatchObject([{ name: "findings.md", divisionId: DIVISION_ID, conversationTitle: "Findings" }]);

    // Another division sees nothing; so does a principal with no division at
    // all -- null is a scope of its own, never "no filter".
    expect((await artifacts.list(member(randomUUID()))).items).toEqual([]);
    expect((await artifacts.list(member(null))).items).toEqual([]);

    // An administrator preview spans divisions: operating the deployment is
    // what that session is for.
    expect((await artifacts.list(administrator)).items).toHaveLength(1);
  });

  it("narrows the list to one conversation when asked", async () => {
    const { conversationId } = await seed();
    const { artifacts } = manager();
    await artifacts.ingest(NODE_ID, headers, upload());

    const scoped = await artifacts.list(member(DIVISION_ID), { conversationId: conversationId! });
    expect(scoped.items).toHaveLength(1);
    expect(scoped.items[0]!.messageId).not.toBeNull();

    const elsewhere = await artifacts.list(member(DIVISION_ID), { conversationId: randomUUID() });
    expect(elsewhere.items).toEqual([]);
  });

  it("answers a cross-division download with NOT FOUND, not FORBIDDEN", async () => {
    await seed();
    const { artifacts } = manager();
    const receipt = await artifacts.ingest(NODE_ID, headers, upload());
    const artifactId = receipt.results[0]!.artifactId;

    await expect(artifacts.download(member(randomUUID()), artifactId)).rejects.toThrow(ArtifactNotFoundError);

    const { artifact, bytes } = await artifacts.download(member(DIVISION_ID), artifactId);
    expect(artifact.name).toBe("findings.md");
    expect(bytes.toString("utf8")).toContain("All clear.");
  });

  it("refuses to download a NODE-storage artifact rather than serving nothing", async () => {
    await seed();
    const { artifacts } = manager();
    const big = Buffer.alloc(32, 1);
    const metadataOnly = upload({}, { bytes: big, inline: false });
    metadataOnly.artifacts[0]!.sizeBytes = String(5 * 1024 * 1024);
    metadataOnly.artifacts[0]!.sha256 = sha(big);
    const receipt = await artifacts.ingest(NODE_ID, headers, metadataOnly);

    await expect(artifacts.download(member(DIVISION_ID), receipt.results[0]!.artifactId))
      .rejects.toThrow(ArtifactNotRetainedError);
  });

  it("stores a person's upload inline, labelled and stamped from the session", async () => {
    const { conversationId } = await seed();
    const { artifacts } = manager();
    const owner: ChatPrincipal = {
      id: randomUUID(), subject: "operator@example.test", identityMode: "ENTERPRISE", scopes: ["chat:use"], divisionId: DIVISION_ID,
    };
    const bytes = Buffer.from("quarterly notes", "utf8");

    const stored = await artifacts.upload(owner, {
      conversationId: conversationId!,
      name: "notes.txt",
      mediaType: "text/plain",
      contentBase64: bytes.toString("base64"),
    });

    // Origin is a labelled fact; run and node are honestly absent, and the
    // division is the uploader's own — never anything the request asserted.
    expect(stored).toMatchObject({
      origin: "UPLOADED", runId: null, nodeId: null, storage: "INLINE",
      divisionId: DIVISION_ID, name: "notes.txt", sizeBytes: bytes.byteLength,
    });
    const { bytes: fetched } = await artifacts.download(owner, stored.id);
    expect(fetched.toString("utf8")).toBe("quarterly notes");
    expect((await context.database.select().from(auditEvent)).map(({ action }) => action))
      .toContain("chat.artifact_uploaded");
    // And the node path keeps its own label.
    await artifacts.ingest(NODE_ID, headers, upload());
    const listed = await artifacts.list(owner);
    expect(listed.items.map((item) => item.origin).sort()).toEqual(["AGENT", "UPLOADED"]);
  });

  it("answers a conversation the principal does not own with NOT FOUND", async () => {
    const { conversationId } = await seed();
    const { artifacts } = manager();
    const stranger: ChatPrincipal = {
      id: randomUUID(), subject: "someone-else@example.test", identityMode: "ENTERPRISE", scopes: ["chat:use"], divisionId: DIVISION_ID,
    };

    await expect(artifacts.upload(stranger, {
      conversationId: conversationId!, name: "notes.txt", mediaType: "text/plain",
      contentBase64: Buffer.from("x").toString("base64"),
    })).rejects.toThrow(ArtifactNotFoundError);
  });

  it("refuses an upload past the inline limit instead of storing a truncation", async () => {
    const { conversationId } = await seed();
    const { artifacts } = manager();
    const owner: ChatPrincipal = {
      id: randomUUID(), subject: "operator@example.test", identityMode: "ENTERPRISE", scopes: ["chat:use"], divisionId: DIVISION_ID,
    };

    await expect(artifacts.upload(owner, {
      conversationId: conversationId!, name: "too-big.bin", mediaType: "application/octet-stream",
      contentBase64: Buffer.alloc(4 * 1024 * 1024 + 1, 7).toString("base64"),
    })).rejects.toThrow(/4 MiB/);
    await expect(artifacts.upload(owner, {
      conversationId: conversationId!, name: "empty.txt", mediaType: "text/plain", contentBase64: "",
    })).rejects.toThrow(/empty/);
  });
});
