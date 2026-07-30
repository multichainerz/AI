import type { ConnectionStatus, ConnectionTestResult, ServiceKind } from "@aihub/contracts";
import type { AdminActor } from "../connection-manager.js";

export interface ResolvedConnection {
  id: string;
  activeRevision: number;
  kind: ServiceKind;
  baseUrl: string | null;
  configuration: Record<string, unknown>;
  secrets: Record<string, string>;
}

export interface AdapterOutcome {
  status: Exclude<ConnectionStatus, "NOT_TESTED" | "DISABLED">;
  message: string;
  details?: Record<string, unknown>;
}

export interface ConnectionDiagnosticAdapter {
  test(connection: ResolvedConnection, signal: AbortSignal): Promise<AdapterOutcome>;
}

export interface ConnectionDiagnosticStore {
  resolveForDiagnostic(id: string): Promise<ResolvedConnection>;
  recordDiagnostic(result: ConnectionTestResult, actor?: AdminActor, expectedRevision?: number): Promise<boolean>;
}
