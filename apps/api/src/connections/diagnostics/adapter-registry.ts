import type { ServiceKind } from "@aihub/contracts";
import { GenericHttpAdapter } from "./generic-http-adapter.js";
import { OidcAdapter } from "./oidc-adapter.js";
import { OpenAICompatibleAdapter } from "./openai-compatible-adapter.js";
import type { ConnectionDiagnosticAdapter } from "./types.js";

const adapters: Record<ServiceKind, ConnectionDiagnosticAdapter> = {
  VLLM: new OpenAICompatibleAdapter({ serviceName: "vLLM", defaultHealthPath: "/health" }),
  HERMES: new GenericHttpAdapter("Hermes agent", "/health"),
  SUPERMEMORY: new GenericHttpAdapter("Supermemory"),
  OIDC: new OidcAdapter(),
  MCP: new GenericHttpAdapter("MCP server", "/"),
  SIEM: new GenericHttpAdapter("SIEM endpoint"),
  NOTIFICATION: new GenericHttpAdapter("Notification endpoint"),
  OTHER: new GenericHttpAdapter("Service"),
};

export function adapterFor(kind: ServiceKind): ConnectionDiagnosticAdapter {
  return adapters[kind];
}
