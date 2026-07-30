import type { ConnectionTestResult } from "@aihub/contracts";
import { ConnectionNotFoundError, type AdminActor } from "../connection-manager.js";
import { adapterFor } from "./adapter-registry.js";
import type {
  ConnectionDiagnosticAdapter,
  ConnectionDiagnosticStore,
  ResolvedConnection,
} from "./types.js";

type AdapterResolver = (kind: ResolvedConnection["kind"]) => ConnectionDiagnosticAdapter;

function safeMessage(message: string): string {
  return message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500);
}

function upstreamStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("$metadata" in error)) return undefined;
  const metadata = error.$metadata;
  if (!metadata || typeof metadata !== "object" || !("httpStatusCode" in metadata)) {
    return undefined;
  }

  return typeof metadata.httpStatusCode === "number" ? metadata.httpStatusCode : undefined;
}

export class ConnectionTestService {
  constructor(
    private readonly store: ConnectionDiagnosticStore,
    private readonly resolveAdapter: AdapterResolver = adapterFor,
  ) {}

  async test(connectionId: string, actor?: AdminActor): Promise<ConnectionTestResult> {
    const connection = await this.store.resolveForDiagnostic(connectionId);
    if (!connection) throw new ConnectionNotFoundError(connectionId);

    if (!connection.baseUrl) {
      const result: ConnectionTestResult = {
        connectionId,
        status: "DEGRADED",
        message: "Connection endpoint URL is not configured.",
        checkedAt: new Date().toISOString(),
        latencyMs: 0,
        details: { failure: "configuration" },
      };
      await this.store.recordDiagnostic(result, actor, connection.activeRevision);
      return result;
    }

    const configuredTimeout = connection.configuration.timeoutMs;
    const timeoutMs =
      typeof configuredTimeout === "number" && Number.isFinite(configuredTimeout)
        ? Math.min(30_000, Math.max(1_000, Math.trunc(configuredTimeout)))
        : 8_000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();

    let result: ConnectionTestResult;
    try {
      const outcome = await this.resolveAdapter(connection.kind).test(connection, controller.signal);
      result = {
        connectionId,
        status: outcome.status,
        message: safeMessage(outcome.message),
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
        details: outcome.details ?? {},
      };
    } catch (error) {
      const timedOut = controller.signal.aborted;
      const statusCode = upstreamStatusCode(error);
      const rejected = statusCode !== undefined && statusCode >= 400 && statusCode < 500;
      result = {
        connectionId,
        status: rejected ? "DEGRADED" : "UNREACHABLE",
        message: timedOut
          ? `Connection test timed out after ${timeoutMs} ms.`
          : rejected
            ? "Service is reachable but rejected the configured credentials or request."
          : "Service could not be reached with the configured endpoint.",
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
        details: {
          failure: timedOut ? "timeout" : rejected ? "rejected" : "network",
          ...(statusCode === undefined ? {} : { httpStatus: statusCode }),
        },
      };
    } finally {
      clearTimeout(timeout);
    }

    await this.store.recordDiagnostic(result, actor, connection.activeRevision);
    return result;
  }
}
