import { createHash, randomUUID } from "node:crypto";
import {
  createTestDatabase,
  hermesRuntimeNode,
  type TestDatabase,
} from "@orcasynapse/database";
import type { HermesCorpusSnapshotUpload } from "@orcasynapse/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminPrincipal } from "../auth/admin-session.js";
import { CorpusConflictError, CorpusValidationError } from "./corpus-manager.js";
import { DrizzleHermesCorpusManager } from "./drizzle-corpus-manager.js";

let context: TestDatabase;
beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); }, 120_000);
beforeEach(async () => { await context.reset(); });

const NODE_ID = "9de260d7-bc51-4558-9d20-06916d393072";
const NOW = "2026-08-14T00:00:00.000Z";
const headers = { timestamp: NOW, nonce: randomUUID(), signature: "signed" };
const requester = { id: "ac369dab-cad5-4fd9-83ed-b4fbf528028a", subject: "requester" } as AdminPrincipal;
const approver = { id: "b58588b8-537a-4671-9777-f52e3f2ed16a", subject: "approver" } as AdminPrincipal;

function sha(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function snapshot(content: string | null): HermesCorpusSnapshotUpload {
  const entries = content === null ? [] : [{
    path: "memories/MEMORY.md", kind: "MEMORY" as const, mediaType: "text/markdown",
    sizeBytes: String(Buffer.byteLength(content)), sha256: sha(content), content,
    structuredEntries: [content], readOnly: false,
  }];
  const root = createHash("sha256");
  for (const entry of entries) root.update(entry.path).update("\0").update(entry.sha256).update("\n");
  return { format: "orcasynapse-hermes-corpus-snapshot/v1", observedAt: NOW, rootHash: root.digest("hex"), entries };
}

async function seedNode() {
  await context.database.insert(hermesRuntimeNode).values({
    id: NODE_ID, slug: "vm2", displayName: "Hermes VM2", baseUrl: "https://hermes.internal",
    status: "ONLINE", capabilities: ["runs", "corpus-sync-v1", "corpus-crud-v1"],
  });
}

function manager() {
  const authenticateNodeRequest = vi.fn(async () => ({ id: NODE_ID }));
  const signNodeDocument = vi.fn(async (document: unknown) => ({
    documentBase64: Buffer.from(JSON.stringify(document)).toString("base64"),
    signature: "signature", publicKeyFingerprint: "f".repeat(64),
  }));
  return {
    corpus: new DrizzleHermesCorpusManager(context.database, { authenticateNodeRequest, signNodeDocument } as never),
    authenticateNodeRequest,
    signNodeDocument,
  };
}

describe("DrizzleHermesCorpusManager", () => {
  it("mirrors searchable snapshots and keeps immutable change and deletion revisions", async () => {
    await seedNode();
    const { corpus, authenticateNodeRequest } = manager();

    await corpus.uploadSnapshot(NODE_ID, headers, snapshot("First memory"));
    expect(authenticateNodeRequest).toHaveBeenCalled();
    expect(await corpus.entries({ nodeId: NODE_ID, query: "first", includeContent: true })).toMatchObject([
      { path: "memories/MEMORY.md", content: "First memory", revision: 1, deletedAt: null },
    ]);
    expect(await corpus.entries({ nodeId: NODE_ID, query: "first", includeContent: false })).toEqual([]);

    await corpus.uploadSnapshot(NODE_ID, headers, snapshot("Second memory"));
    const [changed] = await corpus.entries({ nodeId: NODE_ID, includeContent: true });
    expect(changed).toMatchObject({ content: "Second memory", revision: 2 });
    expect(await corpus.revisions(changed!.id, true)).toMatchObject([
      { revision: 2, changeKind: "CHANGED", beforeContent: "First memory", afterContent: "Second memory" },
      { revision: 1, changeKind: "DISCOVERED", beforeContent: null, afterContent: "First memory" },
    ]);

    await corpus.uploadSnapshot(NODE_ID, headers, snapshot(null));
    expect(await corpus.entries({ nodeId: NODE_ID, includeContent: true })).toEqual([]);
    expect(await corpus.entries({ nodeId: NODE_ID, includeDeleted: true, includeContent: true })).toMatchObject([
      { revision: 3, deletedAt: expect.any(String) },
    ]);

    await expect(corpus.uploadSnapshot(NODE_ID, { ...headers, nonce: randomUUID() }, {
      ...snapshot("Stale memory"), observedAt: "2026-08-13T23:59:59.000Z",
    })).rejects.toBeInstanceOf(CorpusConflictError);
  });

  it("uses observed hashes, two-person destructive approval, and signed delivery", async () => {
    await seedNode();
    const { corpus, signNodeDocument } = manager();
    const current = snapshot("Current memory");
    await corpus.uploadSnapshot(NODE_ID, headers, current);

    await expect(corpus.createMutation(requester, {
      nodeId: NODE_ID, operation: "MEMORY_REPLACE", path: "memories/MEMORY.md",
      expectedHash: "0".repeat(64), content: "New memory", oldText: "Current memory", reason: "Update memory safely.",
    })).rejects.toBeInstanceOf(CorpusConflictError);

    const requested = await corpus.createMutation(requester, {
      nodeId: NODE_ID, operation: "MEMORY_REMOVE", path: "memories/MEMORY.md",
      expectedHash: current.entries[0]!.sha256, content: null, oldText: "Current memory", reason: "Remove stale memory.",
    });
    expect(requested.status).toBe("PENDING_APPROVAL");
    await expect(corpus.decideMutation(requester, requested.id, { decision: "APPROVE", reason: "Self approve." }))
      .rejects.toBeInstanceOf(CorpusConflictError);
    await expect(corpus.decideMutation({ ...requester, id: randomUUID() }, requested.id, { decision: "APPROVE", reason: "Second login." }))
      .rejects.toBeInstanceOf(CorpusConflictError);
    expect((await corpus.decideMutation(approver, requested.id, { decision: "APPROVE", reason: "Reviewed independently." })).status).toBe("QUEUED");

    await corpus.desiredState(NODE_ID, headers);
    expect(signNodeDocument).toHaveBeenCalledWith(expect.objectContaining({
      nodeId: NODE_ID,
      mutation: expect.objectContaining({ mutationId: requested.id, operation: "MEMORY_REMOVE", expectedHash: current.entries[0]!.sha256 }),
    }));
    await corpus.completeMutation(NODE_ID, headers, {
      mutationId: requested.id, status: "APPLIED", observedHash: sha(""), message: "Applied", completedAt: NOW,
    });
    expect(await corpus.mutations(NODE_ID)).toMatchObject([{ id: requested.id, status: "APPLIED", afterHash: sha("") }]);

    const withdrawn = await corpus.createMutation(requester, {
      nodeId: NODE_ID, operation: "MEMORY_REMOVE", path: "memories/MEMORY.md",
      expectedHash: current.entries[0]!.sha256, content: null, oldText: "Current memory",
      reason: "Withdraw this request during review.",
    });
    expect((await corpus.decideMutation(requester, withdrawn.id, { decision: "REJECT", reason: "No longer required." })).status).toBe("REJECTED");
  });

  it("returns only an identical idempotent retry and rejects key reuse for another change", async () => {
    await seedNode();
    const { corpus } = manager();
    await corpus.uploadSnapshot(NODE_ID, headers, snapshot("Current memory"));
    const idempotencyKey = randomUUID();
    const skillContent = "---\nname: replay-safe\ndescription: Verify idempotent Skill creation.\n---\n\n# Replay safe";
    const request = {
      nodeId: NODE_ID, operation: "SKILL_CREATE" as const, path: "skills/replay-safe/SKILL.md",
      expectedHash: null, content: skillContent, oldText: null,
      reason: "Exercise safe request replay.", idempotencyKey,
    };
    const created = await corpus.createMutation(requester, request);
    const skillEntry = {
      path: request.path, kind: "SKILL" as const, mediaType: "text/markdown",
      sizeBytes: String(Buffer.byteLength(skillContent)), sha256: sha(skillContent), content: skillContent,
      structuredEntries: null, readOnly: false,
    };
    const skillRoot = createHash("sha256").update(skillEntry.path).update("\0").update(skillEntry.sha256).update("\n").digest("hex");
    await corpus.uploadSnapshot(NODE_ID, { ...headers, nonce: randomUUID() }, {
      format: "orcasynapse-hermes-corpus-snapshot/v1", observedAt: NOW, rootHash: skillRoot, entries: [skillEntry],
    });
    expect((await corpus.createMutation(requester, request)).id).toBe(created.id);
    await expect(corpus.createMutation(requester, { ...request, reason: "A different mutation request." }))
      .rejects.toBeInstanceOf(CorpusConflictError);
  });

  it("accepts Hermes-native categorized names while refusing secret-like writes", async () => {
    await seedNode();
    const { corpus } = manager();
    const content = "---\nname: incident_response\ndescription: Coordinate incident response.\n---\n\n# Response";
    const entry = {
      path: "skills/operations/incident_response/SKILL.md", kind: "SKILL" as const,
      mediaType: "text/markdown", sizeBytes: String(Buffer.byteLength(content)), sha256: sha(content),
      content, structuredEntries: null, readOnly: false,
    };
    const rootHash = createHash("sha256").update(entry.path).update("\0").update(entry.sha256).update("\n").digest("hex");
    await corpus.uploadSnapshot(NODE_ID, headers, {
      format: "orcasynapse-hermes-corpus-snapshot/v1", observedAt: NOW, rootHash, entries: [entry],
    });
    expect(await corpus.entries({ nodeId: NODE_ID, includeContent: true })).toMatchObject([
      { path: entry.path, kind: "SKILL" },
    ]);
    await expect(corpus.createMutation(requester, {
      nodeId: NODE_ID, operation: "SKILL_EDIT", path: entry.path,
      expectedHash: entry.sha256, content: "Bearer abcdefghijklmnopqrstuvwxyz123456", oldText: null,
      reason: "Prove secret filtering.",
    })).rejects.toBeInstanceOf(CorpusValidationError);
    await expect(corpus.createMutation(requester, {
      nodeId: NODE_ID, operation: "SKILL_CREATE", path: "skills/different-name/SKILL.md",
      expectedHash: null, content, oldText: null, reason: "Prove Skill identity validation.",
    })).rejects.toBeInstanceOf(CorpusValidationError);

    const hidden = { ...entry, path: "skills/operations/incident_response/.git/config", kind: "SKILL_FILE" as const, readOnly: true };
    const hiddenRoot = createHash("sha256").update(hidden.path).update("\0").update(hidden.sha256).update("\n").digest("hex");
    await expect(corpus.uploadSnapshot(NODE_ID, { ...headers, nonce: randomUUID() }, {
      format: "orcasynapse-hermes-corpus-snapshot/v1", observedAt: NOW, rootHash: hiddenRoot, entries: [hidden],
    })).rejects.toBeInstanceOf(CorpusValidationError);

    const inconsistent = { ...entry, content: `${content}\nmalformed`, sizeBytes: entry.sizeBytes };
    await expect(corpus.uploadSnapshot(NODE_ID, { ...headers, nonce: randomUUID() }, {
      format: "orcasynapse-hermes-corpus-snapshot/v1", observedAt: NOW, rootHash, entries: [inconsistent],
    })).rejects.toBeInstanceOf(CorpusValidationError);

    const nestedContent = "---\nname: nested\ndescription: Nested fixture.\n---\n\n# Nested";
    const nested = {
      path: "skills/operations/incident_response/references/nested/SKILL.md", kind: "SKILL" as const,
      mediaType: "text/markdown", sizeBytes: String(Buffer.byteLength(nestedContent)), sha256: sha(nestedContent),
      content: nestedContent, structuredEntries: null, readOnly: false,
    };
    const topologyEntries = [entry, nested];
    const topologyRoot = createHash("sha256");
    for (const item of topologyEntries.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))) {
      topologyRoot.update(item.path).update("\0").update(item.sha256).update("\n");
    }
    await expect(corpus.uploadSnapshot(NODE_ID, { ...headers, nonce: randomUUID() }, {
      format: "orcasynapse-hermes-corpus-snapshot/v1", observedAt: NOW,
      rootHash: topologyRoot.digest("hex"), entries: topologyEntries,
    })).rejects.toBeInstanceOf(CorpusValidationError);
  });
});
