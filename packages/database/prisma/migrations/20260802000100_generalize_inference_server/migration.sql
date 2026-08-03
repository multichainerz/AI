-- Generalize the serving-plane connection without changing the OpenAI-compatible
-- contract used by Chat and enrolled Hermes runtimes.
ALTER TYPE "ServiceKind" RENAME VALUE 'VLLM' TO 'INFERENCE';

UPDATE "ServiceConnection"
SET "configuration" = jsonb_set(
  COALESCE("configuration", '{}'::jsonb),
  '{inferenceBackend}',
  '"VLLM"'::jsonb,
  true
)
WHERE "kind" = 'INFERENCE'
  AND NOT COALESCE("configuration", '{}'::jsonb) ? 'inferenceBackend';

UPDATE "ComponentCompatibility"
SET "key" = 'inference-server',
    "displayName" = 'Inference Server',
    "expectedContract" = 'The selected OpenAI-compatible inference server passes model discovery, parser, streaming, cancellation, usage, load, and soak checks.'
WHERE "key" = 'vllm-inference';
