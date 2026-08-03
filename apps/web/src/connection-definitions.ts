import type { InferenceBackend, ServiceConnectionConfiguration, ServiceKind } from "@orcasynapse/contracts";

export interface InferenceEndpointPreset {
  backend: InferenceBackend;
  label: string;
  description: string;
  defaultPort: number | null;
  endpointPlaceholder: string;
  endpointOptions: ReadonlyArray<{ label: string; value: string }>;
}

export const inferenceEndpointPresets: readonly InferenceEndpointPreset[] = [
  {
    backend: "VLLM",
    label: "vLLM",
    description: "High-throughput GPU inference for Hugging Face model deployments.",
    defaultPort: 8000,
    endpointPlaceholder: "http://gpu-server.internal:8000",
    endpointOptions: [
      { label: "Docker service · vllm:8000", value: "http://vllm:8000" },
      { label: "Docker Desktop host · port 8000", value: "http://host.docker.internal:8000" },
    ],
  },
  {
    backend: "LLAMA_CPP",
    label: "llama.cpp",
    description: "GGUF inference with flexible CPU and GPU offload.",
    defaultPort: 8080,
    endpointPlaceholder: "http://gpu-server.internal:8080",
    endpointOptions: [
      { label: "Docker service · llama-cpp:8080", value: "http://llama-cpp:8080" },
      { label: "Docker Desktop host · port 8080", value: "http://host.docker.internal:8080" },
    ],
  },
  {
    backend: "SGLANG",
    label: "SGLang",
    description: "GPU serving optimized for structured and agentic workloads.",
    defaultPort: 30_000,
    endpointPlaceholder: "http://gpu-server.internal:30000",
    endpointOptions: [
      { label: "Docker service · sglang:30000", value: "http://sglang:30000" },
      { label: "Docker Desktop host · port 30000", value: "http://host.docker.internal:30000" },
    ],
  },
  {
    backend: "OLLAMA",
    label: "Ollama",
    description: "Simple local model lifecycle with an OpenAI-compatible API.",
    defaultPort: 11_434,
    endpointPlaceholder: "http://inference-server.internal:11434",
    endpointOptions: [
      { label: "Docker service · ollama:11434", value: "http://ollama:11434" },
      { label: "Docker Desktop host · port 11434", value: "http://host.docker.internal:11434" },
    ],
  },
  {
    backend: "TGI",
    label: "Hugging Face TGI",
    description: "Hugging Face Text Generation Inference serving.",
    defaultPort: 80,
    endpointPlaceholder: "http://gpu-server.internal:80",
    endpointOptions: [
      { label: "Docker service · tgi:80", value: "http://tgi:80" },
      { label: "Docker Desktop host · port 80", value: "http://host.docker.internal:80" },
    ],
  },
  {
    backend: "CUSTOM_OPENAI_COMPATIBLE",
    label: "Other OpenAI-compatible server",
    description: "A custom backend exposing model discovery and chat completions.",
    defaultPort: null,
    endpointPlaceholder: "https://inference.internal",
    endpointOptions: [
      { label: "Private DNS example", value: "https://inference.internal" },
    ],
  },
] as const;

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
    kind: "INFERENCE",
    name: "AI Inference",
    role: "Enterprise OpenAI-compatible model serving",
    tone: "blue",
    secretFields: [{ name: "apiKey", label: "API key", required: false }],
    configurationFields: [
      {
        name: "inferenceBackend",
        label: "Inference backend",
        type: "select",
        defaultValue: "CUSTOM_OPENAI_COMPATIBLE",
        options: inferenceEndpointPresets.map(({ label, backend }) => ({ label, value: backend })),
        help: "Identifies the serving engine for operations and compatibility evidence; routing uses the OpenAI-compatible API contract.",
      },
      { name: "modelAlias", label: "Served model name", type: "text", placeholder: "hermes-primary", help: "Expected model ID exposed by the inference server." },
      { name: "healthPath", label: "Health path", type: "text", help: "Optional relative health endpoint discovered by OrcaSynapse or supplied by the server operator." },
      { name: "modelsPath", label: "Models path", type: "text", defaultValue: "/v1/models", help: "OpenAI-compatible model discovery endpoint." },
      { name: "chatPath", label: "Chat completions path", type: "text", defaultValue: "/v1/chat/completions", help: "OpenAI-compatible streaming chat endpoint." },
      { name: "maxOutputTokens", label: "Maximum output tokens", type: "number", defaultValue: 2048, min: 64, max: 32768, step: 64, help: "Hard output limit OrcaSynapse applies to direct diagnostic chat." },
      { name: "temperature", label: "Temperature", type: "number", defaultValue: 0.2, min: 0, max: 2, step: 0.1, help: "Sampling temperature for direct diagnostic chat." },
      { name: "inferenceTimeoutMs", label: "Inference timeout (ms)", type: "number", defaultValue: 120000, min: 5000, max: 600000, step: 5000, help: "Maximum duration for a streamed model response." },
      { name: "requestsPerMinute", label: "Requests per user / minute", type: "number", defaultValue: 12, min: 1, max: 120, step: 1, help: "PostgreSQL-enforced limit across the employee's conversations." },
      { name: "timeoutMs", label: "Diagnostic timeout (ms)", type: "number", defaultValue: 8000, help: "Allowed range: 1,000–30,000 milliseconds." },
    ],
  },
  {
    kind: "OIDC",
    name: "Enterprise Access",
    role: "OIDC, Microsoft Entra ID and role-based access",
    tone: "rose",
    endpointLabel: "Issuer URL",
    secretFields: [{ name: "clientSecret", label: "Client secret", required: true }],
    configurationFields: [
      { name: "clientId", label: "Client ID", type: "text", placeholder: "orcasynapse", help: "Application identifier registered with an OIDC provider such as Microsoft Entra ID or AD FS." },
      { name: "redirectUri", label: "Redirect URI", type: "text", placeholder: "https://orcasynapse.example.internal/api/v1/auth/oidc/callback", help: "Exact callback URI registered with the identity provider." },
      { name: "scopes", label: "Scopes", type: "text-list", defaultValue: ["openid", "profile", "email", "groups"], help: "Comma-separated OIDC scopes; openid is required." },
      { name: "groupsClaim", label: "Groups claim", type: "text", defaultValue: "groups", help: "Dot-separated ID-token claim containing group memberships." },
      { name: "allowedGroups", label: "Allowed groups", type: "text-list", help: "At least one comma-separated group is required. Access fails closed if none match." },
      { name: "platformAdminGroups", label: "Platform admin groups", type: "text-list", help: "Members receive the complete OrcaSynapse administrator scope set after OIDC verification." },
      { name: "securityAdminGroups", label: "Security admin groups", type: "text-list", help: "Members receive security policy, approval, identity, and audit administration scopes." },
      { name: "operationsAdminGroups", label: "Operations admin groups", type: "text-list", help: "Members receive operational control without credential or security-policy administration." },
      { name: "auditorGroups", label: "Auditor groups", type: "text-list", help: "Members receive read-only evidence and configuration scopes." },
      { name: "emailClaim", label: "Email claim", type: "text", defaultValue: "email", help: "ID-token claim used for the employee email address." },
      { name: "nameClaim", label: "Display-name claim", type: "text", defaultValue: "name", help: "ID-token claim shown in the OrcaSynapse interface." },
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
];
