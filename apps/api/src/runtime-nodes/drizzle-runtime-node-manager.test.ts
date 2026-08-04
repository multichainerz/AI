import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  auditEvent,
  configurationRevision,
  createTestDatabase,
  hermesNodeEnrollment,
  hermesNodeRequestNonce,
  hermesRuntimeNode,
  localAdministrator,
  platformArchitectureDecision,
  secretRecord,
  serviceConnection,
  type TestDatabase,
} from "@orcasynapse/database";
import { EnvelopeEncryption } from "@orcasynapse/security";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AdminPrincipal } from "../auth/admin-session.js";
import {
  DrizzleHermesRuntimeNodeManager,
  inferenceGatewayBaseUrl,
  seedableInferenceModelAlias,
  verifyNodeRequestSignature,
} from "./drizzle-runtime-node-manager.js";
import {
  RuntimeNodeAuthenticationError,
  RuntimeNodeConflictError,
  RuntimeNodeEnrollmentError,
  RuntimeNodeNotFoundError,
} from "./runtime-node-manager.js";

let context: TestDatabase;

beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); });
beforeEach(async () => { await context.reset(); });

const encryption = new EnvelopeEncryption({ masterKey: new Uint8Array(32).fill(3) });
const principal = { id: randomUUID() } as AdminPrincipal;
const CONTROL_PLANE = "https://orcasynapse.example";

function manager() {
  return new DrizzleHermesRuntimeNodeManager(context.database, encryption);
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
}

/** Signs a request the way an enrolled VM2 node would. */
function signedHeaders(privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"], body: unknown) {
  const timestamp = new Date().toISOString();
  const nonce = randomUUID();
  const message = `${timestamp}\n${nonce}\n${createHash("sha256").update(canonicalize(body)).digest("hex")}`;
  return {
    timestamp,
    nonce,
    signature: sign(null, Buffer.from(message, "utf8"), privateKey).toString("base64url"),
  };
}

function nodeIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString() };
}

/** Satisfies both installer prerequisites: an admin and one healthy inference route. */
async function seedPrerequisites() {
  await context.database.insert(localAdministrator).values({
    username: "admin", displayName: "Local Administrator",
    passwordHash: "argon2id$placeholder", role: "PLATFORM_ADMIN", passwordChangeRequired: false,
  });
  await context.database.insert(serviceConnection).values({
    slug: `inference-${randomUUID().slice(0, 8)}`,
    displayName: "Inference", kind: "INFERENCE", environment: "DEVELOPMENT",
    enabled: true, status: "HEALTHY", baseUrl: "https://vllm.internal",
    configuration: { modelAlias: "hermes-agent" },
  });
}

function invitationInput(overrides: Record<string, unknown> = {}) {
  return {
    slug: "vm2",
    displayName: "Hermes VM2",
    baseUrl: "https://hermes.internal",
    controlPlaneUrl: CONTROL_PLANE,
    hermesImage: "ghcr.io/example/hermes:1.0.0",
    expiresInMinutes: 60,
    ...overrides,
  } as never;
}

function enrollInput(nodeId: string, token: string, publicKeyPem: string, overrides: Record<string, unknown> = {}) {
  return {
    nodeId,
    token,
    publicKeyPem,
    hostname: "vm2.internal",
    hermesVersion: "1.0.0",
    installerVersion: "ai-v1.21.8",
    capabilities: ["runs"],
    apiKey: "hermes-api-key",
    controlPlaneUrl: CONTROL_PLANE,
    ...overrides,
  } as never;
}

/** Takes a node all the way through invitation and enrollment. */
async function enrolledNode() {
  await seedPrerequisites();
  const invitation = await manager().createInvitation(principal, invitationInput());
  const identity = nodeIdentity();
  const result = await manager().enroll(
    enrollInput(invitation.bundle.nodeId, invitation.bundle.token, identity.publicKeyPem),
    "203.0.113.10",
  );
  return { ...result, identity, invitation };
}

describe("DrizzleHermesRuntimeNodeManager readiness", () => {
  it("is not ready until an administrator and one healthy inference route exist", async () => {
    expect(await manager().installerReadiness()).toMatchObject({
      dashboardReady: false, inferenceReady: false, ready: false, invitationReady: false,
    });

    await seedPrerequisites();

    expect(await manager().installerReadiness()).toMatchObject({
      dashboardReady: true, inferenceReady: true, ready: true, invitationReady: false,
    });
  });

  it("refuses an invitation while the prerequisites are unmet", async () => {
    await expect(manager().createInvitation(principal, invitationInput()))
      .rejects.toThrow(/dashboard administrator setup/);
  });

  it("treats two inference routes as ambiguous", async () => {
    await seedPrerequisites();
    await context.database.insert(serviceConnection).values({
      slug: `inference-${randomUUID().slice(0, 8)}`,
      displayName: "Second inference", kind: "INFERENCE", environment: "DEVELOPMENT",
      enabled: true, status: "HEALTHY", baseUrl: "https://vllm-2.internal",
      configuration: { modelAlias: "hermes-agent" },
    });

    expect(await manager().installerReadiness()).toMatchObject({ inferenceReady: false });
    await expect(manager().createInvitation(principal, invitationInput()))
      .rejects.toThrow(/exactly one healthy AI Inference route/);
  });
});

describe("DrizzleHermesRuntimeNodeManager invitations", () => {
  it("issues a claim and stores only its digest", async () => {
    await seedPrerequisites();

    const invitation = await manager().createInvitation(principal, invitationInput());

    expect(invitation.bundle.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [stored] = await context.database.select().from(hermesNodeEnrollment);
    expect(Buffer.from(stored!.tokenHash)).toEqual(createHash("sha256").update(invitation.bundle.token).digest());
    expect(stored?.status).toBe("ISSUED");
    expect(await manager().installerReadiness()).toMatchObject({ invitationReady: true });
  });

  it("revokes the previous claim when a new one is issued", async () => {
    await seedPrerequisites();
    const first = await manager().createInvitation(principal, invitationInput());
    const second = await manager().createInvitation(principal, invitationInput());

    const claims = await context.database.select().from(hermesNodeEnrollment);
    expect(claims).toHaveLength(2);
    expect(claims.filter(({ status }) => status === "ISSUED")).toHaveLength(1);
    // The retired claim can no longer be resolved.
    await expect(manager().resolveInvitation(first.bundle.token)).rejects.toThrow(/no longer active/);
    await expect(manager().resolveInvitation(second.bundle.token)).resolves.toMatchObject({ nodeSlug: "vm2" });
  });

  it("expires a claim on resolution rather than serving it", async () => {
    await seedPrerequisites();
    const invitation = await manager().createInvitation(principal, invitationInput());
    await context.database
      .update(hermesNodeEnrollment)
      .set({ expiresAt: new Date(Date.now() - 1_000) });

    await expect(manager().resolveInvitation(invitation.bundle.token))
      .rejects.toMatchObject({ code: "EXPIRED" });
    const [stored] = await context.database.select().from(hermesNodeEnrollment);
    expect(stored?.status).toBe("EXPIRED");
  });

  it("rejects an unknown claim", async () => {
    await expect(manager().resolveInvitation("z".repeat(43))).rejects.toMatchObject({ code: "INVALID" });
  });

  it("enforces the production artifact policy", async () => {
    await seedPrerequisites();
    await context.database
      .insert(platformArchitectureDecision)
      .values({ id: "global", targetEnvironment: "PRODUCTION" })
      .onConflictDoUpdate({ target: platformArchitectureDecision.id, set: { targetEnvironment: "PRODUCTION" } });

    await expect(manager().createInvitation(principal, invitationInput()))
      .rejects.toThrow(/digest-pinned Hermes image/);
    await expect(manager().createInvitation(principal, invitationInput({
      hermesImage: "ghcr.io/example/hermes@sha256:" + "a".repeat(64),
      controlPlaneUrl: "http://orcasynapse.example",
    }))).rejects.toThrow(/HTTPS OrcaSynapse origin/);
  });
});

describe("DrizzleHermesRuntimeNodeManager enrollment", () => {
  it("binds the node identity and provisions its managed Hermes connection", async () => {
    const { node, identity, modelBootstrap } = await enrolledNode();

    expect(node.identityFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(node.status).toBe("PENDING");
    expect(modelBootstrap).toMatchObject({
      provider: "custom",
      baseUrl: inferenceGatewayBaseUrl(CONTROL_PLANE),
      modelAlias: "hermes-agent",
    });
    // The gateway key the node receives is never the upstream inference key.
    expect(modelBootstrap.apiKey).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const [connection] = await context.database
      .select().from(serviceConnection).where(eq(serviceConnection.kind, "HERMES"));
    expect(connection).toMatchObject({ slug: "hermes-node-vm2", status: "NOT_TESTED", enabled: true });

    const secrets = await context.database
      .select().from(secretRecord).where(eq(secretRecord.serviceConnectionId, connection!.id));
    expect(secrets.map(({ fieldName }) => fieldName).sort()).toEqual(["apiKey", "inferenceGatewayKey"]);
    // Both credentials are envelope-encrypted at rest.
    for (const secret of secrets) {
      expect(Buffer.from(secret.encryptedValue).toString("utf8")).not.toContain("hermes-api-key");
      expect(Buffer.from(secret.encryptedValue).toString("utf8")).not.toContain(modelBootstrap.apiKey);
    }
    const revisions = await context.database
      .select().from(configurationRevision).where(eq(configurationRevision.serviceConnectionId, connection!.id));
    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.revision).toBe(1);
    expect(identity.publicKeyPem).toContain("BEGIN PUBLIC KEY");
  });

  it("consumes the claim so it cannot be enrolled twice", async () => {
    await seedPrerequisites();
    const invitation = await manager().createInvitation(principal, invitationInput());
    const identity = nodeIdentity();
    await manager().enroll(enrollInput(invitation.bundle.nodeId, invitation.bundle.token, identity.publicKeyPem));

    const [stored] = await context.database.select().from(hermesNodeEnrollment);
    expect(stored?.status).toBe("CONSUMED");
    await expect(manager().enroll(
      enrollInput(invitation.bundle.nodeId, invitation.bundle.token, nodeIdentity().publicKeyPem),
    )).rejects.toMatchObject({ code: "CONSUMED" });
  });

  it("refuses a hostname that does not match the invitation", async () => {
    await seedPrerequisites();
    const invitation = await manager().createInvitation(principal, invitationInput({ expectedHostname: "vm2.internal" }));

    await expect(manager().enroll(enrollInput(
      invitation.bundle.nodeId, invitation.bundle.token, nodeIdentity().publicKeyPem, { hostname: "impostor.internal" },
    ))).rejects.toMatchObject({ code: "HOSTNAME_MISMATCH" });
  });

  it("refuses a control-plane origin that does not match the invitation", async () => {
    await seedPrerequisites();
    const invitation = await manager().createInvitation(principal, invitationInput());

    await expect(manager().enroll(enrollInput(
      invitation.bundle.nodeId, invitation.bundle.token, nodeIdentity().publicKeyPem,
      { controlPlaneUrl: "https://attacker.example" },
    ))).rejects.toThrow(/control-plane origin does not match/);
  });

  it("refuses a key that is not Ed25519", async () => {
    await seedPrerequisites();
    const invitation = await manager().createInvitation(principal, invitationInput());
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });

    await expect(manager().enroll(enrollInput(
      invitation.bundle.nodeId, invitation.bundle.token,
      rsa.publicKey.export({ type: "spki", format: "pem" }).toString(),
    ))).rejects.toThrow(/Ed25519/);
  });

  it("allows only one enrolled runtime to hold the execution boundary", async () => {
    await enrolledNode();
    const second = await manager().createInvitation(principal, invitationInput({ slug: "vm3", displayName: "Hermes VM3" }));

    await expect(manager().enroll(enrollInput(
      second.bundle.nodeId, second.bundle.token, nodeIdentity().publicKeyPem,
    ))).rejects.toThrow(/already the active OrcaSynapse execution boundary/);
  });

  it("refuses to re-invite a node that is already enrolled", async () => {
    await enrolledNode();

    await expect(manager().createInvitation(principal, invitationInput()))
      .rejects.toThrow(/already enrolled/);
  });
});

describe("DrizzleHermesRuntimeNodeManager signed requests", () => {
  it("accepts a correctly signed heartbeat and stamps control-plane receipt time", async () => {
    const { node, identity } = await enrolledNode();
    const body = { status: "ONLINE", hermesVersion: "1.0.1", capabilities: ["runs"] };

    const result = await manager().heartbeat(node.id, signedHeaders(identity.privateKey, body), body as never);

    expect(result.accepted).toBe(true);
    const [stored] = await context.database
      .select().from(hermesRuntimeNode).where(eq(hermesRuntimeNode.id, node.id));
    expect(stored?.status).toBe("ONLINE");
    expect(stored?.hermesVersion).toBe("1.0.1");
    expect(stored?.lastSeenAt).not.toBeNull();
  });

  it("rejects a replayed nonce", async () => {
    const { node, identity } = await enrolledNode();
    const body = { status: "ONLINE", hermesVersion: "1.0.0", capabilities: [] };
    const headers = signedHeaders(identity.privateKey, body);

    await manager().heartbeat(node.id, headers, body as never);

    await expect(manager().heartbeat(node.id, headers, body as never))
      .rejects.toThrow(/replayed/);
    expect(await context.database.select().from(hermesNodeRequestNonce)).toHaveLength(1);
  });

  it("rejects a signature from a different key", async () => {
    const { node } = await enrolledNode();
    const body = { status: "ONLINE", hermesVersion: "1.0.0", capabilities: [] };

    await expect(manager().heartbeat(node.id, signedHeaders(nodeIdentity().privateKey, body), body as never))
      .rejects.toBeInstanceOf(RuntimeNodeAuthenticationError);
  });

  it("rejects a signature over a different body", async () => {
    const { node, identity } = await enrolledNode();
    const headers = signedHeaders(identity.privateKey, { status: "ONLINE", hermesVersion: "1.0.0", capabilities: [] });

    await expect(manager().heartbeat(
      node.id, headers, { status: "DEGRADED", hermesVersion: "9.9.9", capabilities: [] } as never,
    )).rejects.toBeInstanceOf(RuntimeNodeAuthenticationError);
  });

  it("keeps a draining node draining regardless of what it reports", async () => {
    const { node, identity } = await enrolledNode();
    await manager().mutate(principal, node.id, { action: "DRAIN", reason: "Maintenance", expectedRevision: node.revision } as never);
    const body = { status: "ONLINE", hermesVersion: "1.0.0", capabilities: [] };

    await manager().heartbeat(node.id, signedHeaders(identity.privateKey, body), body as never);

    const [stored] = await context.database
      .select().from(hermesRuntimeNode).where(eq(hermesRuntimeNode.id, node.id));
    expect(stored?.status).toBe("DRAINING");
  });

  it("refuses to authenticate a revoked node, after proving key possession", async () => {
    const { node, identity } = await enrolledNode();
    await manager().mutate(principal, node.id, { action: "REVOKE", reason: "Compromised", expectedRevision: node.revision } as never);
    const body = { status: "ONLINE", hermesVersion: "1.0.0", capabilities: [] };

    await expect(manager().heartbeat(node.id, signedHeaders(identity.privateKey, body), body as never))
      .rejects.toThrow(/revoked/);
  });
});

describe("DrizzleHermesRuntimeNodeManager lifecycle", () => {
  it("marks a node offline once its heartbeat goes stale", async () => {
    const { node, identity } = await enrolledNode();
    const body = { status: "ONLINE", hermesVersion: "1.0.0", capabilities: [] };
    await manager().heartbeat(node.id, signedHeaders(identity.privateKey, body), body as never);
    expect((await manager().list())[0]?.status).toBe("ONLINE");

    await context.database
      .update(hermesRuntimeNode)
      .set({ lastSeenAt: new Date(Date.now() - 600_000) })
      .where(eq(hermesRuntimeNode.id, node.id));

    expect((await manager().list())[0]?.status).toBe("OFFLINE");
  });

  it("refuses a mutation against a stale revision", async () => {
    const { node } = await enrolledNode();

    await expect(manager().mutate(principal, node.id, {
      action: "SUSPEND", reason: "x", expectedRevision: node.revision + 99,
    } as never)).rejects.toBeInstanceOf(RuntimeNodeConflictError);
    await expect(manager().mutate(principal, randomUUID(), {
      action: "SUSPEND", reason: "x", expectedRevision: 1,
    } as never)).rejects.toBeInstanceOf(RuntimeNodeNotFoundError);
  });

  it("disables the managed connections when a node is revoked", async () => {
    const { node } = await enrolledNode();

    const revoked = await manager().mutate(principal, node.id, {
      action: "REVOKE", reason: "Compromised", expectedRevision: node.revision,
    } as never);

    expect(revoked.status).toBe("REVOKED");
    expect(revoked.revokedAt).not.toBeNull();
    const [connection] = await context.database
      .select().from(serviceConnection).where(eq(serviceConnection.kind, "HERMES"));
    expect(connection).toMatchObject({ enabled: false, status: "DISABLED" });
    await expect(manager().mutate(principal, node.id, {
      action: "SUSPEND", reason: "x", expectedRevision: revoked.revision,
    } as never)).rejects.toThrow(/revoked runtime node cannot be changed/);
  });

  it("removes a revoked node and the connections its enrollment generated", async () => {
    const { node } = await enrolledNode();
    const revoked = await manager().mutate(principal, node.id, {
      action: "REVOKE", reason: "Decommissioned", expectedRevision: node.revision,
    } as never);

    await manager().remove(principal, node.id, {
      reason: "Host destroyed", confirmation: "vm2", expectedRevision: revoked.revision,
    } as never);

    expect(await context.database.select().from(hermesRuntimeNode)).toHaveLength(0);
    expect(await context.database
      .select().from(serviceConnection).where(eq(serviceConnection.kind, "HERMES"))).toHaveLength(0);
    // The inference route is not managed by the node and must survive.
    expect(await context.database
      .select().from(serviceConnection).where(eq(serviceConnection.kind, "INFERENCE"))).toHaveLength(1);
    const removal = (await context.database.select().from(auditEvent))
      .find(({ action }) => action === "hermes.node.removed");
    expect(removal?.metadata).toMatchObject({ removedConnections: 1, hostDestruction: "OPERATOR_ATTESTED" });
  });

  it("refuses removal without revocation, the exact revision, and the typed confirmation", async () => {
    const { node } = await enrolledNode();

    await expect(manager().remove(principal, node.id, {
      reason: "x", confirmation: "vm2", expectedRevision: node.revision,
    } as never)).rejects.toThrow(/Revoke the runtime node before/);

    const revoked = await manager().mutate(principal, node.id, {
      action: "REVOKE", reason: "x", expectedRevision: node.revision,
    } as never);
    await expect(manager().remove(principal, node.id, {
      reason: "x", confirmation: "vm2", expectedRevision: revoked.revision + 99,
    } as never)).rejects.toThrow(/changed before permanent removal/);
    await expect(manager().remove(principal, node.id, {
      reason: "x", confirmation: "wrong-slug", expectedRevision: revoked.revision,
    } as never)).rejects.toThrow(/to confirm permanent removal/);
  });
});

describe("runtime node pure helpers", () => {
  it("seeds a model alias only from exactly one usable inference route", () => {
    expect(seedableInferenceModelAlias([])).toBeNull();
    expect(seedableInferenceModelAlias([
      { baseUrl: "https://a", configuration: { modelAlias: "x" } },
      { baseUrl: "https://b", configuration: { modelAlias: "y" } },
    ])).toBeNull();
    expect(seedableInferenceModelAlias([{ baseUrl: null, configuration: { modelAlias: "x" } }])).toBeNull();
    expect(seedableInferenceModelAlias([{ baseUrl: "https://a", configuration: {} }])).toBeNull();
    expect(seedableInferenceModelAlias([{ baseUrl: "https://a", configuration: { modelAlias: " x " } }])).toBe("x");
  });

  it("points the runtime at the control plane's internal gateway path", () => {
    expect(inferenceGatewayBaseUrl("https://orcasynapse.example/dashboard?x=1"))
      .toBe("https://orcasynapse.example/internal/v1");
  });

  it("rejects a signature presented outside the clock-skew window", () => {
    const { privateKey, publicKeyPem } = nodeIdentity();
    const body = { status: "ONLINE" };
    const headers = signedHeaders(privateKey, body);

    expect(() => verifyNodeRequestSignature(publicKeyPem, headers, body)).not.toThrow();
    expect(() => verifyNodeRequestSignature(publicKeyPem, headers, body, Date.now() + 10 * 60 * 1_000))
      .toThrow(/timestamp is outside the allowed window/);
  });

  it("rejects a nonce that is not a UUID", () => {
    const { privateKey, publicKeyPem } = nodeIdentity();
    const body = { status: "ONLINE" };

    expect(() => verifyNodeRequestSignature(
      publicKeyPem, { ...signedHeaders(privateKey, body), nonce: "not-a-uuid" }, body,
    )).toBeInstanceOf(Function);
    expect(() => verifyNodeRequestSignature(
      publicKeyPem, { ...signedHeaders(privateKey, body), nonce: "not-a-uuid" }, body,
    )).toThrow(RuntimeNodeAuthenticationError);
  });
});
