import { isOpenRouterEndpoint, type ModelObservation } from "@orcasynapse/contracts";
import { slugify } from "./slug.js";

/**
 * OpenRouter's per-model free variant, as listed on GET /api/v1/models.
 *
 * Official: append `:free` to a specific id
 * (https://openrouter.ai/docs/guides/routing/model-variants/free). The Free
 * Models Router `openrouter/free` is a different object — it picks at random
 * per request — and must not be pinned as Hermes' AGENT alias.
 */
export function isOpenRouterFreeAlias(alias: string): boolean {
  return alias.toLowerCase().endsWith(":free");
}

function probablyNotChat(alias: string): boolean {
  const id = alias.toLowerCase();
  return ["text-embedding-", "whisper-", "dall-e-", "tts-"].some((token) => id.includes(token));
}

export function setupAgentModelChoices(
  items: readonly ModelObservation[],
  connectionBaseUrl: string | null | undefined,
): ModelObservation[] {
  const openRouter = isOpenRouterEndpoint(connectionBaseUrl);
  return items
    .filter((item) => {
      if (item.missingFromUpstream) return false;
      if (probablyNotChat(item.alias)) return false;
      if (openRouter) return isOpenRouterFreeAlias(item.alias);
      return true;
    })
    .slice()
    .sort((left, right) => left.alias.localeCompare(right.alias));
}

/** Route slug for a Setup admit; `:free` aliases must stay a legal slug. */
export function setupAgentDeploymentSlug(alias: string): string {
  const slug = slugify(alias);
  if (slug.length >= 2) return slug;
  return `${slug || "agent"}-model`.slice(0, 64);
}

const MIN_CONTEXT = 1_024;
const MAX_CONTEXT = 4_194_304;
const MIN_OUTPUT = 64;
const MAX_OUTPUT = 131_072;
const FALLBACK_CONTEXT = 131_072;
const FALLBACK_OUTPUT = 8_192;

/**
 * Limits a Setup admit can send without a form.
 *
 * Observed values win when they sit in the contract bounds. A missing
 * OpenRouter `max_completion_tokens` must not block first enrolment.
 */
export function admitLimits(observation: ModelObservation): {
  contextWindowTokens: number;
  maxOutputTokens: number;
} {
  const context = observation.observedContextWindowTokens !== null
    && observation.observedContextWindowTokens >= MIN_CONTEXT
    && observation.observedContextWindowTokens <= MAX_CONTEXT
    ? observation.observedContextWindowTokens
    : FALLBACK_CONTEXT;
  let output = observation.observedMaxOutputTokens !== null
    && observation.observedMaxOutputTokens >= MIN_OUTPUT
    && observation.observedMaxOutputTokens <= MAX_OUTPUT
    ? observation.observedMaxOutputTokens
    : Math.min(FALLBACK_OUTPUT, context);
  if (output > context) output = Math.min(FALLBACK_OUTPUT, context);
  return { contextWindowTokens: context, maxOutputTokens: output };
}
