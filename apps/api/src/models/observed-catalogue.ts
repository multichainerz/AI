import {
  MODEL_INPUT_MODALITIES,
  modelAliasSchema,
  type ModelInputModality,
} from "@orcasynapse/contracts";

export const MAX_OBSERVED_MODELS = 2_000;
export const MAX_CATALOGUE_BODY_BYTES = 1_048_576;

export interface ObservedModelSnapshot {
  alias: string;
  displayName: string | null;
  observedContextWindowTokens: number | null;
  observedMaxOutputTokens: number | null;
  inputModalities: ModelInputModality[];
  ownedBy: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asFiniteInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function trimTo(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, max) : null;
}

const knownModalities = new Set<string>(MODEL_INPUT_MODALITIES);

function mapModality(value: unknown): ModelInputModality | null {
  if (typeof value !== "string") return null;
  const token = value.trim().toLowerCase();
  if (token === "vision") return "image";
  return knownModalities.has(token) ? token as ModelInputModality : null;
}

function inputModalities(value: unknown): ModelInputModality[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<ModelInputModality>();
  for (const candidate of value) {
    const mapped = mapModality(candidate);
    if (mapped) seen.add(mapped);
  }
  return [...seen];
}

function candidates(payload: Record<string, unknown>): unknown[] {
  return [
    ...(Array.isArray(payload.data) ? payload.data : []),
    ...(Array.isArray(payload.models) ? payload.models : []),
  ];
}

function aliasOf(record: Record<string, unknown>): string | null {
  const id = [record.id, record.model, record.name].find((value) => typeof value === "string");
  if (typeof id !== "string") return null;
  const parsed = modelAliasSchema.safeParse(id);
  return parsed.success ? parsed.data : null;
}

/**
 * OpenRouter publishes context, modalities and max completion. Generic
 * OpenAI-compatible `/v1/models` does not, even when extra keys happen to
 * appear — those are not a contract we can trust.
 */
export function mapObservedCatalogue(
  payload: unknown,
  kind: "openrouter" | "generic",
): ObservedModelSnapshot[] {
  const record = asRecord(payload);
  if (!record) return [];
  const seen = new Set<string>();
  const models: ObservedModelSnapshot[] = [];
  for (const candidate of candidates(record)) {
    const item = asRecord(candidate);
    if (!item) continue;
    const alias = aliasOf(item);
    if (!alias || seen.has(alias)) continue;
    seen.add(alias);
    const name = trimTo(item.name, 300);
    const ownedBy = trimTo(item.owned_by, 200);
    if (kind === "openrouter") {
      const architecture = asRecord(item.architecture);
      const topProvider = asRecord(item.top_provider);
      models.push({
        alias,
        displayName: name,
        observedContextWindowTokens: asFiniteInteger(item.context_length),
        observedMaxOutputTokens: asFiniteInteger(topProvider?.max_completion_tokens),
        inputModalities: inputModalities(architecture?.input_modalities),
        ownedBy,
      });
    } else {
      models.push({
        alias,
        displayName: name,
        observedContextWindowTokens: null,
        observedMaxOutputTokens: null,
        inputModalities: [],
        ownedBy,
      });
    }
    if (models.length >= MAX_OBSERVED_MODELS) break;
  }
  return models;
}

export function contractBoundedLimits(observation: {
  observedContextWindowTokens: number | null;
  observedMaxOutputTokens: number | null;
}): { contextWindowTokens: number; maxOutputTokens: number } | null {
  const context = observation.observedContextWindowTokens;
  const output = observation.observedMaxOutputTokens;
  if (context === null || output === null) return null;
  if (context < 1_024 || context > 4_194_304) return null;
  if (output < 64 || output > 131_072) return null;
  if (output > context) return null;
  return { contextWindowTokens: context, maxOutputTokens: output };
}
