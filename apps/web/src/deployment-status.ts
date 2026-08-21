/**
 * The four-state deployment chip on the Dashboard.
 *
 * Precedence is worst-first: a reachable control plane that still needs
 * bring-up is not operational, and an incomplete installation is not
 * "degraded" — that word is reserved for a finished path that is unhealthy.
 *
 * Authenticated signals (readiness, layers, nodes, incidents) are unread
 * until the session is unlocked. While locked, only the public pair
 * `apiAvailable` + `bootstrapState` is honest.
 *
 * Deliberately ignored: pending approvals, 24-hour failed responses, and
 * unsigned-in empty arrays. Those are operator work, history, and unread
 * data — none of them is the current health of the fabric.
 */

export type DeploymentHealth = "Fully Operational" | "Degraded" | "Need Setup" | "Offline";

export interface DeploymentStatus {
  label: DeploymentHealth;
  tone: "good" | "warn" | "node" | "bad";
}

export interface DeploymentStatusInput {
  apiAvailable: boolean;
  bootstrapState: "LOCKED" | "REQUIRED" | "READY";
  unlocked: boolean;
  layers: Array<{ state: { tone: string } }>;
  readiness: Array<{ ready: boolean }>;
  runtimeNodes: Array<{ status: string }>;
  incidents: Array<{ status: string }> | null;
}

const SETUP_LAYER_TONES = new Set(["unconfigured", "configured", "validation"]);
const DEGRADED_LAYER_TONES = new Set(["degraded", "blocked"]);

export function deploymentStatus(input: DeploymentStatusInput): DeploymentStatus {
  if (!input.apiAvailable) {
    return { label: "Offline", tone: "bad" };
  }

  if (input.bootstrapState !== "READY") {
    return { label: "Need Setup", tone: "node" };
  }

  if (!input.unlocked) {
    return { label: "Fully Operational", tone: "good" };
  }

  const setupIncomplete =
    input.readiness.some((check) => !check.ready) ||
    input.layers.some((layer) => SETUP_LAYER_TONES.has(layer.state.tone));
  if (setupIncomplete) {
    return { label: "Need Setup", tone: "node" };
  }

  const unhealthyNode = input.runtimeNodes.some(
    (node) => node.status === "OFFLINE" || node.status === "DEGRADED",
  );
  const degradedLayer = input.layers.some((layer) => DEGRADED_LAYER_TONES.has(layer.state.tone));
  const openIncident = (input.incidents ?? []).some((incident) => incident.status !== "RESOLVED");
  if (unhealthyNode || degradedLayer || openIncident) {
    return { label: "Degraded", tone: "warn" };
  }

  return { label: "Fully Operational", tone: "good" };
}
