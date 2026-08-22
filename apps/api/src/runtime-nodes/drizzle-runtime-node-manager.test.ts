import { createHash, generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  auditEvent,
  configurationRevision,
  controlPlaneSigningKey,
  createTestDatabase,
  hermesNodeEnrollment,
  hermesNodeRequestNonce,
  hermesRuntimeNode,
  localAdministrator,
  modelDeployment,
  platformArchitectureDecision,
  runtimeToolsetAdmission,
  secretRecord,
  serviceConnection,
  type TestDatabase,
} from "@orcasynapse/database";
import { EnvelopeEncryption } from "@orcasynapse/security";
import { DEFAULT_HERMES_COMMIT, runtimeDesiredStateDocumentSchema } from "@orcasynapse/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { canonicalize } from "../canonical-json.js";
import type { AdminPrincipal } from "../auth/admin-session.js";
import {
  DrizzleHermesRuntimeNodeManager,
  enrollmentArtifactViolation,
  inferenceGatewayBaseUrl,
  seedableInferenceModelAlias,
  verifyNodeRequestSignature,
} from "./drizzle-runtime-node-manager.js";
import {
  RuntimeNodeAuthenticationError,
  RuntimeNodeConflictError,
  RuntimeNodeNotFoundError,
} from "./runtime-node-manager.js";

let context: TestDatabase;

beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); }, 120_000);
beforeEach(async () => { await context.reset(); });

const encryption = new EnvelopeEncryption({ masterKey: new Uint8Array(32).fill(3) });
const principal = { id: randomUUID() } as AdminPrincipal;
const CONTROL_PLANE = "https://orcasynapse.example";

function manager() {
  return new DrizzleHermesRuntimeNodeManager(context.database, encryption, undefined);
}

/** Signs a request the way an enrolled VM2 node would. */
const HEARTBEAT = { method: "POST", path: "/api/v1/runtime-nodes/n/heartbeat" };
const heartbeatOf = (nodeId: string) => ({ method: "POST", path: `/api/v1/runtime-nodes/${nodeId}/heartbeat` });
const desiredStateOf = (nodeId: string) => ({ method: "GET", path: `/api/v1/runtime-nodes/${nodeId}/desired-state` });

function signedHeaders(
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  body: unknown,
  operation: { method: string; path: string } = HEARTBEAT,
) {
  const timestamp = new Date().toISOString();
  const nonce = randomUUID();
  const digest = createHash("sha256").update(canonicalize(body)).digest("hex");
  // Built independently of the implementation rather than by calling it, so a
  // change to the signed field order fails here instead of agreeing with itself.
  const message = `${operation.method}\n${operation.path}\n${timestamp}\n${nonce}\n${digest}`;
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

async function insertInference(overrides: Record<string, unknown> = {}): Promise<string> {
  const [connection] = await context.database.insert(serviceConnection).values({
    slug: `inference-${randomUUID().slice(0, 8)}`,
    displayName: "Inference",
    kind: "INFERENCE",
    environment: "DEVELOPMENT",
    enabled: true,
    status: "HEALTHY",
    baseUrl: "https://vllm.internal",
    configuration: {},
    ...overrides,
  } as never).returning({ id: serviceConnection.id });
  return connection!.id;
}

async function insertAgentRoute(connectionId: string, overrides: Record<string, unknown> = {}): Promise<void> {
  await context.database.insert(modelDeployment).values({
    connectionId,
    slug: `agent-${randomUUID().slice(0, 8)}`,
    displayName: "Agent model",
    workload: "AGENT",
    modelAlias: "hermes-agent",
    version: "1.0.0",
    contextWindowTokens: 131_072,
    maxOutputTokens: 8_192,
    maxConcurrentRequests: 2,
    status: "ACTIVE",
    isDefault: true,
    firstActivatedAt: new Date(),
    ...overrides,
  } as never);
}

/** Satisfies both installer prerequisites: an admin, one healthy inference route, and a default AGENT model. */
async function seedPrerequisites(options: {
  connectionModelAlias?: string | null;
  defaultAgentAlias?: string | null;
} = {}): Promise<{ connectionId: string }> {
  await context.database.insert(localAdministrator).values({
    username: "admin", displayName: "Local Administrator",
    passwordHash: "argon2id$placeholder", role: "PLATFORM_ADMIN", passwordChangeRequired: false,
  });
  const connectionId = await insertInference({
    configuration: options.connectionModelAlias === null
      ? {}
      : { modelAlias: options.connectionModelAlias ?? "hermes-agent" },
  });
  if (options.defaultAgentAlias !== null) {
    await insertAgentRoute(connectionId, {
      modelAlias: options.defaultAgentAlias ?? "hermes-agent",
    });
  }
  return { connectionId };
}

function invitationInput(overrides: Record<string, unknown> = {}) {
  return {
    slug: "vm2",
    displayName: "Hermes VM2",
    baseUrl: "https://hermes.internal",
    controlPlaneUrl: CONTROL_PLANE,
    hermesCommit: "c015663b215c0e14de4295346b0727db602cbb1d",
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
    installerVersion: "v1.21.8",
    capabilities: ["runs"],
    apiKey: "hermes-api-key",
    controlPlaneUrl: CONTROL_PLANE,
    ...overrides,
  } as never;
}

/** Takes a node all the way through invitation and enrollment. */
async function enrolledNode(
  invitationOverrides: Record<string, unknown> = {},
  enrollOverrides: Record<string, unknown> = {},
) {
  await seedPrerequisites();
  const invitation = await manager().createInvitation(principal, invitationInput(invitationOverrides));
  const identity = nodeIdentity();
  const result = await manager().enroll(
    enrollInput(invitation.bundle.nodeId, invitation.bundle.token, identity.publicKeyPem, enrollOverrides),
    "203.0.113.10",
  );
  return { ...result, identity, invitation };
}

/** The document bytes a node would verify, decoded the way the shell client does. */
function documentOf(state: { documentBase64: string }): Record<string, unknown> {
  return JSON.parse(Buffer.from(state.documentBase64, "base64").toString("utf8"));
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

  it("refuses enrolment without an ACTIVE default AGENT route even if the connection alias is set", async () => {
    await seedPrerequisites({ defaultAgentAlias: null });

    expect(await manager().installerReadiness()).toMatchObject({ inferenceReady: false, ready: false });
    await expect(manager().createInvitation(principal, invitationInput()))
      .rejects.toThrow(/Activate a default Agent model on Gateway → Models/);
  });

  it("is ready when the default AGENT route exists even if the connection alias is absent", async () => {
    await seedPrerequisites({ connectionModelAlias: null, defaultAgentAlias: "catalogue-agent" });

    expect(await manager().installerReadiness()).toMatchObject({ inferenceReady: true, ready: true });
  });

  it("refuses when the default AGENT route is on a different connection than the unique healthy inference", async () => {
    await seedPrerequisites({ defaultAgentAlias: null });
    const staleId = await insertInference({
      displayName: "Stale inference",
      enabled: false,
      status: "DISABLED",
      baseUrl: "https://vllm-old.internal",
    });
    await insertAgentRoute(staleId);

    expect(await manager().installerReadiness()).toMatchObject({ inferenceReady: false, ready: false });
    await expect(manager().createInvitation(principal, invitationInput()))
      .rejects.toThrow(/Activate a default Agent model on Gateway → Models/);
  });

  it("refuses a unique ACTIVE AGENT that is not the default", async () => {
    const { connectionId } = await seedPrerequisites({ defaultAgentAlias: null });
    await insertAgentRoute(connectionId, { isDefault: false });

    expect(await manager().installerReadiness()).toMatchObject({ inferenceReady: false, ready: false });
    await expect(manager().createInvitation(principal, invitationInput()))
      .rejects.toThrow(/Activate a default Agent model on Gateway → Models/);
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

    await expect(manager().createInvitation(principal, invitationInput({
      // Abbreviated: looks pinned, is not, and the contract's own validator
      // would refuse it -- this proves the gate refuses it too, so a caller
      // bypassing the schema cannot enrol an unpinned production node.
      hermesCommit: "c015663b215c0e14de4295346b0727db602cbb1d".slice(0, 12),
    }))).rejects.toThrow(/commit-pinned Hermes runtime/);
    await expect(manager().createInvitation(principal, invitationInput({
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

  it("seeds VM2 from the default AGENT route rather than the connection alias", async () => {
    await seedPrerequisites({ connectionModelAlias: "legacy-connection", defaultAgentAlias: "catalogue-agent" });
    const invitation = await manager().createInvitation(principal, invitationInput());
    const identity = nodeIdentity();
    const result = await manager().enroll(
      enrollInput(invitation.bundle.nodeId, invitation.bundle.token, identity.publicKeyPem),
      "203.0.113.10",
    );
    expect(result.modelBootstrap.modelAlias).toBe("catalogue-agent");
  });

  it("refuses enroll when the default AGENT route is not on the unique healthy inference", async () => {
    const { connectionId } = await seedPrerequisites();
    const invitation = await manager().createInvitation(principal, invitationInput());
    const identity = nodeIdentity();
    await context.database
      .update(serviceConnection)
      .set({ enabled: false, status: "DISABLED" })
      .where(eq(serviceConnection.id, connectionId));
    await insertInference({
      displayName: "Replacement inference",
      baseUrl: "https://vllm-new.internal",
    });

    await expect(manager().enroll(
      enrollInput(invitation.bundle.nodeId, invitation.bundle.token, identity.publicKeyPem),
      "203.0.113.10",
    )).rejects.toThrow(/Activate a default Agent model on Gateway → Models/);
  });

  it("seeds VM2 from the default AGENT route when the connection alias is absent", async () => {
    await seedPrerequisites({ connectionModelAlias: null, defaultAgentAlias: "catalogue-agent" });
    const invitation = await manager().createInvitation(principal, invitationInput());
    const identity = nodeIdentity();
    const result = await manager().enroll(
      enrollInput(invitation.bundle.nodeId, invitation.bundle.token, identity.publicKeyPem),
      "203.0.113.10",
    );
    expect(result.modelBootstrap.modelAlias).toBe("catalogue-agent");
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

describe("DrizzleHermesRuntimeNodeManager toolset admission at enrollment", () => {
  /*
   * A fresh deployment had an empty admission table, and the seeded default
   * tool set tracks admission rather than listing members -- so the profile
   * every install starts with was permitted nothing at all until an operator
   * admitted something by hand. Enrolment is the first moment there is anything
   * to say, which is why the approved baseline is seeded here.
   */
  async function admissions() {
    return context.database
      .select({ name: runtimeToolsetAdmission.toolsetName, admitted: runtimeToolsetAdmission.admitted })
      .from(runtimeToolsetAdmission)
      .orderBy(runtimeToolsetAdmission.toolsetName);
  }

  it("admits the approved baseline and nothing the node happens to report", async () => {
    /*
     * The assertion that inverted. This admitted every name the runtime
     * reported, which is not what the product promises: invariant 7 of
     * CURRENT_STATE_HANDOFF.md is "native toolsets are default-deny except
     * built-in memory and explicit operator admissions", and step 7 of the
     * enrolment runbook says the install admits "only the built-in `memory`
     * tool" while disabling "every other unapproved native toolset".
     *
     * Two things made the old behaviour worse than it reads. Enrolment happens
     * before the installer writes the managed policy, so the catalogue was stock
     * Hermes with its broad default preset; and `/v1/toolsets` is the complete
     * registry with an `enabled` flag that the reader typed away, so even a
     * disabled toolset was admitted on name alone. Those admissions then went
     * back out through `desiredState` to the node reconciler, which computes
     * suppression as everything-minus-admitted -- and so suppressed nothing.
     */
    await enrolledNode();

    expect(await admissions()).toEqual([
      { name: "file", admitted: true },
      { name: "memory", admitted: true },
      { name: "no_mcp", admitted: true },
    ]);
  });

  it("records one audit event naming what it admitted", async () => {
    const { node } = await enrolledNode();

    const [event] = await context.database
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.action, "tool.toolset_admitted_on_enrollment"));
    expect(event).toMatchObject({ actorType: "SERVICE", resourceId: node.id, outcome: "SUCCESS" });
    expect((event!.metadata as { toolsets: string[] }).toolsets.sort()).toEqual(["file", "memory", "no_mcp"]);
  });

  it("never re-admits a toolset an operator revoked", async () => {
    /*
     * The whole safety of doing this at enrolment. Re-enrolling is how a node
     * is upgraded, and an upgrade that silently restored a capability somebody
     * deliberately withdrew would be a governance failure, not a convenience.
     * A revoked baseline entry is the sharpest form of that.
     */
    await context.database.insert(runtimeToolsetAdmission).values({
      toolsetName: "memory", admitted: false, reason: "Refused by the security review.",
    });

    await enrolledNode();

    expect(await admissions()).toEqual([
      { name: "file", admitted: true },
      { name: "memory", admitted: false },
      { name: "no_mcp", admitted: true },
    ]);
  });

  it("seeds the baseline without needing to read the runtime at all", async () => {
    /*
     * The point of seeding a constant rather than a catalogue: it does not
     * depend on when the node is asked, or on what state the node is in when it
     * answers. There is no catalogue reader wired here.
     */
    await enrolledNode();

    expect(await admissions()).toEqual([
      { name: "file", admitted: true },
      { name: "memory", admitted: true },
      { name: "no_mcp", admitted: true },
    ]);
  });

  it("leaves everything outside the baseline unadmitted, so drift is still detectable", async () => {
    /*
     * Admission stays a decision per toolset: anything the node reports, at
     * enrolment or afterwards, has no row, is not admitted, and still fails the
     * boundary assertion on the run path. An operator widens the deployment
     * through the admission screen, which is the recorded and audited path.
     */
    await enrolledNode();

    const admitted = (await admissions()).map(({ name }) => name);
    expect(admitted).not.toContain("clarify");
    expect(admitted).not.toContain("web_search");
    expect(admitted).not.toContain("something_added_later");
  });
});

describe("DrizzleHermesRuntimeNodeManager signed requests", () => {
  it("accepts a correctly signed heartbeat and stamps control-plane receipt time", async () => {
    const { node, identity } = await enrolledNode();
    const body = { status: "ONLINE", hermesVersion: "1.0.1", capabilities: ["runs"] };

    const result = await manager().heartbeat(node.id, signedHeaders(identity.privateKey, body, heartbeatOf(node.id)), body as never);

    expect(result.accepted).toBe(true);
    const [stored] = await context.database
      .select().from(hermesRuntimeNode).where(eq(hermesRuntimeNode.id, node.id));
    expect(stored?.status).toBe("ONLINE");
    expect(stored?.hermesVersion).toBe("1.0.1");
    expect(stored?.lastSeenAt).not.toBeNull();
  });

  it("records the node's systemd units when it reports them", async () => {
    const { node, identity } = await enrolledNode();
    const units = [
      { name: "orcasynapse-hermes.service", active: true, enabled: true },
      { name: "orcasynapse-hermes-corpus.timer", active: false, enabled: true },
    ];
    const body = { status: "ONLINE", hermesVersion: "1.0.1", capabilities: [], units };

    await manager().heartbeat(node.id, signedHeaders(identity.privateKey, body, heartbeatOf(node.id)), body as never);

    const [stored] = await context.database
      .select().from(hermesRuntimeNode).where(eq(hermesRuntimeNode.id, node.id));
    expect(stored?.units).toEqual(units);
    const [summary] = (await manager().list()).filter(({ id }) => id === node.id);
    expect(summary?.units).toEqual(units);
  });

  /*
   * A node whose installer predates the field omits it on every beat. Writing
   * null each time would be harmless for that node, but it also means a node
   * that reported once and was then downgraded would keep a list describing
   * units it is no longer speaking for. Absent has to leave the column alone,
   * and the only way to see the difference is to report and then stop.
   */
  it("leaves a previously reported unit list alone when a later heartbeat omits it", async () => {
    const { node, identity } = await enrolledNode();
    const units = [{ name: "orcasynapse-hermes.service", active: true, enabled: true }];
    const first = { status: "ONLINE", hermesVersion: "1.0.1", capabilities: [], units };
    await manager().heartbeat(node.id, signedHeaders(identity.privateKey, first, heartbeatOf(node.id)), first as never);

    const second = { status: "ONLINE", hermesVersion: "1.0.2", capabilities: [] };
    await manager().heartbeat(node.id, signedHeaders(identity.privateKey, second, heartbeatOf(node.id)), second as never);

    const [stored] = await context.database
      .select().from(hermesRuntimeNode).where(eq(hermesRuntimeNode.id, node.id));
    expect(stored?.hermesVersion).toBe("1.0.2");
    expect(stored?.units).toEqual(units);
  });

  it("reports a node that has never sent units as unknown rather than healthy", async () => {
    const { node, identity } = await enrolledNode();
    const body = { status: "ONLINE", hermesVersion: "1.0.1", capabilities: [] };

    await manager().heartbeat(node.id, signedHeaders(identity.privateKey, body, heartbeatOf(node.id)), body as never);

    const [summary] = (await manager().list()).filter(({ id }) => id === node.id);
    // Null, not []. An empty array is a claim that the node has no units.
    expect(summary?.units).toBeNull();
  });

  it("rejects a replayed nonce", async () => {
    const { node, identity } = await enrolledNode();
    const body = { status: "ONLINE", hermesVersion: "1.0.0", capabilities: [] };
    const headers = signedHeaders(identity.privateKey, body, heartbeatOf(node.id));

    await manager().heartbeat(node.id, headers, body as never);

    await expect(manager().heartbeat(node.id, headers, body as never))
      .rejects.toThrow(/replayed/);
    expect(await context.database.select().from(hermesNodeRequestNonce)).toHaveLength(1);
  });

  it("rejects a signature from a different key", async () => {
    const { node } = await enrolledNode();
    const body = { status: "ONLINE", hermesVersion: "1.0.0", capabilities: [] };

    await expect(manager().heartbeat(node.id, signedHeaders(nodeIdentity().privateKey, body, heartbeatOf(node.id)), body as never))
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

    await manager().heartbeat(node.id, signedHeaders(identity.privateKey, body, heartbeatOf(node.id)), body as never);

    const [stored] = await context.database
      .select().from(hermesRuntimeNode).where(eq(hermesRuntimeNode.id, node.id));
    expect(stored?.status).toBe("DRAINING");
  });

  it("refuses to authenticate a revoked node, after proving key possession", async () => {
    const { node, identity } = await enrolledNode();
    await manager().mutate(principal, node.id, { action: "REVOKE", reason: "Compromised", expectedRevision: node.revision } as never);
    const body = { status: "ONLINE", hermesVersion: "1.0.0", capabilities: [] };

    await expect(manager().heartbeat(node.id, signedHeaders(identity.privateKey, body, heartbeatOf(node.id)), body as never))
      .rejects.toThrow(/revoked/);
  });
});

describe("DrizzleHermesRuntimeNodeManager lifecycle", () => {
  it("marks a node offline once its heartbeat goes stale", async () => {
    const { node, identity } = await enrolledNode();
    const body = { status: "ONLINE", hermesVersion: "1.0.0", capabilities: [] };
    await manager().heartbeat(node.id, signedHeaders(identity.privateKey, body, heartbeatOf(node.id)), body as never);
    expect((await manager().list())[0]?.status).toBe("ONLINE");

    await context.database
      .update(hermesRuntimeNode)
      .set({ lastSeenAt: new Date(Date.now() - 600_000) })
      .where(eq(hermesRuntimeNode.id, node.id));

    expect((await manager().list())[0]?.status).toBe("OFFLINE");
    expect((await context.database.select().from(auditEvent)).map(({ action }) => action))
      .toContain("hermes.node.marked_offline");
  });

  it("keeps an operator's pending action valid across a heartbeat", async () => {
    // `revision` is the optimistic-concurrency token for operator actions, and
    // a node heartbeats every minute. When the heartbeat bumped it too, any
    // dashboard tab open longer than that had a stale revision and its first
    // action failed 409 -- including the emergency revoke of a compromised
    // node. Liveness is not an operator edit and must not consume the token.
    const { node, identity } = await enrolledNode();
    const body = { status: "ONLINE", hermesVersion: "1.0.1", capabilities: ["runs"] };

    await manager().heartbeat(node.id, signedHeaders(identity.privateKey, body, heartbeatOf(node.id)), body as never);

    const [afterHeartbeat] = await context.database
      .select().from(hermesRuntimeNode).where(eq(hermesRuntimeNode.id, node.id));
    expect(afterHeartbeat?.revision).toBe(node.revision);
    expect(afterHeartbeat?.lastSeenAt).not.toBeNull();

    // The revision the operator's screen captured before the heartbeat still works.
    const revoked = await manager().mutate(principal, node.id, {
      action: "REVOKE", reason: "compromised host", expectedRevision: node.revision,
    } as never);
    expect(revoked.status).toBe("REVOKED");
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
  /*
   * Enrollment hands VM2 a one-time claim, the Hermes API key and a minted
   * inference gateway key, and the dashboard prints an installer command that
   * pipes an unauthenticated, unsigned script from this origin into `sudo bash`.
   * Over plain HTTP that is root on VM2 for anyone on the path. Only PRODUCTION
   * used to be refused, which left the weakest deployments handing out root.
   */
  it("requires HTTPS for enrollment on every target, not only production", () => {
    const pinned = { hermesCommit: "a".repeat(40) };

    for (const target of ["DEVELOPMENT", "PILOT", "PRODUCTION"] as const) {
      expect(
        enrollmentArtifactViolation(target, { ...pinned, controlPlaneUrl: "http://vm1.internal" }),
        `${target} must refuse a plain-HTTP origin`,
      ).toMatch(/requires an HTTPS OrcaSynapse origin/);
      expect(enrollmentArtifactViolation(target, { ...pinned, controlPlaneUrl: "https://vm1.internal" })).toBeNull();
    }
  });

  it("still allows a loopback origin, which has no network path to sit on", () => {
    const pinned = { hermesCommit: "a".repeat(40) };

    expect(enrollmentArtifactViolation("DEVELOPMENT", { ...pinned, controlPlaneUrl: "http://localhost:8080" })).toBeNull();
    expect(enrollmentArtifactViolation("DEVELOPMENT", { ...pinned, controlPlaneUrl: "http://127.0.0.1:8080" })).toBeNull();
    // A host that merely starts with the same characters is not loopback.
    expect(enrollmentArtifactViolation("DEVELOPMENT", { ...pinned, controlPlaneUrl: "http://localhost.evil.example" }))
      .toMatch(/requires an HTTPS OrcaSynapse origin/);
    expect(enrollmentArtifactViolation("DEVELOPMENT", { ...pinned, controlPlaneUrl: "http://127.0.0.1.evil.example" }))
      .toMatch(/requires an HTTPS OrcaSynapse origin/);
  });

  /*
   * A control plane behind a tunnel or Zero Trust front has a public origin
   * that refuses every machine — Access wants an identity Hermes cannot hold —
   * so the node channel runs direct over the private network, where the edge's
   * TLS cannot follow. The allowance is by literal RFC 1918 IP only: a private
   * *name* is a DNS answer, and DNS is what an on-path attacker controls.
   */
  it("allows a private-network IP below production, for tunnel-fronted control planes", () => {
    const pinned = { hermesCommit: "a".repeat(40) };

    for (const target of ["DEVELOPMENT", "PILOT"] as const) {
      expect(enrollmentArtifactViolation(target, { ...pinned, controlPlaneUrl: "http://10.0.0.160:8080" })).toBeNull();
      expect(enrollmentArtifactViolation(target, { ...pinned, controlPlaneUrl: "http://192.168.1.20:8080" })).toBeNull();
      expect(enrollmentArtifactViolation(target, { ...pinned, controlPlaneUrl: "http://172.31.4.9:8080" })).toBeNull();
    }
    // Production still refuses plain HTTP everywhere: it terminates TLS where
    // the machines can reach it, or it does not enroll.
    expect(enrollmentArtifactViolation("PRODUCTION", { ...pinned, controlPlaneUrl: "http://10.0.0.160:8080" }))
      .toMatch(/requires an HTTPS OrcaSynapse origin/);
    // Names never qualify, and neither do public IPs or 172.x outside 16-31.
    expect(enrollmentArtifactViolation("DEVELOPMENT", { ...pinned, controlPlaneUrl: "http://vm1.internal:8080" }))
      .toMatch(/requires an HTTPS OrcaSynapse origin/);
    expect(enrollmentArtifactViolation("DEVELOPMENT", { ...pinned, controlPlaneUrl: "http://172.32.0.1:8080" }))
      .toMatch(/requires an HTTPS OrcaSynapse origin/);
    expect(enrollmentArtifactViolation("DEVELOPMENT", { ...pinned, controlPlaneUrl: "http://8.8.8.8:8080" }))
      .toMatch(/requires an HTTPS OrcaSynapse origin/);
  });

  it("keeps the production commit pin on top of the transport rule", () => {
    expect(enrollmentArtifactViolation("PRODUCTION", { hermesCommit: "short", controlPlaneUrl: "https://vm1.internal" }))
      .toMatch(/commit-pinned Hermes runtime/);
    expect(enrollmentArtifactViolation("DEVELOPMENT", { hermesCommit: "short", controlPlaneUrl: "https://vm1.internal" }))
      .toBeNull();
  });

  it("seeds a model alias only from one healthy endpoint and one default AGENT route", () => {
    const route = (connectionId: string, modelAlias = "x") => ({ connectionId, modelAlias });
    expect(seedableInferenceModelAlias([], [route("a")])).toBeNull();
    expect(seedableInferenceModelAlias([
      { id: "a", baseUrl: "https://a" },
      { id: "b", baseUrl: "https://b" },
    ], [route("a")])).toBeNull();
    expect(seedableInferenceModelAlias([{ id: "a", baseUrl: null }], [route("a")])).toBeNull();
    expect(seedableInferenceModelAlias([{ id: "a", baseUrl: "https://a" }], [])).toBeNull();
    expect(seedableInferenceModelAlias([{ id: "a", baseUrl: "https://a" }], [route("a"), route("a", "y")])).toBeNull();
    expect(seedableInferenceModelAlias([{ id: "a", baseUrl: "https://a" }], [route("b")])).toBeNull();
    expect(seedableInferenceModelAlias([{ id: "a", baseUrl: "https://a" }], [{ connectionId: "a", modelAlias: " x " }])).toBe("x");
    expect(seedableInferenceModelAlias(
      [{ id: "openrouter", baseUrl: "https://openrouter.ai" }],
      [{ connectionId: "openrouter", modelAlias: "anthropic/claude-sonnet-4" }],
    )).toBe("anthropic/claude-sonnet-4");
  });

  it("points the runtime at the control plane's internal gateway path", () => {
    expect(inferenceGatewayBaseUrl("https://orcasynapse.example/dashboard?x=1"))
      .toBe("https://orcasynapse.example/internal/v1");
  });

  it("rejects a signature presented outside the clock-skew window", () => {
    const { privateKey, publicKeyPem } = nodeIdentity();
    const body = { status: "ONLINE" };
    const headers = signedHeaders(privateKey, body);

    expect(() => verifyNodeRequestSignature(publicKeyPem, HEARTBEAT, headers, body)).not.toThrow();
    expect(() => verifyNodeRequestSignature(publicKeyPem, HEARTBEAT, headers, body, Date.now() + 10 * 60 * 1_000))
      .toThrow(/timestamp is outside the allowed window/);
  });

  it("rejects a nonce that is not a UUID", () => {
    const { privateKey, publicKeyPem } = nodeIdentity();
    const body = { status: "ONLINE" };

    expect(() => verifyNodeRequestSignature(
      publicKeyPem, HEARTBEAT, { ...signedHeaders(privateKey, body), nonce: "not-a-uuid" }, body,
    )).toBeInstanceOf(Function);
    expect(() => verifyNodeRequestSignature(
      publicKeyPem, HEARTBEAT, { ...signedHeaders(privateKey, body), nonce: "not-a-uuid" }, body,
    )).toThrow(RuntimeNodeAuthenticationError);
  });

  /*
   * The two desired-state polls — this module's and the corpus plane's — both
   * authenticate over a literal `null`, so before the signature bound the path
   * a triple captured from one was byte-valid on the other. Replayed against
   * the corpus endpoint it leased the next queued mutation, returned its full
   * content, and marked it DISPATCHED.
   */
  it("refuses a signature minted for a different endpoint or a different method", () => {
    const { privateKey, publicKeyPem } = nodeIdentity();
    const runtimeDesiredState = { method: "GET", path: "/api/v1/runtime-nodes/n/desired-state" };
    const corpusDesiredState = { method: "GET", path: "/api/v1/runtime-nodes/n/corpus/desired-state" };
    const headers = signedHeaders(privateKey, null, runtimeDesiredState);

    expect(() => verifyNodeRequestSignature(publicKeyPem, runtimeDesiredState, headers, null)).not.toThrow();
    expect(() => verifyNodeRequestSignature(publicKeyPem, corpusDesiredState, headers, null))
      .toThrow(RuntimeNodeAuthenticationError);
    expect(() => verifyNodeRequestSignature(
      publicKeyPem, { ...runtimeDesiredState, method: "POST" }, headers, null,
    )).toThrow(RuntimeNodeAuthenticationError);
  });

  describe("signed desired state", () => {
    it("serves a document the node can verify with the key it was given at enrollment", async () => {
      const { node, identity } = await enrolledNode();
      await context.database.insert(runtimeToolsetAdmission).values({
        toolsetName: "clarify", admitted: true, reason: "Safe to enable.",
      });

      const state = await manager().desiredState(node.id, signedHeaders(identity.privateKey, null, desiredStateOf(node.id)));
      const { publicKeyPem } = await manager().controlPlanePublicKey();
      const bytes = Buffer.from(state.documentBase64, "base64");

      // The node verifies over exactly the bytes it received, then parses.
      expect(verify(null, bytes, publicKeyPem, Buffer.from(state.signature, "base64"))).toBe(true);
      expect(JSON.parse(bytes.toString("utf8"))).toMatchObject({
        format: "orcasynapse-runtime-desired-state/v1",
        nodeId: node.id,
        // The enrolment baseline is always present; `clarify` is this test's
        // own operator admission on top of it.
        admittedToolsets: ["clarify", "file", "memory", "no_mcp"],
      });
    });

    it("states the admission set explicitly rather than omitting it", async () => {
      /*
       * The list is an instruction, so it is always stated: a node that received
       * no list must not be free to keep whatever it already had running. On a
       * fresh enrolment that instruction is the approved baseline and nothing
       * else -- which is also the assertion that the node is told to suppress
       * everything outside it, since the reconciler computes suppression as
       * everything minus this.
       */
      const { node, identity } = await enrolledNode();
      const state = await manager().desiredState(node.id, signedHeaders(identity.privateKey, null, desiredStateOf(node.id)));
      const document = JSON.parse(Buffer.from(state.documentBase64, "base64").toString("utf8"));
      expect(Object.hasOwn(document, "admittedToolsets")).toBe(true);
      expect(document.admittedToolsets).toEqual(["file", "memory", "no_mcp"]);
    });

    it("omits a toolset whose admission was revoked", async () => {
      const { node, identity } = await enrolledNode();
      await context.database.insert(runtimeToolsetAdmission).values([
        { toolsetName: "clarify", admitted: true, reason: "Safe to enable." },
        { toolsetName: "code_execution", admitted: false, reason: "Withdrawn." },
      ]);
      const state = await manager().desiredState(node.id, signedHeaders(identity.privateKey, null, desiredStateOf(node.id)));
      const document = JSON.parse(Buffer.from(state.documentBase64, "base64").toString("utf8"));
      expect(document.admittedToolsets).toEqual(["clarify", "file", "memory", "no_mcp"]);
      expect(document.admittedToolsets).not.toContain("code_execution");
    });

    /*
     * The commit in this document is a commit of the *Hermes runtime*, not of
     * OrcaSynapse. `PlatformReleaseTarget.desiredCommit` is the release VM1
     * should run and has no business here: emitting it would tell VM2 to
     * install this repository as though it were Hermes.
     */
    it("names the Hermes commit this node was enrolled at, not a global default", async () => {
      const pinned = "9f".repeat(20);
      expect(pinned).not.toBe(DEFAULT_HERMES_COMMIT);
      const { node, identity } = await enrolledNode({ hermesCommit: pinned });

      const state = await manager().desiredState(node.id, signedHeaders(identity.privateKey, null, desiredStateOf(node.id)));
      const document = documentOf(state);

      expect(document.hermesCommit).toBe(pinned);
      // Parsed through the contract the node's client is written against, so a
      // document this manager can produce but no node can accept fails here.
      expect(runtimeDesiredStateDocumentSchema.parse(document).hermesCommit).toBe(pinned);
    });

    it("does not move a node whose enrolment recorded no commit", async () => {
      // Enrolments predating the pin column carry no target. Answering with the
      // release default would silently upgrade a node nobody asked to move, so
      // the document echoes what the node itself last reported running.
      const running = "3c".repeat(20);
      const { node, identity } = await enrolledNode({}, { hermesVersion: running });
      await context.database
        .update(hermesNodeEnrollment)
        .set({ hermesCommit: null })
        .where(eq(hermesNodeEnrollment.nodeId, node.id));

      const state = await manager().desiredState(node.id, signedHeaders(identity.privateKey, null, desiredStateOf(node.id)));

      expect(documentOf(state).hermesCommit).toBe(running);
    });

    it("falls back to the release's own Hermes commit only when nothing else is known", async () => {
      // Neither a recorded pin nor a resolvable reported version: the node said
      // "unknown" at enrolment. This is the one case with no node-specific
      // answer, and the document must still carry a real installable commit.
      const { node, identity } = await enrolledNode({}, { hermesVersion: "unknown" });
      await context.database
        .update(hermesNodeEnrollment)
        .set({ hermesCommit: null })
        .where(eq(hermesNodeEnrollment.nodeId, node.id));

      const state = await manager().desiredState(node.id, signedHeaders(identity.privateKey, null, desiredStateOf(node.id)));

      expect(documentOf(state).hermesCommit).toBe(DEFAULT_HERMES_COMMIT);
    });

    it("reports the same expected commit on the fleet list as it serves to the node", async () => {
      // The dashboard's drift indicator compares the reported version against
      // this value. If the two paths disagreed the screen would show drift a
      // node was never asked to close, or hide one it was.
      const pinned = "7a".repeat(20);
      const { node, identity } = await enrolledNode({ hermesCommit: pinned });

      const [listed] = await manager().list();
      const state = await manager().desiredState(node.id, signedHeaders(identity.privateKey, null, desiredStateOf(node.id)));

      expect(listed?.expectedHermesCommit).toBe(pinned);
      expect(listed?.expectedHermesCommit).toBe(documentOf(state).hermesCommit);
      expect(listed?.controlPlaneUrl).toBe(CONTROL_PLANE);
    });

    it("reports no expected commit rather than a guess when none was recorded", async () => {
      const { node } = await enrolledNode();
      await context.database
        .update(hermesNodeEnrollment)
        .set({ hermesCommit: null })
        .where(eq(hermesNodeEnrollment.nodeId, node.id));

      const [listed] = await manager().list();

      expect(listed?.expectedHermesCommit).toBeNull();
    });

    it("refuses to tell an unauthenticated caller what a node should run", async () => {
      const { node } = await enrolledNode();
      await expect(manager().desiredState(node.id, signedHeaders(nodeIdentity().privateKey, null, desiredStateOf(node.id))))
        .rejects.toBeInstanceOf(RuntimeNodeAuthenticationError);
    });

    it("keeps one signing identity across calls and instances", async () => {
      // Nodes pin the key at enrollment, so a second API instance generating
      // its own would make every previously enrolled node reject the document.
      const first = await manager().controlPlanePublicKey();
      const second = await manager().controlPlanePublicKey();
      expect(second.publicKeyPem).toBe(first.publicKeyPem);
      expect(second.fingerprint).toBe(first.fingerprint);
      expect(await context.database.select().from(controlPlaneSigningKey)).toHaveLength(1);
    });

    it("never stores the private half in the clear", async () => {
      await manager().controlPlanePublicKey();
      const [row] = await context.database.select().from(controlPlaneSigningKey);
      const sealed = Buffer.from(row!.encryptedValue).toString("utf8");
      expect(sealed).not.toContain("PRIVATE KEY");
      expect(row!.publicKeyPem).toContain("PUBLIC KEY");
    });
  });
});
