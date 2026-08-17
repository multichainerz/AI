import { afterEach, describe, expect, it, vi } from "vitest";
import { InferenceCatalogueError, InferenceCatalogueService } from "./inference-catalogue-service.js";

afterEach(() => vi.unstubAllGlobals());

describe("InferenceCatalogueService", () => {
  it("refuses a rejected key without loading models", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 401 }));
    const service = new InferenceCatalogueService(fetchMock as typeof fetch);

    await expect(service.list({
      provider: "openrouter",
      apiKey: "sk-or-bad",
      timeoutMs: 8_000,
    })).rejects.toMatchObject({
      name: "InferenceCatalogueError",
      code: "AUTH_REJECTED",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://openrouter.ai/api/v1/key");
  });

  it("returns admitted slugs and drops floating aliases", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({
        data: { label: "pilot-key", limit_remaining: 12.5 },
      }))
      .mockResolvedValueOnce(Response.json({
        data: [
          { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4" },
          { id: "~openai/gpt-latest", name: "GPT latest" },
          { id: "openai/gpt-5.6-sol" },
        ],
      }));
    const service = new InferenceCatalogueService(fetchMock as typeof fetch);

    await expect(service.list({
      provider: "openrouter",
      apiKey: "sk-or-v1-test",
      timeoutMs: 8_000,
    })).resolves.toEqual({
      provider: "openrouter",
      models: [
        { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4" },
        { id: "openai/gpt-5.6-sol" },
      ],
      key: { label: "pilot-key", limitRemaining: 12.5 },
    });
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("https://openrouter.ai/api/v1/models");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      redirect: "error",
      headers: { authorization: "Bearer sk-or-v1-test" },
    });
  });

  it("does not treat a 401 as a successful catalogue", async () => {
    const service = new InferenceCatalogueService(vi.fn().mockResolvedValueOnce(
      Response.json({ error: { message: "No cookie auth credentials found", code: 401 } }, { status: 401 }),
    ) as typeof fetch);

    await expect(service.list({
      provider: "openrouter",
      apiKey: "missing",
      timeoutMs: 8_000,
    })).rejects.toBeInstanceOf(InferenceCatalogueError);
  });
});
