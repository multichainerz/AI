import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RuntimeNodeAuthenticationError } from "./runtime-node-manager.js";
import { liteLlmApiBaseUrl, verifyNodeRequestSignature } from "./prisma-runtime-node-manager.js";

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
}

describe("Hermes runtime-node signatures", () => {
  it("accepts a fresh Ed25519 signature and rejects tampering or stale requests", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const timestamp = "2026-07-30T12:00:00.000Z";
    const nonce = "b6b4dc94-bcfc-41c4-bbd2-5d8e3dbc3dac";
    const body = {
      status: "ONLINE",
      capabilities: ["gateway-api", "signed-heartbeat"],
      observedAt: timestamp,
      hermesVersion: "nousresearch/hermes-agent:latest",
    };
    const bodyDigest = createHash("sha256").update(canonicalize(body)).digest("hex");
    const signature = sign(null, Buffer.from(`${timestamp}\n${nonce}\n${bodyDigest}`), privateKey).toString("base64url");
    const headers = { timestamp, nonce, signature };
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();

    expect(() => verifyNodeRequestSignature(publicKeyPem, headers, body, new Date(timestamp).getTime())).not.toThrow();
    expect(() => verifyNodeRequestSignature(publicKeyPem, headers, { ...body, status: "DEGRADED" }, new Date(timestamp).getTime()))
      .toThrow(RuntimeNodeAuthenticationError);
    expect(() => verifyNodeRequestSignature(publicKeyPem, headers, body, new Date(timestamp).getTime() + 6 * 60_000))
      .toThrow("outside the allowed window");
    expect(() => verifyNodeRequestSignature(publicKeyPem, { ...headers, nonce: "not-a-uuid--------------------------" }, body, new Date(timestamp).getTime()))
      .toThrow(RuntimeNodeAuthenticationError);
  });
});

describe("Hermes LiteLLM bootstrap URL", () => {
  it("adds the OpenAI-compatible prefix without duplicating an existing prefix", () => {
    expect(liteLlmApiBaseUrl("https://litellm.internal", {})).toBe("https://litellm.internal/v1");
    expect(liteLlmApiBaseUrl("https://litellm.internal/v1", {})).toBe("https://litellm.internal/v1");
    expect(liteLlmApiBaseUrl("https://gateway.internal/litellm", { chatPath: "/v1/chat/completions" }))
      .toBe("https://gateway.internal/litellm/v1");
  });
});
