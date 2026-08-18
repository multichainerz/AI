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
];
