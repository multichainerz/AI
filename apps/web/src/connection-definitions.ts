import type { ServiceConnectionConfiguration, ServiceKind } from "@aihub/contracts";

export interface ConfigurationField {
  name: keyof ServiceConnectionConfiguration;
  label: string;
  type: "text" | "number" | "checkbox" | "text-list" | "select";
  defaultValue?: string | number | boolean | string[];
  options?: ReadonlyArray<{ label: string; value: string }>;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  required?: boolean;
  help: string;
}

export interface ConnectionDefinition {
  kind: ServiceKind;
  name: string;
  role: string;
  tone: string;
  secretFields: Array<{ name: string; label: string; required: boolean }>;
  configurationFields: ConfigurationField[];
  endpointLabel?: string;
}

export const connectionDefinitions: ConnectionDefinition[] = [
  {
    kind: "LITELLM",
    name: "LiteLLM",
    role: "Inference gateway",
    tone: "violet",
    secretFields: [{ name: "apiKey", label: "API key", required: true }],
    configurationFields: [
      { name: "modelAlias", label: "Primary model alias", type: "text", placeholder: "hermes-primary", help: "Must appear in LiteLLM model discovery." },
      { name: "healthPath", label: "Health path", type: "text", defaultValue: "/health/liveliness", help: "Relative liveness endpoint on the configured origin." },
      { name: "modelsPath", label: "Models path", type: "text", defaultValue: "/v1/models", help: "OpenAI-compatible model discovery endpoint." },
      { name: "chatPath", label: "Chat completions path", type: "text", defaultValue: "/v1/chat/completions", help: "OpenAI-compatible streaming chat endpoint." },
      { name: "maxOutputTokens", label: "Maximum output tokens", type: "number", defaultValue: 2048, min: 64, max: 32768, step: 64, help: "Hard output limit applied by AIHub to each chat request." },
      { name: "temperature", label: "Temperature", type: "number", defaultValue: 0.2, min: 0, max: 2, step: 0.1, help: "Sampling temperature for the controlled pilot route." },
      { name: "inferenceTimeoutMs", label: "Inference timeout (ms)", type: "number", defaultValue: 120000, min: 5000, max: 600000, step: 5000, help: "Maximum duration for a streamed model response." },
      { name: "requestsPerMinute", label: "Requests per user / minute", type: "number", defaultValue: 12, min: 1, max: 120, step: 1, help: "PostgreSQL-enforced pilot limit across the employee's conversations." },
      { name: "timeoutMs", label: "Diagnostic timeout (ms)", type: "number", defaultValue: 8000, help: "Allowed range: 1,000–30,000 milliseconds." },
    ],
  },
  {
    kind: "VLLM",
    name: "vLLM",
    role: "Model serving",
    tone: "blue",
    secretFields: [{ name: "apiKey", label: "API key", required: false }],
    configurationFields: [
      { name: "modelAlias", label: "Served model name", type: "text", placeholder: "hermes-primary", help: "Expected model ID exposed by vLLM." },
      { name: "healthPath", label: "Health path", type: "text", defaultValue: "/health", help: "Relative vLLM health endpoint." },
      { name: "modelsPath", label: "Models path", type: "text", defaultValue: "/v1/models", help: "OpenAI-compatible model discovery endpoint." },
      { name: "timeoutMs", label: "Diagnostic timeout (ms)", type: "number", defaultValue: 8000, help: "Allowed range: 1,000–30,000 milliseconds." },
    ],
  },
  {
    kind: "HERMES",
    name: "Hermes",
    role: "Hardened agent runtime",
    tone: "violet",
    secretFields: [
      { name: "apiKey", label: "API server key", required: true },
      { name: "mcpGatewayToken", label: "AIHub MCP gateway token", required: false },
    ],
    configurationFields: [
      { name: "healthPath", label: "Health path", type: "text", defaultValue: "/health", help: "Hermes API server health endpoint." },
      { name: "capabilitiesPath", label: "Capabilities path", type: "text", defaultValue: "/v1/capabilities", help: "Machine-readable Hermes API boundary checked before every run." },
      { name: "toolsetsPath", label: "Toolsets path", type: "text", defaultValue: "/v1/toolsets", help: "AIHub refuses Phase 5 execution if any native Hermes toolset is enabled." },
      { name: "runsPath", label: "Runs path", type: "text", defaultValue: "/v1/runs", help: "Hermes asynchronous run submission, status, and stop route." },
      { name: "runPollIntervalMs", label: "Run polling interval (ms)", type: "number", defaultValue: 1000, min: 500, max: 10000, step: 500, help: "Polling interval used for status, cancellation, and timeout enforcement." },
      { name: "governedMcpUrl", label: "Governed MCP URL", type: "text", placeholder: "https://aihub.internal/api/v1/mcp/", help: "Server-reachable AIHub MCP endpoint passed only through Hermes private run context." },
      { name: "governedToolsetName", label: "Governed toolset name", type: "text", defaultValue: "aihub-governed-tools", help: "Exact Hermes toolset allowed when governed tools are active; all other enabled toolsets are denied." },
      { name: "timeoutMs", label: "Request timeout (ms)", type: "number", defaultValue: 8000, min: 1000, max: 30000, help: "Per-request timeout for Hermes control-plane calls." },
    ],
  },
  {
    kind: "SUPERMEMORY",
    name: "Supermemory",
    role: "Knowledge and memory",
    tone: "cyan",
    secretFields: [{ name: "apiKey", label: "API key", required: true }],
    configurationFields: [
      { name: "healthPath", label: "Health path", type: "text", defaultValue: "/health", help: "Relative health endpoint exposed by the deployment." },
      { name: "timeoutMs", label: "Diagnostic timeout (ms)", type: "number", defaultValue: 8000, help: "Allowed range: 1,000–30,000 milliseconds." },
      { name: "documentsPath", label: "Documents API path", type: "text", defaultValue: "/v3/documents", help: "Supermemory v3 ingest, status, and deletion route." },
      { name: "searchPath", label: "Document search path", type: "text", defaultValue: "/v3/search", help: "Chunk-level document retrieval route." },
      { name: "memoryTimeoutMs", label: "Indexing timeout (ms)", type: "number", defaultValue: 300000, help: "Maximum time to wait for a document to become searchable." },
      { name: "memoryPollIntervalMs", label: "Index polling interval (ms)", type: "number", defaultValue: 2000, help: "Delay between document status checks." },
      { name: "retrievalLimit", label: "Retrieval result limit", type: "number", defaultValue: 6, help: "Maximum approved sources added to one Chat request." },
      { name: "retrievalThreshold", label: "Chunk threshold", type: "number", defaultValue: 0.25, help: "Supermemory chunk sensitivity from 0 to 1." },
    ],
  },
  {
    kind: "OIDC",
    name: "Enterprise OIDC",
    role: "Employee identity and access",
    tone: "rose",
    endpointLabel: "Issuer URL",
    secretFields: [{ name: "clientSecret", label: "Client secret", required: true }],
    configurationFields: [
      { name: "clientId", label: "Client ID", type: "text", placeholder: "aihub", help: "Application identifier registered with the MPM identity provider." },
      { name: "redirectUri", label: "Redirect URI", type: "text", placeholder: "https://aihub.mpm.internal/api/v1/auth/oidc/callback", help: "Exact callback URI registered with the identity provider." },
      { name: "scopes", label: "Scopes", type: "text-list", defaultValue: ["openid", "profile", "email", "groups"], help: "Comma-separated OIDC scopes; openid is required." },
      { name: "groupsClaim", label: "Groups claim", type: "text", defaultValue: "groups", help: "Dot-separated ID-token claim containing group memberships." },
      { name: "allowedGroups", label: "Allowed groups", type: "text-list", help: "At least one comma-separated group is required. Access fails closed if none match." },
      { name: "emailClaim", label: "Email claim", type: "text", defaultValue: "email", help: "ID-token claim used for the employee email address." },
      { name: "nameClaim", label: "Display-name claim", type: "text", defaultValue: "name", help: "ID-token claim shown in the AIHub interface." },
      {
        name: "tokenAuthMethod",
        label: "Token endpoint authentication",
        type: "select",
        defaultValue: "client_secret_basic",
        options: [
          { label: "Client secret basic", value: "client_secret_basic" },
          { label: "Client secret post", value: "client_secret_post" },
        ],
        help: "Authentication method supported by the provider token endpoint.",
      },
      { name: "caseSensitiveGroups", label: "Case-sensitive group matching", type: "checkbox", defaultValue: false, help: "Disabled by default to avoid provider-specific casing mismatches." },
      { name: "timeoutMs", label: "Identity-provider timeout (ms)", type: "number", defaultValue: 10000, min: 1000, max: 30000, help: "Maximum time allowed for discovery, token, and key requests." },
    ],
  },
  {
    kind: "OCR",
    name: "Unlimited OCR",
    role: "Document extraction",
    tone: "amber",
    secretFields: [{ name: "apiKey", label: "API key", required: false }],
    configurationFields: [
      { name: "modelAlias", label: "OCR model name", type: "text", placeholder: "unlimited-ocr", help: "Expected model ID exposed by the OCR inference service." },
      { name: "healthPath", label: "Health path", type: "text", defaultValue: "/health", help: "Relative OCR health endpoint." },
      { name: "modelsPath", label: "Models path", type: "text", defaultValue: "/v1/models", help: "OpenAI-compatible model discovery endpoint." },
      { name: "chatPath", label: "OCR completions path", type: "text", defaultValue: "/v1/chat/completions", help: "OpenAI-compatible multimodal OCR endpoint." },
      { name: "inferenceTimeoutMs", label: "Per-page OCR timeout (ms)", type: "number", defaultValue: 180000, min: 5000, max: 600000, step: 5000, help: "Maximum time allowed to extract one converted page." },
      { name: "timeoutMs", label: "Diagnostic timeout (ms)", type: "number", defaultValue: 8000, help: "Allowed range: 1,000–30,000 milliseconds." },
    ],
  },
];
