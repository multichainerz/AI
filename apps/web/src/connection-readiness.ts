import type { ServiceConnectionSummary } from "@orcasynapse/contracts";

export type ConnectionReadinessTone =
  | "unconfigured"
  | "configured"
  | "validation"
  | "ready"
  | "degraded"
  | "blocked";

export interface ConnectionReadiness {
  label: "Not configured" | "Configured" | "Needs validation" | "Ready" | "Degraded" | "Blocked";
  tone: ConnectionReadinessTone;
  ready: boolean;
}

export function connectionReadiness(connection: ServiceConnectionSummary | undefined): ConnectionReadiness {
  if (!connection) return { label: "Not configured", tone: "unconfigured", ready: false };
  if (!connection.enabled || connection.status === "DISABLED") {
    return { label: "Configured", tone: "configured", ready: false };
  }
  if (connection.status === "HEALTHY") return { label: "Ready", tone: "ready", ready: true };
  if (connection.status === "NOT_TESTED") {
    return { label: "Needs validation", tone: "validation", ready: false };
  }
  if (connection.status === "UNREACHABLE") return { label: "Blocked", tone: "blocked", ready: false };
  return { label: "Degraded", tone: "degraded", ready: false };
}

export function isConnectionReady(connection: ServiceConnectionSummary | undefined): boolean {
  return connectionReadiness(connection).ready;
}
