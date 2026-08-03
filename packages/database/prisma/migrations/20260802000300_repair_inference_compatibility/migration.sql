INSERT INTO "ComponentCompatibility" (
  "key",
  "displayName",
  "category",
  "required",
  "expectedContract",
  "status",
  "createdAt",
  "updatedAt"
) VALUES (
  'inference-server',
  'Inference Server',
  'Inference',
  true,
  'The selected OpenAI-compatible inference server passes model discovery, parser, streaming, cancellation, usage, load, and soak checks.',
  'NOT_TESTED',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("key") DO UPDATE SET
  "displayName" = EXCLUDED."displayName",
  "category" = EXCLUDED."category",
  "required" = EXCLUDED."required",
  "expectedContract" = EXCLUDED."expectedContract",
  "updatedAt" = CURRENT_TIMESTAMP;
