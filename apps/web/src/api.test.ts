import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AIHubApiError,
  createAdministratorSession,
  getConnections,
  rollbackConfiguration,
} from "./api.js";

afterEach(() => vi.restoreAllMocks());

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("AIHub browser API", () => {
  it("exchanges the bootstrap token without reusing it as an API header", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      id: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
      subject: "bootstrap-administrator",
      role: "PLATFORM_ADMIN",
      scopes: ["connections:read"],
      createdAt: "2026-07-30T00:00:00.000Z",
      idleExpiresAt: "2026-07-30T00:15:00.000Z",
      absoluteExpiresAt: "2026-07-30T08:00:00.000Z",
    }, 201));

    await createAdministratorSession("a-secure-bootstrap-token-with-more-than-32-characters");

    const [, options] = fetchMock.mock.calls[0]!;
    expect(options).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(new Headers(options?.headers).has("x-aihub-bootstrap-token")).toBe(false);
    expect(JSON.parse(String(options?.body))).toEqual({
      token: "a-secure-bootstrap-token-with-more-than-32-characters",
    });
  });

  it("uses the server session cookie for subsequent administration requests", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ items: [] }),
    );

    await getConnections();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/admin/connections",
      { credentials: "same-origin" },
    );
  });

  it("sends the optimistic active-revision guard when restoring configuration", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      connection: {
        id: "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d",
        slug: "litellm-primary",
        displayName: "LiteLLM Primary",
        kind: "LITELLM",
        environment: "PRODUCTION",
        baseUrl: "https://litellm.mpm.internal",
        enabled: true,
        status: "NOT_TESTED",
        configuration: {},
        activeRevision: 3,
        secretFieldNames: ["apiKey"],
        lastHealthcheckAt: null,
        lastHealthcheckMessage: null,
        updatedAt: "2026-07-30T00:00:00.000Z",
      },
      rolledBackFromRevision: 2,
      targetRevision: 1,
      createdRevision: 3,
      preservedSecretFields: ["apiKey"],
      message: "Configuration restored; active credentials were preserved.",
    }));

    await rollbackConfiguration("8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d", 1, 2);

    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/revisions/1/rollback");
    expect(options).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(JSON.parse(String(options?.body))).toEqual({ expectedActiveRevision: 2 });
  });

  it("turns a non-JSON gateway failure into an actionable API error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("upstream unavailable", { status: 502, statusText: "Bad Gateway" }),
    );

    await expect(getConnections()).rejects.toEqual(
      expect.objectContaining<Partial<AIHubApiError>>({
        name: "AIHubApiError",
        status: 502,
        message: "AIHub API returned 502 Bad Gateway",
      }),
    );
  });
});
