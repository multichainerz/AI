import { describe, expect, it, vi } from "vitest";
import type { PrismaRuntimeConnectionResolver } from "./connection-resolver.js";
import { convertDocumentToPages } from "./converter.js";
import { UnlimitedOcrClient } from "./ocr-client.js";

function resolver(configuration: Record<string, unknown> = {}): PrismaRuntimeConnectionResolver {
  return {
    resolveOne: vi.fn(async () => ({
      id: "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d",
      kind: "OCR",
      baseUrl: "https://ocr.mpm.internal/api/",
      configuration,
      secrets: { apiKey: "write-only-key" },
    })),
  } as unknown as PrismaRuntimeConnectionResolver;
}

describe("document runtime", () => {
  it("passes approved images directly into the OCR page pipeline", async () => {
    const original = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
    const pages = await convertDocumentToPages(original, "scan.png", "image/png");
    expect(pages).toEqual([{ pageNumber: 1, mediaType: "image/png", bytes: original }]);
  });

  it("sends a bounded, same-origin multimodal OCR request", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init).toMatchObject({
        method: "POST",
        redirect: "error",
        headers: expect.objectContaining({ authorization: "Bearer write-only-key" }),
      });
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({ model: "ocr-primary", temperature: 0 });
      return new Response(JSON.stringify({
        id: "ocr-request-1",
        choices: [{ message: { content: "# Vehicle policy\n\nKeep all receipts." } }],
        usage: { total_tokens: 24 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const client = new UnlimitedOcrClient(
      resolver({ modelAlias: "ocr-primary", chatPath: "/v1/chat/completions", inferenceTimeoutMs: 5_000 }),
      fetcher,
    );

    const result = await client.extract(Uint8Array.from([1, 2, 3]), "image/png");

    expect(fetcher.mock.calls[0]?.[0].toString()).toBe("https://ocr.mpm.internal/v1/chat/completions");
    expect(result.markdown).toContain("# Vehicle policy");
    expect(result.text).toBe("Vehicle policy Keep all receipts.");
    expect(result.metadata).toMatchObject({ providerRequestId: "ocr-request-1", model: "ocr-primary" });
  });

  it("rejects OCR paths that escape the configured origin", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new UnlimitedOcrClient(
      resolver({ chatPath: "https://external.example/v1/chat/completions" }),
      fetcher,
    );
    await expect(client.extract(Uint8Array.from([1]), "image/png")).rejects.toThrow(
      "must remain on the configured origin",
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});
