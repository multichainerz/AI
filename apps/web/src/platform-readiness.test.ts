import type {
  AgentProfile,
  AgentRuntimeControl,
  HermesRuntimeNode,
  ServiceConnectionSummary,
  ServiceKind,
} from "@orcasynapse/contracts";
import { describe, expect, it } from "vitest";
import { deriveHermesReadiness, deriveWorkspaceReadiness } from "./platform-readiness.js";

function connection(kind: ServiceKind, overrides: Partial<ServiceConnectionSummary> = {}): ServiceConnectionSummary {
  return {
    id: `${kind.toLowerCase()}-connection`,
    kind,
    displayName: kind,
    slug: kind.toLowerCase(),
    baseUrl: `http://${kind.toLowerCase()}.internal`,
    environment: "DEVELOPMENT",
    enabled: true,
    status: "HEALTHY",
    // A served model on the inference connection, because that is what the
    // enrolment seed reads: a fixture that stops at HEALTHY describes a
    // deployment the API would still refuse.
    configuration: kind === "INFERENCE" ? { modelAlias: "laguna-s" } : {},
    secretFieldNames: [],
    activeRevision: 1,
    lastHealthcheckAt: "2026-08-03T00:00:00.000Z",
    lastHealthcheckMessage: "Healthy",
    updatedAt: "2026-08-03T00:00:00.000Z",
    ...overrides,
  };
}

const runtime = { enabled: true } as AgentRuntimeControl;
/**
 * A node that beat a moment ago.
 *
 * `lastSeenAt` is not decoration here: the API demotes an ONLINE node to
 * OFFLINE once its last heartbeat is older than `NODE_STALE_AFTER_MS`, so a
 * fixture carrying ONLINE without a recent beat is a payload the server would
 * never send.
 */
const onlineNode = { status: "ONLINE", revokedAt: null, lastSeenAt: new Date().toISOString() } as HermesRuntimeNode;
const activeProfile = { status: "ACTIVE" } as AgentProfile;

describe("deriveHermesReadiness", () => {
  /*
   * Revoking a node keeps its connection row and only disables it, so a
   * revoke-and-replace leaves two HERMES rows behind. The lookup this replaced
   * took whichever sorted first by display name; when that was the retired one,
   * the dashboard read chatReady: false permanently while a healthy replacement
   * node sat online beside it.
   */
  it("ignores the disabled connection a revoked node leaves behind", () => {
    const retired = connection("HERMES", {
      id: "hermes-01", displayName: "Hermes Runtime 01", enabled: false, status: "DISABLED",
    });
    const replacement = connection("HERMES", { id: "hermes-02", displayName: "Hermes Runtime 02" });

    expect(deriveHermesReadiness([retired, replacement]).ready).toBe(true);
    // Order must not decide it, so the reversed list has to agree.
    expect(deriveHermesReadiness([replacement, retired]).ready).toBe(true);
  });

  it("refuses two live runtimes rather than picking one", () => {
    const first = connection("HERMES", { id: "hermes-01", displayName: "Hermes Runtime 01" });
    const second = connection("HERMES", { id: "hermes-02", displayName: "Hermes Runtime 02" });

    expect(deriveHermesReadiness([first, second]).ready).toBe(false);
    expect(deriveHermesReadiness([]).ready).toBe(false);
    expect(deriveHermesReadiness([first]).ready).toBe(true);
  });

  it("still requires the surviving connection to be healthy", () => {
    expect(deriveHermesReadiness([connection("HERMES", { status: "UNREACHABLE" })]).ready).toBe(false);
    expect(deriveHermesReadiness([connection("HERMES", { enabled: false })]).ready).toBe(false);
  });
});

describe("deriveWorkspaceReadiness", () => {
  it("requires enabled healthy services rather than stale health evidence", () => {
    const readiness = deriveWorkspaceReadiness({
      connections: [connection("INFERENCE", { enabled: false }), connection("HERMES")],
      runtimeNodes: [onlineNode],
      profiles: [activeProfile],
      runtime,
    });

    expect(readiness.chatReady).toBe(false);
    expect(readiness.nextChatStep).toMatchObject({ target: "Deployment", title: "Connect AI Inference" });
  });

  it("treats a usable Chat path as a ready agentic workspace", () => {
    const readiness = deriveWorkspaceReadiness({
      connections: [connection("INFERENCE"), connection("HERMES")],
      runtimeNodes: [onlineNode],
      profiles: [activeProfile],
      runtime,
    });

    expect(readiness.chatReady).toBe(true);
    expect(readiness.agenticReady).toBe(true);
    expect(readiness.nextChatStep).toBeNull();
  });

  it("routes the only remaining first-run action to Profiles", () => {
    const readiness = deriveWorkspaceReadiness({
      connections: [connection("INFERENCE"), connection("HERMES")],
      runtimeNodes: [onlineNode],
      profiles: [],
      runtime: { enabled: false } as AgentRuntimeControl,
    });

    expect(readiness.agenticInfrastructureReady).toBe(true);
    expect(readiness.nextChatStep).toMatchObject({ target: "Agents", title: "Create an Agent Profile" });
  });

  it("requires the served model the enrolment seed reads, not a healthy endpoint alone", () => {
    /*
     * `seedableInferenceModelAlias` (drizzle-runtime-node-manager.ts:94-104)
     * returns null without a non-empty `configuration.modelAlias`. A Dashboard
     * that stops at HEALTHY reported "3/3 ready, Open Session" on a deployment
     * whose Setup screen was simultaneously reporting "0 of 3, blocked".
     */
    const readiness = deriveWorkspaceReadiness({
      connections: [
        connection("INFERENCE", { configuration: {} as ServiceConnectionSummary["configuration"] }),
        connection("HERMES"),
      ],
      runtimeNodes: [onlineNode],
      profiles: [activeProfile],
      runtime,
    });

    expect(readiness.inferenceReady).toBe(false);
    expect(readiness.chatReady).toBe(false);
    expect(readiness.nextChatStep).toMatchObject({ target: "Deployment", title: "Connect AI Inference" });
  });

  it("counts the healthy inference connections the way the enrolment seed does", () => {
    // `connections.length !== 1` returns null, so a second healthy endpoint
    // removes the ability to enrol rather than adding redundancy. Taking the
    // first match by kind hid that entirely.
    const readiness = deriveWorkspaceReadiness({
      connections: [
        connection("INFERENCE"),
        connection("INFERENCE", { id: "spare-inference", displayName: "Spare inference" }),
        connection("HERMES"),
      ],
      runtimeNodes: [onlineNode],
      profiles: [activeProfile],
      runtime,
    });

    expect(readiness.inferenceReady).toBe(false);
    expect(readiness.chatReady).toBe(false);
  });

  it("treats a node that has stopped beating as offline, exactly as the API does", () => {
    // `NODE_STALE_AFTER_MS` is 180 s (drizzle-runtime-node-manager.ts:57). The
    // status field is a snapshot taken when the list was read; between polls it
    // ages, and a Dashboard that never re-checks keeps reporting a dead VM2 as
    // answering.
    const quiet = {
      ...onlineNode,
      lastSeenAt: new Date(Date.now() - 4 * 60_000).toISOString(),
    } as HermesRuntimeNode;
    const readiness = deriveWorkspaceReadiness({
      connections: [connection("INFERENCE"), connection("HERMES")],
      runtimeNodes: [quiet],
      profiles: [activeProfile],
      runtime,
    });

    expect(readiness.runtimeNodeReady).toBe(false);
    expect(readiness.agenticInfrastructureReady).toBe(false);
    expect(readiness.chatReady).toBe(false);
  });

  it("does not accept a node that has never beaten at all", () => {
    // Enrolment leaves a node PENDING and only its own signed heartbeat
    // promotes it, so ONLINE with no `lastSeenAt` cannot happen on the wire —
    // and if it ever does, it is not evidence that anything is answering.
    const readiness = deriveWorkspaceReadiness({
      connections: [connection("INFERENCE"), connection("HERMES")],
      runtimeNodes: [{ status: "ONLINE", revokedAt: null, lastSeenAt: null } as HermesRuntimeNode],
      profiles: [activeProfile],
      runtime,
    });

    expect(readiness.runtimeNodeReady).toBe(false);
  });
});
