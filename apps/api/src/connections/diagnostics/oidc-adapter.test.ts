import { afterEach, describe, expect, it, vi } from "vitest";
import { OidcAdapter } from "./oidc-adapter.js";
import type { ResolvedConnection } from "./types.js";

const connection: ResolvedConnection = {
  id: "d8233908-bf42-4d72-b2dc-9dcaac226de6",
  activeRevision: 1,
  kind: "OIDC",
  baseUrl: "https://login.example.test",
  configuration: {},
  secrets: {},
};

afterEach(() => vi.unstubAllGlobals());

describe("OidcAdapter", () => {
  it("accepts a complete bounded discovery document", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      issuer: "https://login.example.test",
      authorization_endpoint: "https://login.example.test/authorize",
      token_endpoint: "https://login.example.test/token",
    }), { status: 200 })));

    await expect(new OidcAdapter().test(connection, new AbortController().signal))
      .resolves.toMatchObject({ status: "HEALTHY", details: { discoveryValid: true } });
  });

  it("rejects oversized discovery responses before parsing them", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", {
      status: 200,
      headers: { "content-length": "1000001" },
    })));

    await expect(new OidcAdapter().test(connection, new AbortController().signal))
      .resolves.toMatchObject({
        status: "DEGRADED",
        details: { discoveryValid: false, responseTooLarge: true },
      });
  });
});
