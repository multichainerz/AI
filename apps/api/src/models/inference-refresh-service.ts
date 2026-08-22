import {
  isOpenRouterEndpoint,
  OPENROUTER_INFERENCE,
  type ModelRefreshResult,
  type ServiceConnectionSummary,
} from "@orcasynapse/contracts";
import type { AdminPrincipal } from "../auth/admin-session.js";
import { ConnectionNotFoundError } from "../connections/connection-manager.js";
import {
  bearerHeaders,
  boundedJsonResponse,
  endpointUrl,
  ResponseBodyTooLargeError,
  stringConfiguration,
} from "../connections/diagnostics/http.js";
import type { ConnectionDiagnosticStore, ResolvedConnection } from "../connections/diagnostics/types.js";
import type { ModelManager } from "./model-manager.js";
import {
  mapObservedCatalogue,
  MAX_CATALOGUE_BODY_BYTES,
} from "./observed-catalogue.js";

type FetchImplementation = typeof fetch;

export class ModelRefreshError extends Error {
  constructor(
    readonly code: "NOT_CONFIGURED" | "AUTH_REJECTED" | "UPSTREAM_FAILED" | "INVALID_RESPONSE",
    message: string,
  ) {
    super(message);
    this.name = "ModelRefreshError";
  }
}

export interface InferenceRefreshConnections extends ConnectionDiagnosticStore {
  list(): Promise<ServiceConnectionSummary[]>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function timeoutMs(connection: ResolvedConnection): number {
  const configured = connection.configuration.timeoutMs;
  return typeof configured === "number" && Number.isInteger(configured) && configured >= 1_000
    ? Math.min(configured, 30_000)
    : 8_000;
}

function modelsPath(connection: ResolvedConnection): string {
  if (isOpenRouterEndpoint(connection.baseUrl)) return OPENROUTER_INFERENCE.modelsPath;
  return stringConfiguration(connection, "modelsPath") ?? "/v1/models";
}

export class InferenceRefreshService {
  constructor(
    private readonly connections: InferenceRefreshConnections,
    private readonly models: ModelManager,
    private readonly fetchImplementation: FetchImplementation = fetch,
  ) {}

  async refresh(principal: AdminPrincipal, connectionId: string): Promise<ModelRefreshResult> {
    const healthy = (await this.connections.list()).filter((connection) =>
      connection.kind === "INFERENCE" && connection.enabled && connection.status === "HEALTHY",
    );
    if (healthy.length !== 1 || healthy[0]?.id !== connectionId) {
      throw new ModelRefreshError(
        "NOT_CONFIGURED",
        "Exactly one healthy inference server route is required.",
      );
    }

    let resolved: ResolvedConnection;
    try {
      resolved = await this.connections.resolveForDiagnostic(connectionId);
    } catch (error) {
      if (error instanceof ConnectionNotFoundError) throw error;
      throw error;
    }
    if (resolved.kind !== "INFERENCE") {
      throw new ModelRefreshError("NOT_CONFIGURED", "Only an inference connection can refresh models.");
    }
    if (!resolved.baseUrl) {
      throw new ModelRefreshError("NOT_CONFIGURED", "The inference connection has no endpoint URL.");
    }

    const kind = isOpenRouterEndpoint(resolved.baseUrl) ? "openrouter" : "generic";
    const signal = AbortSignal.timeout(timeoutMs(resolved));
    let response: Response;
    try {
      response = await this.fetchImplementation(endpointUrl(resolved.baseUrl, modelsPath(resolved)), {
        method: "GET",
        headers: bearerHeaders(resolved),
        redirect: "error",
        signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new ModelRefreshError("UPSTREAM_FAILED", `The inference server did not return a model catalogue within ${timeoutMs(resolved)} ms.`);
      }
      throw new ModelRefreshError("UPSTREAM_FAILED", "The inference server could not be reached.");
    }

    if (response.status === 401 || response.status === 403) {
      throw new ModelRefreshError(
        "AUTH_REJECTED",
        "The inference server rejected the stored credential. Check the key and try again.",
      );
    }
    if (!response.ok) {
      throw new ModelRefreshError(
        "UPSTREAM_FAILED",
        `The inference server did not return a model catalogue (HTTP ${response.status}).`,
      );
    }

    let payload: Record<string, unknown>;
    try {
      const value = await boundedJsonResponse(response, MAX_CATALOGUE_BODY_BYTES);
      const record = asRecord(value);
      if (!record) throw new Error("Invalid payload");
      payload = record;
    } catch (error) {
      if (error instanceof ResponseBodyTooLargeError) {
        throw new ModelRefreshError("INVALID_RESPONSE", "The model catalogue exceeded the one-megabyte safety limit.");
      }
      throw new ModelRefreshError("INVALID_RESPONSE", "The model catalogue was not valid JSON.");
    }

    const snapshots = mapObservedCatalogue(payload, kind);
    const seenAt = new Date();
    const sync = await this.models.replaceObservations(connectionId, snapshots, seenAt);
    const configuredAlias = resolved.configuration.modelAlias;
    const backfill = await this.models.maybeBackfillLegacyAlias(
      principal,
      connectionId,
      typeof configuredAlias === "string" ? configuredAlias : undefined,
    );
    const listed = await this.models.listObservations(connectionId);
    return {
      connectionId,
      refreshedAt: seenAt.toISOString(),
      upserted: sync.upserted,
      vanished: sync.vanished,
      items: listed.items,
      backfill,
    };
  }
}
