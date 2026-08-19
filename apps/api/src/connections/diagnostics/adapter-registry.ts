import type { ServiceKind } from "@orcasynapse/contracts";
import { GenericHttpAdapter } from "./generic-http-adapter.js";
import { OidcAdapter } from "./oidc-adapter.js";
import { OpenAICompatibleAdapter } from "./openai-compatible-adapter.js";
import type { ConnectionDiagnosticAdapter } from "./types.js";

const fallback = new GenericHttpAdapter("Service");

/*
 * Partial on purpose: `SIEM` remains a stored `ServiceKind` so rows written
 * before audit forwarding was removed at v9.0.0 still parse, but the product
 * no longer carries an adapter for a capability it does not have. A retained
 * row of a retired kind probes as a plain service, not as the feature that
 * left.
 */
const adapters: Partial<Record<ServiceKind, ConnectionDiagnosticAdapter>> = {
  INFERENCE: new OpenAICompatibleAdapter({ serviceName: "Inference server" }),
  HERMES: new GenericHttpAdapter("Hermes agent", "/health"),
  OIDC: new OidcAdapter(),
  MCP: new GenericHttpAdapter("MCP server", "/"),
  NOTIFICATION: new GenericHttpAdapter("Notification endpoint"),
  OTHER: fallback,
};

export function adapterFor(kind: ServiceKind): ConnectionDiagnosticAdapter {
  return adapters[kind] ?? fallback;
}
