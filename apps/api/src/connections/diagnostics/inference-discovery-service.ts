import type {
  InferenceBackend,
  InferenceDiscoveryProbe,
  InferenceDiscoveryRequest,
  InferenceDiscoveryResult,
} from "@orcasynapse/contracts";
import { ConnectionNotFoundError } from "../connection-manager.js";
import {
  bearerHeaders,
  boundedJsonResponse,
  endpointUrl,
  ResponseBodyTooLargeError,
} from "./http.js";
import type { ConnectionDiagnosticStore, ResolvedConnection } from "./types.js";

type FetchImplementation = typeof fetch;

interface InternalProbe {
  public: InferenceDiscoveryProbe;
  payload: Record<string, unknown> | null;
}

interface ParsedProbePayload {
  payload: Record<string, unknown> | null;
  tooLarge: boolean;
}

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const MAX_DISCOVERY_BODY_BYTES = 1_048_576;

function safeMessage(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 500);
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  return url.origin;
}

async function jsonPayload(response: Response): Promise<ParsedProbePayload> {
  try {
    const payload = await boundedJsonResponse(response, MAX_DISCOVERY_BODY_BYTES);
    return {
      payload: payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : null,
      tooLarge: false,
    };
  } catch (error) {
    return { payload: null, tooLarge: error instanceof ResponseBodyTooLargeError };
  }
}

function modelIds(payload: Record<string, unknown> | null): string[] {
  if (!payload) return [];
  const candidates: unknown[] = [];
  if (Array.isArray(payload.data)) candidates.push(...payload.data);
  if (Array.isArray(payload.models)) candidates.push(...payload.models);

  return [...new Set(candidates.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const record = candidate as Record<string, unknown>;
    const id = [record.id, record.model, record.name].find((value) => typeof value === "string");
    return typeof id === "string" && MODEL_ID.test(id) ? [id] : [];
  }))].slice(0, 200);
}

/**
 * LM Studio deliberately returns HTTP 200 for an unknown route and puts the
 * failure in `{ error: ... }`. Treating transport success as endpoint support
 * made every LM Studio server look like SGLang because `/get_server_info`
 * appeared to pass. A discovery probe is successful only when the application
 * payload did not reject the endpoint.
 */
function rejectedPayload(payload: Record<string, unknown> | null): boolean {
  if (payload === null || !("error" in payload)) return false;
  if (typeof payload.error === "string") return payload.error.trim().length > 0;
  return payload.error !== null && payload.error !== undefined && payload.error !== false;
}

function sglangEvidence(payload: Record<string, unknown> | null): boolean {
  if (!payload) return false;
  return [
    "attention_backend",
    "context_length",
    "max_running_requests",
    "max_total_num_tokens",
    "model_path",
    "served_model_name",
    "speculative_algorithm",
    "tp_size",
  ].some((key) => key in payload);
}

function tgiEvidence(payload: Record<string, unknown> | null): boolean {
  if (!payload || typeof payload.model_id !== "string") return false;
  return [
    "max_best_of",
    "max_concurrent_requests",
    "max_input_tokens",
    "max_stop_sequences",
    "max_total_tokens",
    "model_device_type",
    "model_dtype",
    "model_sha",
  ].some((key) => key in payload);
}

function backendFromEvidence(probes: Map<string, InternalProbe>): {
  backend: InferenceBackend;
  confidence: InferenceDiscoveryResult["backendConfidence"];
  evidence: string[];
} {
  const ollama = probes.get("ollama-version");
  if (ollama?.public.status === "PASSED" && typeof ollama.payload?.version === "string") {
    return { backend: "OLLAMA", confidence: "HIGH", evidence: [`Ollama ${ollama.payload.version} responded at /api/version.`] };
  }

  const llama = probes.get("llama-props");
  if (llama?.public.status === "PASSED" && (
    "default_generation_settings" in (llama.payload ?? {}) ||
    "total_slots" in (llama.payload ?? {})
  )) {
    return { backend: "LLAMA_CPP", confidence: "HIGH", evidence: ["llama.cpp server properties responded at /props."] };
  }

  const vllm = probes.get("vllm-version");
  if (vllm?.public.status === "PASSED" && typeof vllm.payload?.version === "string") {
    return { backend: "VLLM", confidence: "HIGH", evidence: [`vLLM ${vllm.payload.version} responded at /version.`] };
  }

  const sglang = probes.get("sglang-info");
  if (sglang?.public.status === "PASSED" && sglangEvidence(sglang.payload)) {
    return { backend: "SGLANG", confidence: "MEDIUM", evidence: ["SGLang server information responded at /get_server_info."] };
  }

  const tgi = probes.get("tgi-info");
  if (tgi?.public.status === "PASSED" && tgiEvidence(tgi.payload)) {
    return { backend: "TGI", confidence: "MEDIUM", evidence: ["Text Generation Inference metadata responded at /info."] };
  }

  return {
    backend: "CUSTOM_OPENAI_COMPATIBLE",
    confidence: "LOW",
    evidence: ["No implementation-specific endpoint responded; OpenAI compatibility is evaluated independently."],
  };
}

export class InferenceDiscoveryService {
  constructor(
    private readonly store?: ConnectionDiagnosticStore,
    private readonly fetchImplementation: FetchImplementation = fetch,
  ) {}

  async discover(input: InferenceDiscoveryRequest): Promise<InferenceDiscoveryResult> {
    let savedConnection: ResolvedConnection | null = null;
    if (input.connectionId) {
      savedConnection = await this.store?.resolveForDiagnostic(input.connectionId) ?? null;
      if (!savedConnection) throw new ConnectionNotFoundError(input.connectionId);
      if (savedConnection.kind !== "INFERENCE") throw new ConnectionNotFoundError(input.connectionId);
    }

    const normalizedBaseUrl = normalizeBaseUrl(input.baseUrl);
    const mayReuseSavedSecrets = savedConnection?.baseUrl
      ? normalizeBaseUrl(savedConnection.baseUrl) === normalizedBaseUrl
      : false;
    const temporaryConnection: ResolvedConnection = {
      id: input.connectionId ?? "00000000-0000-4000-8000-000000000000",
      activeRevision: savedConnection?.activeRevision ?? 1,
      kind: "INFERENCE",
      baseUrl: normalizedBaseUrl,
      configuration: {},
      secrets: input.apiKey
        ? { apiKey: input.apiKey }
        : mayReuseSavedSecrets ? savedConnection?.secrets ?? {} : {},
    };
    const headers = bearerHeaders(temporaryConnection);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs);

    const probe = async (key: string, label: string, path: string): Promise<InternalProbe> => {
      const startedAt = Date.now();
      try {
        const response = await this.fetchImplementation(endpointUrl(normalizedBaseUrl, path), {
          method: "GET",
          headers,
          redirect: "error",
          signal: controller.signal,
        });
        const parsed = await jsonPayload(response);
        const payload = parsed.payload;
        const applicationRejected = response.ok && rejectedPayload(payload);
        const passed = response.ok && !applicationRejected && !parsed.tooLarge;
        const rejected = response.status === 401 || response.status === 403;
        return {
          public: {
            key,
            label,
            path,
            status: passed ? "PASSED" : rejected ? "WARNING" : "FAILED",
            httpStatus: response.status,
            latencyMs: Date.now() - startedAt,
            message: passed
              ? `${label} responded successfully.`
              : parsed.tooLarge
                ? `${label} response exceeded the one-megabyte safety limit.`
              : applicationRejected
                ? `${label} is not supported by this server.`
              : rejected
                ? `${label} requires a valid credential.`
                : `${label} returned HTTP ${response.status}.`,
          },
          payload,
        };
      } catch (error) {
        return {
          public: {
            key,
            label,
            path,
            status: "FAILED",
            httpStatus: null,
            latencyMs: Date.now() - startedAt,
            message: controller.signal.aborted
              ? `${label} timed out after ${input.timeoutMs} ms.`
              : safeMessage(`${label} could not be reached.`),
          },
          payload: null,
        };
      }
    };

    try {
      const definitions = [
        ["models-openai", "OpenAI model discovery", "/v1/models"],
        ["models-ollama", "Ollama model discovery", "/api/tags"],
        ["health", "Health endpoint", "/health"],
        ["healthz", "Health endpoint", "/healthz"],
        ["readyz", "Readiness endpoint", "/readyz"],
        ["v1-health", "OpenAI health endpoint", "/v1/health"],
        ["ollama-version", "Ollama identity", "/api/version"],
        ["llama-props", "llama.cpp identity", "/props"],
        ["vllm-version", "vLLM identity", "/version"],
        ["sglang-info", "SGLang identity", "/get_server_info"],
        ["tgi-info", "Text Generation Inference identity", "/info"],
      ] as const;
      const results = await Promise.all(definitions.map(([key, label, path]) => probe(key, label, path)));
      const byKey = new Map(results.map((result) => [result.public.key, result]));
      const openAiModels = byKey.get("models-openai");
      const ollamaModels = byKey.get("models-ollama");
      const selectedModels = openAiModels?.public.status === "PASSED"
        ? openAiModels
        : ollamaModels?.public.status === "PASSED"
          ? ollamaModels
          : undefined;
      const discoveredModels = modelIds(selectedModels?.payload ?? null).map((id) => ({ id }));
      const backend = backendFromEvidence(byKey);
      const successfulHealth = ["health", "healthz", "readyz", "v1-health"]
        .map((key) => byKey.get(key))
        .find((result) => result?.public.status === "PASSED");
      const modelProbes = [openAiModels, ollamaModels].filter((value): value is InternalProbe => Boolean(value));
      const authenticationRejected = modelProbes.some(({ public: result }) =>
        result.httpStatus === 401 || result.httpStatus === 403,
      );
      const anyResponse = results.some(({ public: result }) => result.httpStatus !== null);

      const status: InferenceDiscoveryResult["status"] = authenticationRejected && !selectedModels
        ? "AUTH_REQUIRED"
        : selectedModels && discoveredModels.length > 0
          ? "READY"
          : anyResponse
            ? "PARTIAL"
            : "UNREACHABLE";
      const message = status === "READY"
        ? `Discovered ${discoveredModels.length} available model${discoveredModels.length === 1 ? "" : "s"} and a compatible model API.`
        : status === "AUTH_REQUIRED"
          ? "The server is reachable but model discovery requires a valid API key."
          : status === "PARTIAL"
            ? "The server responded, but OrcaSynapse could not confirm an available OpenAI-compatible model."
            : `The inference server could not be reached within ${input.timeoutMs} ms.`;
      const modelsPath = selectedModels?.public.path ?? "/v1/models";

      return {
        status,
        message,
        normalizedBaseUrl,
        backend: backend.backend,
        backendConfidence: backend.confidence,
        backendEvidence: backend.evidence,
        models: discoveredModels,
        recommended: {
          baseUrl: normalizedBaseUrl,
          inferenceBackend: backend.backend,
          healthPath: successfulHealth?.public.path ?? null,
          modelsPath,
          chatPath: "/v1/chat/completions",
          modelAlias: discoveredModels[0]?.id ?? null,
        },
        probes: results.map(({ public: result }) => result),
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
