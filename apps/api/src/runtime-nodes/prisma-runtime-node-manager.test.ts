import { createHash, generateKeyPairSync, sign } from "node:crypto";
import type { OrcaSynapsePrismaClient } from "@orcasynapse/database";
import { EnvelopeEncryption } from "@orcasynapse/security";
import { describe, expect, it, vi } from "vitest";
import type { AdminPrincipal } from "../auth/admin-session.js";
import { RuntimeNodeAuthenticationError, RuntimeNodeConflictError } from "./runtime-node-manager.js";
import {
  inferenceGatewayBaseUrl,
  PrismaHermesRuntimeNodeManager,
  seedableInferenceModelAlias,
  verifyNodeRequestSignature,
} from "./prisma-runtime-node-manager.js";

const principal: AdminPrincipal = {
  id: "ac369dab-cad5-4fd9-83ed-b4fbf528028a",
  subject: "admin",
  role: "PLATFORM_ADMIN",
  scopes: ["readiness:manage"],
  createdAt: "2026-08-02T00:00:00.000Z",
  idleExpiresAt: "2026-08-02T01:00:00.000Z",
  absoluteExpiresAt: "2026-08-02T08:00:00.000Z",
};

describe("Hermes runtime-node liveness reconciliation", () => {
  it("persists an expired heartbeat as offline before listing the node", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-03T00:10:00.000Z"));
    try {
      const updateMany = vi.fn(async () => ({ count: 1 }));
      const prisma = {
        hermesRuntimeNode: {
          updateMany,
          findMany: vi.fn(async () => [{
            id: "9de260d7-bc51-4558-9d20-06916d393072",
            slug: "hermes-runtime-01",
            displayName: "Hermes Runtime 01",
            baseUrl: "http://10.0.0.12:8642",
            expectedHostname: null,
            hostname: "hermes-01",
            status: "OFFLINE",
            identityFingerprint: "a".repeat(64),
            hermesVersion: "hermes@sha256:abc",
            installerVersion: "1.16.0",
            capabilities: [],
            serviceConnectionId: null,
            serviceConnection: null,
            lastSeenAt: new Date("2026-08-03T00:00:00.000Z"),
            enrolledAt: new Date("2026-08-03T00:00:00.000Z"),
            revokedAt: null,
            revision: 2,
            createdAt: new Date("2026-08-03T00:00:00.000Z"),
            updatedAt: new Date("2026-08-03T00:10:00.000Z"),
          }]),
        },
      } as unknown as OrcaSynapsePrismaClient;
      const manager = new PrismaHermesRuntimeNodeManager(
        prisma,
        new EnvelopeEncryption({ masterKey: new Uint8Array(32).fill(7) }),
      );

      await expect(manager.list()).resolves.toEqual([
        expect.objectContaining({ status: "OFFLINE", revision: 2 }),
      ]);
      expect(updateMany).toHaveBeenCalledWith({
        where: {
          status: { in: ["ONLINE", "DEGRADED"] },
          OR: [
            { lastSeenAt: null },
            { lastSeenAt: { lt: new Date("2026-08-03T00:07:00.000Z") } },
          ],
        },
        data: { status: "OFFLINE", revision: { increment: 1 } },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

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

  it("reveals inactive lifecycle state only after a valid enrolled identity signature", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const timestamp = new Date().toISOString();
    const nonce = "ca05dc91-d182-437b-b122-1e8a8270601d";
    const body = {
      observedAt: timestamp,
      status: "ONLINE" as const,
      hermesVersion: "nousresearch/hermes-agent:latest",
      capabilities: ["gateway-api", "signed-heartbeat"],
    };
    const bodyDigest = createHash("sha256").update(canonicalize(body)).digest("hex");
    const headers = {
      timestamp,
      nonce,
      signature: sign(null, Buffer.from(`${timestamp}\n${nonce}\n${bodyDigest}`), privateKey).toString("base64url"),
    };
    const prisma = {
      hermesRuntimeNode: {
        findUnique: async () => ({
          identityPublicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
          status: "REVOKED",
        }),
      },
    } as unknown as OrcaSynapsePrismaClient;
    const manager = new PrismaHermesRuntimeNodeManager(
      prisma,
      new EnvelopeEncryption({ masterKey: new Uint8Array(32).fill(7) }),
    );

    await expect(manager.heartbeat("9de260d7-bc51-4558-9d20-06916d393072", headers, body))
      .rejects.toThrow("The runtime node is revoked and is not allowed to authenticate.");
    await expect(manager.heartbeat("9de260d7-bc51-4558-9d20-06916d393072", {
      ...headers,
      signature: "invalid",
    }, body)).rejects.toThrow("The runtime node signature is invalid.");
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
  it("requires completed dashboard setup and one healthy served model while reporting invitation state separately", async () => {
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
        count: async () => 0,
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
      invitationReady: false,
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

describe("Hermes runtime-node permanent removal", () => {
  const revokedNode = {
    id: "9de260d7-bc51-4558-9d20-06916d393072",
    slug: "hermes-runtime-01",
    displayName: "Hermes Runtime 01",
    status: "REVOKED",
    revision: 7,
    serviceConnectionId: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
    identityFingerprint: "a".repeat(64),
  } as const;

  it("deletes the revoked node, cascaded enrollment state, and both generated connections in one transaction", async () => {
    const deleteNode = vi.fn(async () => ({ count: 1 }));
    const deleteConnections = vi.fn(async () => ({ count: 2 }));
    const createAudit = vi.fn(async () => ({}));
    const transaction = {
      hermesRuntimeNode: { deleteMany: deleteNode },
      serviceConnection: { deleteMany: deleteConnections },
      auditEvent: { create: createAudit },
    };
    const prisma = {
      hermesRuntimeNode: { findUnique: vi.fn(async () => revokedNode) },
      $transaction: vi.fn(async (callback: (client: typeof transaction) => Promise<void>) => callback(transaction)),
    } as unknown as OrcaSynapsePrismaClient;
    const manager = new PrismaHermesRuntimeNodeManager(
      prisma,
      new EnvelopeEncryption({ masterKey: new Uint8Array(32).fill(7) }),
    );

    await manager.remove(principal, revokedNode.id, {
      confirmation: revokedNode.slug,
      reason: "Host-side Agentic System purge completed.",
      expectedRevision: revokedNode.revision,
    });

    expect(deleteNode).toHaveBeenCalledWith({
      where: { id: revokedNode.id, status: "REVOKED", revision: revokedNode.revision },
    });
    expect(deleteConnections).toHaveBeenCalledWith({
      where: { OR: [
        { id: revokedNode.serviceConnectionId },
        { slug: "supermemory-node-hermes-runtime-01", kind: "SUPERMEMORY" },
      ] },
    });
    expect(createAudit).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ action: "hermes.node.removed", resourceId: revokedNode.id }),
    }));
  });

  it("refuses removal before revocation or when typed confirmation does not match", async () => {
    const transaction = vi.fn();
    const prisma = {
      hermesRuntimeNode: { findUnique: vi.fn(async () => ({ ...revokedNode, status: "OFFLINE" })) },
      $transaction: transaction,
    } as unknown as OrcaSynapsePrismaClient;
    const manager = new PrismaHermesRuntimeNodeManager(
      prisma,
      new EnvelopeEncryption({ masterKey: new Uint8Array(32).fill(7) }),
    );
    await expect(manager.remove(principal, revokedNode.id, {
      confirmation: revokedNode.slug,
      reason: "Host-side Agentic System purge completed.",
      expectedRevision: revokedNode.revision,
    })).rejects.toBeInstanceOf(RuntimeNodeConflictError);
    expect(transaction).not.toHaveBeenCalled();

    prisma.hermesRuntimeNode.findUnique = vi.fn(async () => revokedNode) as never;
    await expect(manager.remove(principal, revokedNode.id, {
      confirmation: "another-node",
      reason: "Host-side Agentic System purge completed.",
      expectedRevision: revokedNode.revision,
    })).rejects.toThrow(`Type '${revokedNode.slug}'`);
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("Hermes enrollment invitation binding", () => {
  it("rejects mutable Agentic System artifacts in Production before issuing a claim", async () => {
    const prisma = {
      localAdministrator: { count: vi.fn(async () => 1) },
      serviceConnection: { findMany: vi.fn(async () => [{
        baseUrl: "http://inference.internal:8000/v1", configuration: { modelAlias: "hermes-primary" },
      }]) },
      platformArchitectureDecision: { findUnique: vi.fn(async () => ({ targetEnvironment: "PRODUCTION" })) },
      $transaction: vi.fn(),
    } as unknown as OrcaSynapsePrismaClient;
    const manager = new PrismaHermesRuntimeNodeManager(
      prisma,
      new EnvelopeEncryption({ masterKey: new Uint8Array(32).fill(7) }),
    );

    await expect(manager.createInvitation(principal, {
      slug: "hermes-01",
      displayName: "Hermes 01",
      baseUrl: "http://10.0.0.12:8642",
      controlPlaneUrl: "https://orcasynapse.internal",
      hermesImage: "nousresearch/hermes-agent:latest",
      supermemoryVersion: "latest",
      expiresInMinutes: 30,
    })).rejects.toThrow("digest-pinned");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("resolves a live claim into the VM2 bootstrap profile without consuming it", async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const prisma = {
      hermesNodeEnrollment: {
        findUnique: async () => ({
          id: "12d67490-e502-4831-a2de-31d1bf4f1c36",
          status: "ISSUED",
          controlPlaneUrl: "https://orcasynapse.internal",
          hermesImage: "nousresearch/hermes-agent:latest",
          supermemoryVersion: "v1.2.3",
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
      supermemoryVersion: "v1.2.3",
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
      installerVersion: "v0.1.0",
      capabilities: ["gateway-api"],
    })).rejects.toMatchObject({
      code: "INVALID",
      message: "The enrollment control-plane origin does not match the invitation.",
    });
  });

  it("rechecks production artifact policy when a previously issued claim is enrolled", async () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const createConnection = vi.fn();
    const transaction = {
      $executeRaw: async () => 1,
      hermesNodeEnrollment: {
        findUnique: async () => ({
          id: "12d67490-e502-4831-a2de-31d1bf4f1c36",
          nodeId: "9de260d7-bc51-4558-9d20-06916d393072",
          controlPlaneUrl: "https://orcasynapse.internal",
          hermesImage: "nousresearch/hermes-agent:latest",
          supermemoryVersion: "latest",
          status: "ISSUED",
          expiresAt: new Date(Date.now() + 60_000),
          node: {
            id: "9de260d7-bc51-4558-9d20-06916d393072",
            slug: "hermes-01",
            displayName: "Hermes 01",
            baseUrl: "http://10.0.0.12:8642",
            expectedHostname: null,
          },
        }),
      },
      hermesRuntimeNode: { findFirst: async () => null },
      serviceConnection: {
        findMany: async () => [{
          baseUrl: "http://inference.internal:8000/v1",
          configuration: { modelAlias: "hermes-primary" },
        }],
        create: createConnection,
      },
      platformArchitectureDecision: { findUnique: async () => ({ targetEnvironment: "PRODUCTION" }) },
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
      controlPlaneUrl: "https://orcasynapse.internal",
      apiKey: "k".repeat(64),
      hermesVersion: "nousresearch/hermes-agent:latest",
      installerVersion: "v0.1.0",
      capabilities: ["gateway-api"],
    })).rejects.toMatchObject({ code: "INVALID", message: expect.stringContaining("digest-pinned") });
    expect(createConnection).not.toHaveBeenCalled();
  });
});
