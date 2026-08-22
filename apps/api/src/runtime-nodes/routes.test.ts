import {
  ADMIN_SCOPES,
  type AdministratorSession,
  type HermesRuntimeNode,
} from "@orcasynapse/contracts";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { ADMIN_SESSION_COOKIE, type AdminSessionManager } from "../auth/admin-session.js";
import { RuntimeNodeAuthenticationError, type HermesRuntimeNodeManager } from "./runtime-node-manager.js";

const TOKEN = "n".repeat(43);
const ADMIN_ID = "ac369dab-cad5-4fd9-83ed-b4fbf528028a";
const NODE_ID = "9de260d7-bc51-4558-9d20-06916d393072";
const NOW = "2026-07-30T00:00:00.000Z";
// Generated rather than hard-coded: the contract requires a real Ed25519 SPKI
// PEM, and a literal would silently rot if the key format ever changed.
const CONTROL_PLANE_PUBLIC_KEY = generateKeyPairSync("ed25519")
  .publicKey.export({ type: "spki", format: "pem" }).toString();

const session: AdministratorSession = {
  id: ADMIN_ID, subject: "runtime-admin", role: "PLATFORM_ADMIN", scopes: [...ADMIN_SCOPES],
  createdAt: NOW, idleExpiresAt: "2026-07-30T00:15:00.000Z", absoluteExpiresAt: "2026-07-30T08:00:00.000Z",
};

const node: HermesRuntimeNode = {
  id: NODE_ID,
  slug: "hermes-runtime-01",
  displayName: "Hermes Runtime 01",
  baseUrl: "http://10.0.0.12:8642",
  expectedHostname: null,
  hostname: null,
  status: "PENDING",
  identityFingerprint: null,
  hermesVersion: null,
  expectedHermesCommit: "c015663b215c0e14de4295346b0727db602cbb1d",
  installerVersion: null,
  capabilities: [],
  units: null,
  serviceConnectionId: null,
  serviceConnectionStatus: null,
  lastSeenAt: null,
  enrolledAt: null,
  revokedAt: null,
  revision: 0,
  controlPlaneUrl: "https://orcasynapse.internal",
  createdAt: NOW,
  updatedAt: NOW,
};

class Sessions implements AdminSessionManager {
  async createInstallationKeySession() { return null; }
  async authenticate(token: string | undefined) { return token === TOKEN ? session : null; }
  async revoke() { return true; }
}

function manager(): HermesRuntimeNodeManager {
  return {
    list: vi.fn(async () => [node]),
    installerReadiness: vi.fn(async () => ({
      ready: true,
      dashboardReady: true,
      inferenceReady: true,
      invitationReady: true,
    })),
    createInvitation: vi.fn(async (_principal, input) => ({
      node,
      bundle: {
        format: "orcasynapse-hermes-enrollment/v1" as const,
        nodeId: NODE_ID,
        nodeSlug: node.slug,
        token: "t".repeat(43),
        controlPlaneUrl: input.controlPlaneUrl,
        hermesBaseUrl: input.baseUrl,
        hermesCommit: input.hermesCommit,
        expiresAt: "2026-07-30T00:30:00.000Z",
      },
    })),
    resolveInvitation: vi.fn(async (token) => ({
      format: "orcasynapse-hermes-enrollment/v1" as const,
      nodeId: NODE_ID,
      nodeSlug: node.slug,
      token,
      controlPlaneUrl: "https://orcasynapse.internal",
      hermesBaseUrl: node.baseUrl,
      hermesCommit: "c015663b215c0e14de4295346b0727db602cbb1d",
      expiresAt: "2026-07-30T00:30:00.000Z",
    })),
    enroll: vi.fn(async () => ({
      node: { ...node, hostname: "hermes-01.internal", enrolledAt: NOW, identityFingerprint: "a".repeat(64) },
      heartbeatPath: `/api/v1/runtime-nodes/${NODE_ID}/heartbeat`,
      controlPlanePublicKeyPem: CONTROL_PLANE_PUBLIC_KEY,
      desiredStatePath: `/api/v1/runtime-nodes/${NODE_ID}/desired-state`,
      modelBootstrap: { provider: "custom" as const, baseUrl: "https://orcasynapse.internal/internal/v1", modelAlias: "hermes-agent", apiKey: "g".repeat(64) },
    })),
    heartbeat: vi.fn(async () => ({ accepted: true as const, serverTime: NOW })),
    desiredState: vi.fn(async () => ({
      documentBase64: Buffer.from(JSON.stringify({
        format: "orcasynapse-runtime-desired-state/v1", nodeId: NODE_ID,
        generatedAt: NOW, admittedToolsets: ["clarify"],
      }), "utf8").toString("base64"),
      signature: "c".repeat(86),
      publicKeyFingerprint: "d".repeat(64),
    })),
    mutate: vi.fn(async () => ({ ...node, status: "DRAINING" as const, revision: 1 })),
    remove: vi.fn(async () => undefined),
  };
}

/** What node-postgres raises when a non-UUID string reaches a `uuid` column. */
function malformedUuid(): Error {
  return Object.assign(new Error(`invalid input syntax for type uuid: "not-a-uuid"`), { code: "22P02" });
}

const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

async function testApp(runtimeNodeManager = manager()) {
  const app = await createApp({
    logger: false,
    runtime: { bootstrapState: "READY", sessionManager: new Sessions(), runtimeNodeManager },
  });
  apps.push(app);
  return { app, runtimeNodeManager };
}

describe("Hermes runtime-node routes", () => {
  it("serves the VM2 installer after dashboard and inference readiness so enrollment can resume", async () => {
    const runtimeNodeManager = manager();
    const { app } = await testApp(runtimeNodeManager);
    const ready = await app.inject({ method: "GET", url: "/install/agentic-node.sh" });
    expect(ready.statusCode, ready.body).toBe(200);
    expect(ready.headers["content-type"]).toContain("text/x-shellscript");
    expect(ready.headers["cache-control"]).toBe("no-store");
    expect(ready.headers["content-disposition"]).toBe("inline; filename=install-agentic-node.sh");
    expect(ready.body).toContain("#!/usr/bin/env bash");
    expect(ready.body).toContain("write_file_from_stdin()");
    expect(ready.body).toContain("allow_lazy_installs: false");
    expect(ready.body).toContain("native-sessions");
    expect(ready.body).toContain("corpus-sync-v1");
    expect(ready.body).toContain('CORPUS_SERVICE="orcasynapse-hermes-corpus"');
    expect(ready.body).toContain('systemctl enable --now "${CORPUS_SERVICE}.timer"');
    expect(ready.body).toContain("/install/hermes-corpus-reconciler.py");
    expect(ready.body).toContain("-in \"${message_file}\"");
    // A trust mismatch must still name the identity this VM2 actually holds,
    // so an operator can compare it against the dashboard record.
    expect(ready.body).toContain("VM1 rejected the enrolled VM2 identity ${node_fingerprint}");
    expect(ready.body).not.toContain("/dev/stdin");
    expect((await app.inject({ method: "GET", url: "/install/hermes-node.sh" })).statusCode).toBe(404);
    const corpusReconciler = await app.inject({ method: "GET", url: "/install/hermes-corpus-reconciler.py" });
    expect(corpusReconciler.statusCode, corpusReconciler.body).toBe(200);
    expect(corpusReconciler.headers["content-type"]).toContain("text/x-python");
    expect(corpusReconciler.headers["cache-control"]).toBe("no-store");
    expect(corpusReconciler.body).toContain("orcasynapse-hermes-corpus-snapshot/v1");
    expect(corpusReconciler.body).toContain("apply_skill_pending");
    const operatorCli = await app.inject({ method: "GET", url: "/install/orcasynapse-agent" });
    expect(operatorCli.statusCode, operatorCli.body).toBe(200);
    expect(operatorCli.headers["content-disposition"]).toBe("inline; filename=orcasynapse-agent");
    expect(operatorCli.headers["cache-control"]).toBe("no-store");
    expect(operatorCli.body).toContain("orcasynapse-agent-cli/v1");
    // The maintenance arm, pinned: a CLI that drifted to --connect would refuse
    // to run on every enrolled node it is installed on.
    expect(operatorCli.body).toContain("bash -s -- --repair");
    const operatorCliDigest = await app.inject({ method: "GET", url: "/install/orcasynapse-agent.sha256" });
    expect(operatorCliDigest.statusCode).toBe(200);
    expect(operatorCliDigest.body).toMatch(/^[0-9a-f]{64}\n$/);
    const remover = await app.inject({ method: "GET", url: "/install/remove-agentic-node.sh" });
    expect(remover.statusCode, remover.body).toBe(200);
    expect(remover.headers["content-disposition"]).toBe("inline; filename=remove-agentic-node.sh");
    expect(remover.body).toContain("VM2 SECURE DECOMMISSION");
    expect(remover.body).toContain("Type %bDESTROY%b to continue");
    // The purge is irreversible, so the remover proves the unit it is about to
    // destroy is ours before touching it.
    expect(remover.body).toContain("validate_service_ownership");
    expect(remover.body).toContain('rm -rf --one-file-system -- "${STATE_ROOT}"');
    expect(remover.body).not.toMatch(/docker system prune|apt(?:-get)? remove|rm -rf \/(?:\s|$)/);
    // What the route serves must be the systemd installer, not a stale Docker
    // one: the served script is the only copy an operator ever runs. Comments
    // are stripped first so the assertion binds to what executes, leaving prose
    // free to explain what the unit replaced.
    expect(ready.body).toContain("orcasynapse-hermes.service");
    const executedInstaller = ready.body
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");
    expect(executedInstaller).not.toMatch(/\bdocker\b/);

    // Enrolment still refuses at createInvitation when Models is not seedable.
    // The download must not: `--repair` on an enrolled node is this same URL.
    for (const state of [
      { ready: false, dashboardReady: false, inferenceReady: true, invitationReady: true },
      { ready: false, dashboardReady: true, inferenceReady: false, invitationReady: true },
    ] as const) {
      runtimeNodeManager.installerReadiness = vi.fn(async () => state);
      const served = await app.inject({ method: "GET", url: "/install/agentic-node.sh" });
      expect(served.statusCode, served.body).toBe(200);
      expect(served.body).toContain("#!/usr/bin/env bash");
      expect(runtimeNodeManager.installerReadiness).not.toHaveBeenCalled();
      expect((await app.inject({ method: "GET", url: "/install/remove-agentic-node.sh" })).statusCode).toBe(200);
    }
  });

  it("requires a protected admin session and forwards explicit permanent-removal confirmation", async () => {
    const { app, runtimeNodeManager } = await testApp();
    const payload = {
      confirmation: node.slug,
      reason: "VM2 host purge completed by the platform administrator.",
      expectedRevision: 4,
    };
    expect((await app.inject({ method: "DELETE", url: `/api/v1/admin/runtime-nodes/${NODE_ID}`, payload })).statusCode)
      .toBe(401);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/runtime-nodes/${NODE_ID}`,
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${TOKEN}` },
      payload,
    });
    expect(removed.statusCode, removed.body).toBe(204);
    expect(runtimeNodeManager.remove).toHaveBeenCalledWith(
      expect.objectContaining({ id: ADMIN_ID }),
      NODE_ID,
      payload,
    );
  });

  it("carries the commit the control plane expects through to the fleet list", async () => {
    // The dashboard's drift indicator compares this against the version the
    // node reports. The response schema is strict, so a field the manager
    // produces but the contract does not carry is a 500 here rather than a
    // silently missing column on the screen.
    const { app } = await testApp();
    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/admin/runtime-nodes/",
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${TOKEN}` },
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().items[0]).toMatchObject({
      expectedHermesCommit: "c015663b215c0e14de4295346b0727db602cbb1d",
      controlPlaneUrl: "https://orcasynapse.internal",
    });
  });

  it("protects fleet administration while allowing one-time node enrollment", async () => {
    const { app, runtimeNodeManager } = await testApp();
    expect((await app.inject({ method: "GET", url: "/api/v1/admin/runtime-nodes/" })).statusCode).toBe(401);
    const invitation = await app.inject({
      method: "POST",
      url: "/api/v1/admin/runtime-nodes/invitations",
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${TOKEN}` },
      payload: {
        slug: "hermes-runtime-01",
        displayName: "Hermes Runtime 01",
        baseUrl: "http://10.0.0.12:8642",
        controlPlaneUrl: "https://orcasynapse.internal",
        hermesCommit: "c015663b215c0e14de4295346b0727db602cbb1d",
        expiresInMinutes: 30,
      },
    });
    expect(invitation.statusCode).toBe(201);
    expect(invitation.json()).toMatchObject({ bundle: { format: "orcasynapse-hermes-enrollment/v1", token: "t".repeat(43) } });
    expect(runtimeNodeManager.createInvitation).toHaveBeenCalledWith(
      expect.objectContaining({ id: ADMIN_ID }),
      expect.objectContaining({ slug: node.slug, hermesCommit: "c015663b215c0e14de4295346b0727db602cbb1d" }),
    );

    const bootstrap = await app.inject({
      method: "POST",
      url: "/api/v1/runtime-nodes/bootstrap",
      payload: { token: "t".repeat(43) },
    });
    expect(bootstrap.statusCode, bootstrap.body).toBe(200);
    expect(bootstrap.json()).toMatchObject({ nodeId: NODE_ID, controlPlaneUrl: "https://orcasynapse.internal" });
    expect(runtimeNodeManager.resolveInvitation).toHaveBeenCalledWith("t".repeat(43));

    const enrollment = await app.inject({
      method: "POST",
      url: "/api/v1/runtime-nodes/enroll",
      payload: {
        nodeId: NODE_ID,
        token: "t".repeat(43),
        hostname: "hermes-01.internal",
        publicKeyPem: `-----BEGIN PUBLIC KEY-----\n${"A".repeat(80)}\n-----END PUBLIC KEY-----`,
        controlPlaneUrl: "https://orcasynapse.internal",
        apiKey: "k".repeat(64),
        hermesVersion: "c015663b215c0e14de4295346b0727db602cbb1d",
        installerVersion: "v1.70.0",
        capabilities: ["gateway-api"],
      },
    });
    expect(enrollment.statusCode).toBe(200);
    expect(runtimeNodeManager.enroll).toHaveBeenCalledWith(expect.objectContaining({ nodeId: NODE_ID }), "127.0.0.1");
  });

  it("maps invalid signed heartbeats to a stable authentication response", async () => {
    const runtimeNodeManager = manager();
    runtimeNodeManager.heartbeat = vi.fn(async () => { throw new RuntimeNodeAuthenticationError(); });
    const { app } = await testApp(runtimeNodeManager);
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/runtime-nodes/${NODE_ID}/heartbeat`,
      headers: {
        "x-orcasynapse-node-timestamp": NOW,
        "x-orcasynapse-node-nonce": "b6b4dc94-bcfc-41c4-bbd2-5d8e3dbc3dac",
        "x-orcasynapse-node-signature": "invalid",
      },
      payload: { observedAt: NOW, status: "ONLINE", hermesVersion: "0.1.0", capabilities: [] },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "INVALID_NODE_SIGNATURE" });
  });

  it("fails closed on a malformed node id instead of reaching the database", async () => {
    // The body was schema-validated; the path parameter was not. A non-UUID
    // reached a `uuid` column, PostgreSQL raised 22P02, and sendError's rethrow
    // turned it into a 500 with an error log — on routes that take no
    // credentials, so anyone could drive both. Every other bad-credential path
    // here answers 401, and so must this.
    const runtimeNodeManager = manager();
    const { app } = await testApp(runtimeNodeManager);
    for (const badId of ["not-a-uuid", "1", "'; select 1--", `${NODE_ID}x`]) {
      const heartbeat = await app.inject({
        method: "POST",
        url: `/api/v1/runtime-nodes/${encodeURIComponent(badId)}/heartbeat`,
        headers: {
          "x-orcasynapse-node-timestamp": NOW,
          "x-orcasynapse-node-nonce": "b6b4dc94-bcfc-41c4-bbd2-5d8e3dbc3dac",
          "x-orcasynapse-node-signature": "invalid",
        },
        payload: { observedAt: NOW, status: "ONLINE", hermesVersion: "0.1.0", capabilities: [] },
      });
      expect(heartbeat.statusCode, `heartbeat with id ${badId}`).toBe(401);

      const desired = await app.inject({
        method: "GET",
        url: `/api/v1/runtime-nodes/${encodeURIComponent(badId)}/desired-state`,
        headers: {
          "x-orcasynapse-node-timestamp": NOW,
          "x-orcasynapse-node-nonce": "b6b4dc94-bcfc-41c4-bbd2-5d8e3dbc3dac",
          "x-orcasynapse-node-signature": "invalid",
        },
      });
      expect(desired.statusCode, `desired-state with id ${badId}`).toBe(401);
    }
    // Refused before the manager is consulted at all.
    expect(runtimeNodeManager.heartbeat).not.toHaveBeenCalled();
    expect(runtimeNodeManager.desiredState).not.toHaveBeenCalled();
  });

  it("fails closed on a malformed node id on the administrator routes too", async () => {
    // The same unvalidated path parameter, on the two routes the guard above
    // was never wired into. Here the caller holds a valid session, so the
    // answer is 400 rather than the unauthenticated routes' 401: their id
    // arrives with a signature and a bad one is a failed credential, while an
    // administrator with a mistyped id has a bad request and needs to be told
    // that rather than that their session is not recognised.
    const runtimeNodeManager = manager();
    runtimeNodeManager.mutate = vi.fn(async () => { throw malformedUuid(); });
    runtimeNodeManager.remove = vi.fn(async () => { throw malformedUuid(); });
    const { app } = await testApp(runtimeNodeManager);
    const headers = { cookie: `${ADMIN_SESSION_COOKIE}=${TOKEN}` };

    for (const badId of ["not-a-uuid", "1", "'; select 1--", `${NODE_ID}x`]) {
      const action = await app.inject({
        method: "POST",
        url: `/api/v1/admin/runtime-nodes/${encodeURIComponent(badId)}/actions`,
        headers,
        payload: { action: "DRAIN", reason: "Draining for maintenance on the runtime host.", expectedRevision: 0 },
      });
      expect(action.statusCode, `action with id ${badId}`).toBe(400);
      expect(action.json()).toMatchObject({ error: "INVALID_NODE_ACTION" });

      const removal = await app.inject({
        method: "DELETE",
        url: `/api/v1/admin/runtime-nodes/${encodeURIComponent(badId)}`,
        headers,
        payload: { confirmation: node.slug, reason: "VM2 host purge completed by the platform administrator.", expectedRevision: 0 },
      });
      expect(removal.statusCode, `removal with id ${badId}`).toBe(400);
      expect(removal.json()).toMatchObject({ error: "INVALID_NODE_REMOVAL" });
    }
    expect(runtimeNodeManager.mutate).not.toHaveBeenCalled();
    expect(runtimeNodeManager.remove).not.toHaveBeenCalled();
  });
});
