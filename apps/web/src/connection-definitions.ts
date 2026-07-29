import type { ServiceConnectionConfiguration, ServiceKind } from "@aihub/contracts";

export interface ConfigurationField {
  name: keyof ServiceConnectionConfiguration;
  label: string;
  type: "text" | "number" | "checkbox";
  defaultValue?: string | number | boolean;
  placeholder?: string;
  help: string;
}

export interface ConnectionDefinition {
  kind: ServiceKind;
  name: string;
  role: string;
  tone: string;
  secretFields: Array<{ name: string; label: string; required: boolean }>;
  configurationFields: ConfigurationField[];
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
    kind: "SUPERMEMORY",
    name: "Supermemory",
    role: "Knowledge and memory",
    tone: "cyan",
    secretFields: [{ name: "apiKey", label: "API key", required: true }],
    configurationFields: [
      { name: "healthPath", label: "Health path", type: "text", defaultValue: "/health", help: "Relative health endpoint exposed by the deployment." },
      { name: "timeoutMs", label: "Diagnostic timeout (ms)", type: "number", defaultValue: 8000, help: "Allowed range: 1,000–30,000 milliseconds." },
    ],
  },
  {
    kind: "SEAWEEDFS",
    name: "SeaweedFS",
    role: "Object storage",
    tone: "green",
    secretFields: [
      { name: "accessKeyId", label: "Access key ID", required: true },
      { name: "secretAccessKey", label: "Secret access key", required: true },
    ],
    configurationFields: [
      { name: "bucket", label: "Validation bucket", type: "text", placeholder: "aihub-documents", help: "Optional bucket checked instead of listing every bucket." },
      { name: "region", label: "S3 region", type: "text", defaultValue: "us-east-1", help: "Signing region used by the S3 client." },
      { name: "forcePathStyle", label: "Use path-style S3 URLs", type: "checkbox", defaultValue: true, help: "Recommended for an internal SeaweedFS S3 endpoint." },
      { name: "timeoutMs", label: "Diagnostic timeout (ms)", type: "number", defaultValue: 8000, help: "Allowed range: 1,000–30,000 milliseconds." },
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
      { name: "timeoutMs", label: "Diagnostic timeout (ms)", type: "number", defaultValue: 8000, help: "Allowed range: 1,000–30,000 milliseconds." },
    ],
  },
];
