import { failedHttpOutcome, healthFetch, stringConfiguration } from "./http.js";
import type { AdapterOutcome, ConnectionDiagnosticAdapter, ResolvedConnection } from "./types.js";

export const SUPERMEMORY_LOCAL_READY_PATH = "/v4/openapi";
const LEGACY_SUPERMEMORY_HEALTH_PATH = "/health";

export class SupermemoryAdapter implements ConnectionDiagnosticAdapter {
  async test(connection: ResolvedConnection, signal: AbortSignal): Promise<AdapterOutcome> {
    const configuredPath = stringConfiguration(connection, "healthPath") ?? SUPERMEMORY_LOCAL_READY_PATH;
    let effectivePath = configuredPath;
    let response = await healthFetch(connection, configuredPath, signal);

    // Agentic System nodes enrolled before ai-v1.15.6 stored the conventional
    // /health path. Supermemory Local 0.0.5 instead exposes its stable readiness
    // contract through /v4/openapi, so recover those records without requiring
    // node destruction or direct database edits.
    if (response.status === 404 && configuredPath === LEGACY_SUPERMEMORY_HEALTH_PATH) {
      effectivePath = SUPERMEMORY_LOCAL_READY_PATH;
      response = await healthFetch(connection, effectivePath, signal);
    }

    if (!response.ok) return failedHttpOutcome("Supermemory", response);
    return {
      status: "HEALTHY",
      message: "Supermemory is reachable.",
      details: {
        httpStatus: response.status,
        healthPath: effectivePath,
        legacyHealthPathRecovered: effectivePath !== configuredPath,
      },
    };
  }
}
