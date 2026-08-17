import type { InferenceBackend, ServiceConnectionConfiguration, ServiceKind } from "@orcasynapse/contracts";

/** Friendly names for a backend discovery already identified. Not a form. */
export const inferenceEndpointPresets: ReadonlyArray<{ backend: InferenceBackend; label: string }> = [
  { backend: "VLLM", label: "vLLM" },
  { backend: "LLAMA_CPP", label: "llama.cpp" },
  { backend: "SGLANG", label: "SGLang" },
  { backend: "OLLAMA", label: "Ollama" },
  { backend: "TGI", label: "Hugging Face TGI" },
  { backend: "CUSTOM_OPENAI_COMPATIBLE", label: "OpenAI compatible" },
];

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
    configurationFields: [],
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
