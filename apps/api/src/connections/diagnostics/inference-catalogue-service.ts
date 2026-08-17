import {
  modelAliasSchema,
  OPENROUTER_INFERENCE,
  type InferenceCatalogueRequest,
  type InferenceCatalogueResult,
} from "@orcasynapse/contracts";
import { boundedJsonResponse, endpointUrl, ResponseBodyTooLargeError } from "./http.js";

type FetchImplementation = typeof fetch;

const MAX_CATALOGUE_BODY_BYTES = 1_000_000;
const MAX_MODELS = 2_000;

export class InferenceCatalogueError extends Error {
  constructor(
    readonly code: "AUTH_REJECTED" | "UPSTREAM_FAILED" | "INVALID_RESPONSE",
    message: string,
  ) {
    super(message);
    this.name = "InferenceCatalogueError";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function catalogModels(payload: Record<string, unknown>): InferenceCatalogueResult["models"] {
  const candidates = [
    ...(Array.isArray(payload.data) ? payload.data : []),
    ...(Array.isArray(payload.models) ? payload.models : []),
  ];
  const seen = new Set<string>();
  const models: InferenceCatalogueResult["models"] = [];
  for (const candidate of candidates) {
    const record = asRecord(candidate);
    if (!record) continue;
    const id = [record.id, record.model].find((value) => typeof value === "string");
    if (typeof id !== "string" || seen.has(id) || !modelAliasSchema.safeParse(id).success) continue;
    seen.add(id);
    const rawName = typeof record.name === "string" ? record.name.trim() : "";
    models.push(rawName.length > 0 ? { id, name: rawName.slice(0, 300) } : { id });
    if (models.length >= MAX_MODELS) break;
  }
  return models;
}

function keySummary(payload: Record<string, unknown>): InferenceCatalogueResult["key"] {
  const data = asRecord(payload.data) ?? payload;
  const label = typeof data.label === "string" && data.label.trim().length > 0
    ? data.label.trim().slice(0, 200)
    : undefined;
  const remaining = data.limit_remaining;
  const limitRemaining = typeof remaining === "number" && Number.isFinite(remaining)
    ? remaining
    : remaining === null
      ? null
      : undefined;
  return {
    ...(label ? { label } : {}),
    ...(limitRemaining !== undefined ? { limitRemaining } : {}),
  };
}

export class InferenceCatalogueService {
  constructor(private readonly fetchImplementation: FetchImplementation = fetch) {}

  async list(input: InferenceCatalogueRequest): Promise<InferenceCatalogueResult> {
    const signal = AbortSignal.timeout(input.timeoutMs);
    const headers = { authorization: `Bearer ${input.apiKey}` };
    const keyResponse = await this.fetchImplementation(
      endpointUrl(OPENROUTER_INFERENCE.origin, OPENROUTER_INFERENCE.keyPath),
      { method: "GET", headers, redirect: "error", signal },
    );
    if (keyResponse.status === 401 || keyResponse.status === 403) {
      throw new InferenceCatalogueError(
        "AUTH_REJECTED",
        "The OpenRouter API key was rejected. Check the key and try again.",
      );
    }
    if (!keyResponse.ok) {
      throw new InferenceCatalogueError(
        "UPSTREAM_FAILED",
        `OpenRouter did not accept the key probe (HTTP ${keyResponse.status}).`,
      );
    }

    let keyPayload: Record<string, unknown> = {};
    try {
      const value = await boundedJsonResponse(keyResponse, MAX_CATALOGUE_BODY_BYTES);
      keyPayload = asRecord(value) ?? {};
    } catch (error) {
      if (error instanceof ResponseBodyTooLargeError) {
        throw new InferenceCatalogueError("INVALID_RESPONSE", "OpenRouter key response exceeded the safety limit.");
      }
      throw new InferenceCatalogueError("INVALID_RESPONSE", "OpenRouter key response was not valid JSON.");
    }

    const modelsResponse = await this.fetchImplementation(
      endpointUrl(OPENROUTER_INFERENCE.origin, OPENROUTER_INFERENCE.modelsPath),
      { method: "GET", headers, redirect: "error", signal },
    );
    if (!modelsResponse.ok) {
      throw new InferenceCatalogueError(
        "UPSTREAM_FAILED",
        `OpenRouter did not return a model catalogue (HTTP ${modelsResponse.status}).`,
      );
    }

    let modelsPayload: Record<string, unknown>;
    try {
      const value = await boundedJsonResponse(modelsResponse, MAX_CATALOGUE_BODY_BYTES);
      const record = asRecord(value);
      if (!record) throw new Error("Invalid payload");
      modelsPayload = record;
    } catch (error) {
      if (error instanceof InferenceCatalogueError) throw error;
      if (error instanceof ResponseBodyTooLargeError) {
        throw new InferenceCatalogueError("INVALID_RESPONSE", "OpenRouter models response exceeded the safety limit.");
      }
      throw new InferenceCatalogueError("INVALID_RESPONSE", "OpenRouter models response was not valid JSON.");
    }

    return {
      provider: "openrouter",
      models: catalogModels(modelsPayload),
      key: keySummary(keyPayload),
    };
  }
}
