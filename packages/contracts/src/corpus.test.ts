import { describe, expect, it } from "vitest";
import {
  createHermesCorpusMutationSchema,
  hermesCorpusSnapshotUploadSchema,
} from "./corpus.js";

const NODE_ID = "9de260d7-bc51-4558-9d20-06916d393072";
const HASH = "a".repeat(64);

describe("Hermes corpus contracts", () => {
  it("confines snapshots to normalized relative paths and bounded content", () => {
    const valid = {
      format: "orcasynapse-hermes-corpus-snapshot/v1",
      observedAt: "2026-08-14T00:00:00.000Z",
      rootHash: HASH,
      entries: [{
        path: "skills/research/SKILL.md", kind: "SKILL", mediaType: "text/markdown",
        sizeBytes: "12", sha256: HASH, content: "# Research", structuredEntries: null, readOnly: false,
      }],
    };
    expect(hermesCorpusSnapshotUploadSchema.safeParse(valid).success).toBe(true);
    expect(hermesCorpusSnapshotUploadSchema.safeParse({
      ...valid, entries: [{ ...valid.entries[0], path: "skills/../credentials.json" }],
    }).success).toBe(false);
    expect(hermesCorpusSnapshotUploadSchema.safeParse({
      ...valid, entries: [{ ...valid.entries[0], sizeBytes: 12 }],
    }).success).toBe(false);
  });

  it("requires conflict hashes for updates while permitting append and create operations", () => {
    const base = {
      nodeId: NODE_ID, path: "memories/MEMORY.md",
      content: "Remember this", oldText: null, expectedHash: null, reason: "Operator requested memory update.",
    };
    expect(createHermesCorpusMutationSchema.safeParse({ ...base, operation: "MEMORY_ADD" }).success).toBe(true);
    expect(createHermesCorpusMutationSchema.safeParse({
      ...base, operation: "MEMORY_REPLACE", oldText: "Old", expectedHash: null,
    }).success).toBe(false);
    expect(createHermesCorpusMutationSchema.safeParse({
      ...base, operation: "SKILL_WRITE_FILE", path: "skills/research/references/guide.md",
    }).success).toBe(true);
  });
});
