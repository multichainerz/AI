import { describe, expect, it } from "vitest";
import { deploymentStatus, type DeploymentStatusInput } from "./deployment-status.js";

function input(overrides: Partial<DeploymentStatusInput> = {}): DeploymentStatusInput {
  return {
    apiAvailable: true,
    bootstrapState: "READY",
    unlocked: true,
    layers: [
      { state: { tone: "ready" } },
      { state: { tone: "ready" } },
      { state: { tone: "ready" } },
    ],
    readiness: [{ ready: true }, { ready: true }, { ready: true }],
    runtimeNodes: [{ status: "ONLINE" }],
    incidents: [],
    ...overrides,
  };
}

describe("deploymentStatus", () => {
  it("treats an unreachable API as offline, even when every other signal looks finished", () => {
    expect(deploymentStatus(input({
      apiAvailable: false,
      bootstrapState: "REQUIRED",
      readiness: [{ ready: false }],
      runtimeNodes: [{ status: "OFFLINE" }],
    }))).toEqual({ label: "Offline", tone: "bad" });
  });

  it("treats unfinished host bootstrap as setup, not degradation", () => {
    expect(deploymentStatus(input({ bootstrapState: "REQUIRED" }))).toEqual({
      label: "Need Setup",
      tone: "node",
    });
    expect(deploymentStatus(input({ bootstrapState: "LOCKED" }))).toEqual({
      label: "Need Setup",
      tone: "node",
    });
  });

  it("treats unreadiness and unconfigured layers as setup, and ranks that above a fault", () => {
    expect(deploymentStatus(input({
      readiness: [{ ready: true }, { ready: false }],
      runtimeNodes: [{ status: "OFFLINE" }],
    }))).toEqual({ label: "Need Setup", tone: "node" });

    expect(deploymentStatus(input({
      layers: [{ state: { tone: "unconfigured" } }],
    }))).toEqual({ label: "Need Setup", tone: "node" });
    expect(deploymentStatus(input({
      layers: [{ state: { tone: "validation" } }],
    }))).toEqual({ label: "Need Setup", tone: "node" });
  });

  it("treats a finished path that is unhealthy as degraded", () => {
    expect(deploymentStatus(input({
      layers: [{ state: { tone: "degraded" } }],
    }))).toEqual({ label: "Degraded", tone: "warn" });
    expect(deploymentStatus(input({
      layers: [{ state: { tone: "blocked" } }],
    }))).toEqual({ label: "Degraded", tone: "warn" });
    expect(deploymentStatus(input({
      runtimeNodes: [{ status: "ONLINE" }, { status: "OFFLINE" }],
    }))).toEqual({ label: "Degraded", tone: "warn" });
    expect(deploymentStatus(input({
      runtimeNodes: [{ status: "DEGRADED" }],
    }))).toEqual({ label: "Degraded", tone: "warn" });
    expect(deploymentStatus(input({
      incidents: [{ status: "OPEN" }],
    }))).toEqual({ label: "Degraded", tone: "warn" });
    expect(deploymentStatus(input({
      incidents: [{ status: "ACKNOWLEDGED" }],
    }))).toEqual({ label: "Degraded", tone: "warn" });
  });

  it("ignores resolved incidents, unread incidents, and nodes that are not a live fault", () => {
    expect(deploymentStatus(input({
      incidents: [{ status: "RESOLVED" }],
    }))).toEqual({ label: "Fully Operational", tone: "good" });
    expect(deploymentStatus(input({ incidents: null }))).toEqual({
      label: "Fully Operational",
      tone: "good",
    });
    expect(deploymentStatus(input({
      runtimeNodes: [{ status: "PENDING" }, { status: "DRAINING" }],
    }))).toEqual({ label: "Fully Operational", tone: "good" });
  });

  it("does not inspect authenticated signals while the session is locked", () => {
    expect(deploymentStatus(input({
      unlocked: false,
      readiness: [{ ready: false }],
      layers: [{ state: { tone: "disabled" } }],
      runtimeNodes: [{ status: "OFFLINE" }],
      incidents: [{ status: "OPEN" }],
    }))).toEqual({ label: "Fully Operational", tone: "good" });

    expect(deploymentStatus(input({
      unlocked: false,
      bootstrapState: "REQUIRED",
    }))).toEqual({ label: "Need Setup", tone: "node" });
  });

  it("names a finished, inspected path fully operational", () => {
    expect(deploymentStatus(input())).toEqual({ label: "Fully Operational", tone: "good" });
  });
});
