import { createHash, generateKeyPairSync, sign } from "node:crypto";
import type { OrcaSynapsePrismaClient } from "@orcasynapse/database";
import { EnvelopeEncryption } from "@orcasynapse/security";
import { describe, expect, it } from "vitest";
import { RuntimeNodeAuthenticationError } from "./runtime-node-manager.js";
import {
  inferenceGatewayBaseUrl,
  PrismaHermesRuntimeNodeManager,
  seedableInferenceModelAlias,
  verifyNodeRequestSignature,
} from "./prisma-runtime-node-manager.js";

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

describe("Hermes inference bootstrap URL", () => {
  it("adds the OpenAI-compatible prefix to the bound control-plane origin", () => {
    expect(inferenceGatewayBaseUrl("https://orcasynapse.internal")).toBe("https://orcasynapse.internal/internal/v1");
    expect(inferenceGatewayBaseUrl("https://gateway.internal/"))
      .toBe("https://gateway.internal/internal/v1");
  });

  it("selects only one healthy connection with a concrete dashboard model alias", () => {
    expect(seedableInferenceModelAlias([{
      baseUrl: "http://inference.internal:8000/v1",
      configuration: { modelAlias: "  hermes-primary  " },
    }])).toBe("hermes-primary");
    expect(seedableInferenceModelAlias([{
      baseUrl: "http://inference.internal:8000/v1",
      configuration: { modelAlias: "" },
    }])).toBeNull();
    expect(seedableInferenceModelAlias([
      { baseUrl: "http://inference-a.internal:8000/v1", configuration: { modelAlias: "a" } },
      { baseUrl: "http://inference-b.internal:8000/v1", configuration: { modelAlias: "b" } },
    ])).toBeNull();
  });
});

describe("Agentic System installer readiness", () => {
  it("requires completed dashboard setup, one healthy served model, and a live invitation", async () => {
    const prisma = {
      localAdministrator: {
        count: async () => 1,
      },
      serviceConnection: {
        findMany: async () => [{
          baseUrl: "http://inference.internal:8000/v1",
          configuration: { modelAlias: "hermes-primary" },
        }],
      },
      hermesNodeEnrollment: {
        count: async () => 1,
      },
    } as unknown as OrcaSynapsePrismaClient;
    const manager = new PrismaHermesRuntimeNodeManager(
      prisma,
      new EnvelopeEncryption({ masterKey: new Uint8Array(32).fill(7) }),
    );

    await expect(manager.installerReadiness()).resolves.toEqual({
      ready: true,
      dashboardReady: true,
      inferenceReady: true,
      invitationReady: true,
    });
  });

  it("does not treat a healthy endpoint without a selected model as seedable inference", async () => {
    const prisma = {
      localAdministrator: {
        count: async () => 1,
      },
      serviceConnection: {
        findMany: async () => [{
          baseUrl: "http://inference.internal:8000/v1",
          configuration: {},
        }],
      },
      hermesNodeEnrollment: {
        count: async () => 1,
      },
    } as unknown as OrcaSynapsePrismaClient;
    const manager = new PrismaHermesRuntimeNodeManager(
      prisma,
      new EnvelopeEncryption({ masterKey: new Uint8Array(32).fill(7) }),
    );

    await expect(manager.installerReadiness()).resolves.toMatchObject({
      ready: false,
      dashboardReady: true,
      inferenceReady: false,
      invitationReady: true,
    });
  });
});

describe("Hermes enrollment invitation binding", () => {
  it("resolves a live claim into the VM2 bootstrap profile without consuming it", async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const prisma = {
      hermesNodeEnrollment: {
        findUnique: async () => ({
          id: "12d67490-e502-4831-a2de-31d1bf4f1c36",
          status: "ISSUED",
          controlPlaneUrl: "https://orcasynapse.internal",
          hermesImage: "nousresearch/hermes-agent:latest",
          expiresAt,
          node: {
            id: "9de260d7-bc51-4558-9d20-06916d393072",
            slug: "hermes-01",
            baseUrl: "http://10.0.0.12:8642",
          },
        }),
      },
    } as unknown as OrcaSynapsePrismaClient;
    const manager = new PrismaHermesRuntimeNodeManager(
      prisma,
      new EnvelopeEncryption({ masterKey: new Uint8Array(32).fill(7) }),
    );

    await expect(manager.resolveInvitation("t".repeat(43))).resolves.toEqual({
      format: "orcasynapse-hermes-enrollment/v1",
      nodeId: "9de260d7-bc51-4558-9d20-06916d393072",
      nodeSlug: "hermes-01",
      token: "t".repeat(43),
      controlPlaneUrl: "https://orcasynapse.internal",
      hermesBaseUrl: "http://10.0.0.12:8642",
      hermesImage: "nousresearch/hermes-agent:latest",
      expiresAt: expiresAt.toISOString(),
    });
  });

  it("rejects a control-plane origin that differs from the issued invitation before creating credentials", async () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const transaction = {
      $executeRaw: async () => 1,
      hermesNodeEnrollment: {
        findUnique: async () => ({
          nodeId: "9de260d7-bc51-4558-9d20-06916d393072",
          controlPlaneUrl: "https://orcasynapse.internal",
          status: "ISSUED",
          expiresAt: new Date(Date.now() + 60_000),
          node: { expectedHostname: null },
        }),
      },
      serviceConnection: { create: async () => { throw new Error("must not create a connection"); } },
    };
    const prisma = {
      $transaction: async (callback: (client: typeof transaction) => Promise<unknown>) => callback(transaction),
    } as unknown as OrcaSynapsePrismaClient;
    const manager = new PrismaHermesRuntimeNodeManager(
      prisma,
      new EnvelopeEncryption({ masterKey: new Uint8Array(32).fill(7) }),
    );

    await expect(manager.enroll({
      nodeId: "9de260d7-bc51-4558-9d20-06916d393072",
      token: "t".repeat(43),
      hostname: "hermes-01.internal",
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      controlPlaneUrl: "https://attacker.internal",
      apiKey: "k".repeat(64),
      hermesVersion: "nousresearch/hermes-agent:latest",
      installerVersion: "ai-v1.7.0",
      capabilities: ["gateway-api"],
    })).rejects.toMatchObject({
      code: "INVALID",
      message: "The enrollment control-plane origin does not match the invitation.",
    });
  });
});
