import type {
  AgentProfile,
  AgentRuntimeControl,
  HermesRuntimeNode,
  ServiceConnectionSummary,
  ServiceKind,
} from "@orcasynapse/contracts";
import { describe, expect, it } from "vitest";
import { deriveWorkspaceReadiness } from "./platform-readiness.js";

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
    configuration: {},
    secretFieldNames: [],
    activeRevision: 1,
    lastHealthcheckAt: "2026-08-03T00:00:00.000Z",
    lastHealthcheckMessage: "Healthy",
    updatedAt: "2026-08-03T00:00:00.000Z",
    ...overrides,
  };
}

const runtime = { enabled: true } as AgentRuntimeControl;
const onlineNode = { status: "ONLINE" } as HermesRuntimeNode;
const activeProfile = { status: "ACTIVE" } as AgentProfile;

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
});
