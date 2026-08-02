import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { EncryptedFileSystemDocumentScratchStore } from "./scratch-store.js";

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orcasynapse-scratch-test-"));
  roots.push(root);
  return { root, store: new EncryptedFileSystemDocumentScratchStore(root, Buffer.alloc(32, 7)) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("EncryptedFileSystemDocumentScratchStore", () => {
  it("encrypts transient content at rest and decrypts it for workers", async () => {
    const { root, store } = await fixture();
    await store.putStream(
      "documents/11111111-1111-4111-8111-111111111111/original/source.bin",
      Readable.from([Buffer.from("secret document")]),
    );

    const raw = await readFile(join(root, "documents", "11111111-1111-4111-8111-111111111111", "original", "source.bin"));
    expect(raw.toString("utf8")).not.toContain("secret document");
    await expect(store.getBuffer("documents/11111111-1111-4111-8111-111111111111/original/source.bin"))
      .resolves.toEqual(Buffer.from("secret document"));
  });

  it("supports file staging and bounded recursive purge", async () => {
    const { root, store } = await fixture();
    const source = join(root, "source.txt");
    await writeFile(source, "temporary");
    await store.putFile("documents/22222222-2222-4222-8222-222222222222/original/source.bin", source);
    await store.putBuffer("documents/22222222-2222-4222-8222-222222222222/generation-1/normalized/content.md", Buffer.from("knowledge"));

    await store.deletePrefix("documents/22222222-2222-4222-8222-222222222222");

    await expect(store.getBuffer("documents/22222222-2222-4222-8222-222222222222/original/source.bin")).rejects.toThrow();
  });

  it("rejects keys that could escape the configured root", async () => {
    const { store } = await fixture();
    await expect(store.putBuffer("../outside", Buffer.from("no"))).rejects.toThrow("invalid");
  });
});
