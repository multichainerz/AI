import { isOpenRouterEndpoint, OPENROUTER_INFERENCE } from "@orcasynapse/contracts";
import {
  boundedJsonResponse,
  failedHttpOutcome,
  healthFetch,
  ResponseBodyTooLargeError,
  stringConfiguration,
} from "./http.js";
import type {
  AdapterOutcome,
  ConnectionDiagnosticAdapter,
  ResolvedConnection,
} from "./types.js";

interface OpenAICompatibleAdapterOptions {
  serviceName: string;
  defaultHealthPath?: string;
}

const MAX_MODEL_DISCOVERY_BYTES = 1_000_000;

function catalogModelIds(payload: Record<string, unknown>): string[] {
  const candidates = [
    ...(Array.isArray(payload.data) ? payload.data : []),
    ...(Array.isArray(payload.models) ? payload.models : []),
  ];
  return [...new Set(candidates.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const record = candidate as Record<string, unknown>;
    const id = [record.id, record.model, record.name].find((value) => typeof value === "string");
    return typeof id === "string" ? [id] : [];
  }))];
}

export class OpenAICompatibleAdapter implements ConnectionDiagnosticAdapter {
  constructor(private readonly options: OpenAICompatibleAdapterOptions) {}

  async test(connection: ResolvedConnection, signal: AbortSignal): Promise<AdapterOutcome> {
    const healthPath = stringConfiguration(connection, "healthPath") ?? this.options.defaultHealthPath;
    const modelsPath = stringConfiguration(connection, "modelsPath") ?? "/v1/models";
    const openRouter = isOpenRouterEndpoint(connection.baseUrl);

    const models = await healthFetch(connection, modelsPath, signal);
    if (!models.ok) return failedHttpOutcome(this.options.serviceName, models);

    let payload: Record<string, unknown>;
    try {
      const value = await boundedJsonResponse(models, MAX_MODEL_DISCOVERY_BYTES);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid payload");
      payload = value as Record<string, unknown>;
    } catch (error) {
      if (error instanceof ResponseBodyTooLargeError) {
        return {
          status: "DEGRADED",
          message: `${this.options.serviceName} models response exceeded the one-megabyte safety limit.`,
          details: { failure: "models_response_too_large", responseTooLarge: true },
        };
      }
      return {
        status: "DEGRADED",
        message: `${this.options.serviceName} is reachable but returned an invalid models response.`,
        details: { failure: "invalid_models_response" },
      };
    }
    const modelIds = catalogModelIds(payload);
    const modelAlias = stringConfiguration(connection, "modelAlias");
    const inferenceBackend = stringConfiguration(connection, "inferenceBackend");
    const backendDetail = inferenceBackend ? { inferenceBackend } : {};

    if (modelIds.length === 0) {
      return {
        status: "DEGRADED",
        message: `${this.options.serviceName} is reachable but reported no available models.`,
        details: { modelCount: 0, ...backendDetail },
      };
    }

    if (modelAlias && !modelIds.includes(modelAlias)) {
      return {
        status: "DEGRADED",
        message: `${this.options.serviceName} is reachable but the configured model alias is unavailable.`,
        details: { modelAlias, modelCount: modelIds.length, ...backendDetail },
      };
    }

    if (openRouter) {
      const apiKey = connection.secrets.apiKey ?? connection.secrets.bearerToken;
      if (!apiKey) {
        return {
          status: "DEGRADED",
          message: `${this.options.serviceName} requires an OpenRouter API key. Model discovery is public and does not prove the credential.`,
          details: { failure: "openrouter_key_required", modelCount: modelIds.length, ...backendDetail },
        };
      }
      const keyProbe = await healthFetch(connection, OPENROUTER_INFERENCE.keyPath, signal);
      if (!keyProbe.ok) return failedHttpOutcome(this.options.serviceName, keyProbe);
    }

    const health = healthPath ? await healthFetch(connection, healthPath, signal) : null;
    const healthWarning = health && !health.ok
      ? ` Optional health endpoint ${healthPath} returned HTTP ${health.status}.`
      : "";

    return {
      status: "HEALTHY",
      message: openRouter
        ? `${this.options.serviceName} key is valid and the served model is available.${healthWarning}`
        : `${this.options.serviceName} model discovery is reachable and authenticated.${healthWarning}`,
      details: {
        modelCount: modelIds.length,
        modelsPath,
        ...(healthPath ? { healthPath, healthHttpStatus: health?.status ?? null } : {}),
        ...backendDetail,
        ...(modelAlias ? { modelAlias } : {}),
        ...(openRouter ? { credential: "verified" } : {}),
      },
    };
  }
}
