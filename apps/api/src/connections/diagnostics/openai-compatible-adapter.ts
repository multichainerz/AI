import {
  failedHttpOutcome,
  healthFetch,
  stringConfiguration,
} from "./http.js";
import type {
  AdapterOutcome,
  ConnectionDiagnosticAdapter,
  ResolvedConnection,
} from "./types.js";

interface OpenAICompatibleAdapterOptions {
  serviceName: string;
  defaultHealthPath: string;
}

export class OpenAICompatibleAdapter implements ConnectionDiagnosticAdapter {
  constructor(private readonly options: OpenAICompatibleAdapterOptions) {}

  async test(connection: ResolvedConnection, signal: AbortSignal): Promise<AdapterOutcome> {
    const healthPath = stringConfiguration(connection, "healthPath") ?? this.options.defaultHealthPath;
    const modelsPath = stringConfiguration(connection, "modelsPath") ?? "/v1/models";

    const health = await healthFetch(connection, healthPath, signal);
    if (!health.ok) return failedHttpOutcome(this.options.serviceName, health);

    const models = await healthFetch(connection, modelsPath, signal);
    if (!models.ok) return failedHttpOutcome(this.options.serviceName, models);

    let payload: { data?: Array<{ id?: unknown }> };
    try {
      payload = (await models.json()) as { data?: Array<{ id?: unknown }> };
    } catch {
      return {
        status: "DEGRADED",
        message: `${this.options.serviceName} is reachable but returned an invalid models response.`,
        details: { failure: "invalid_models_response" },
      };
    }
    const modelIds = Array.isArray(payload.data)
      ? payload.data
          .map(({ id }) => id)
          .filter((id): id is string => typeof id === "string")
          .slice(0, 50)
      : [];
    const modelAlias = stringConfiguration(connection, "modelAlias");

    if (modelIds.length === 0) {
      return {
        status: "DEGRADED",
        message: `${this.options.serviceName} is reachable but reported no available models.`,
        details: { modelCount: 0 },
      };
    }

    if (modelAlias && !modelIds.includes(modelAlias)) {
      return {
        status: "DEGRADED",
        message: `${this.options.serviceName} is reachable but the configured model alias is unavailable.`,
        details: { modelAlias, modelCount: modelIds.length, modelIds },
      };
    }

    return {
      status: "HEALTHY",
      message: `${this.options.serviceName} is reachable and authenticated.`,
      details: {
        modelCount: modelIds.length,
        modelIds,
        ...(modelAlias ? { modelAlias } : {}),
      },
    };
  }
}
