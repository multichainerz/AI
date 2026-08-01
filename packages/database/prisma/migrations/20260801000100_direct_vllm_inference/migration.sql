-- Preserve the previously effective chat route while retiring LiteLLM as an
-- architectural dependency. Existing direct-vLLM telemetry connections are
-- disabled when an enabled legacy chat gateway exists so the migrated system
-- cannot accidentally select two default inference connections.
UPDATE "ServiceConnection"
SET "enabled" = false,
    "status" = 'DISABLED'
WHERE "kind" = 'VLLM'
  AND EXISTS (
    SELECT 1
    FROM "ServiceConnection" legacy
    WHERE legacy."kind" = 'LITELLM'
      AND legacy."enabled" = true
  );

UPDATE "ServiceConnection"
SET "kind" = 'VLLM',
    "displayName" = replace("displayName", 'LiteLLM', 'vLLM')
WHERE "kind" = 'LITELLM';

ALTER TABLE "ServiceConnection"
  ALTER COLUMN "kind" TYPE TEXT USING "kind"::TEXT;

DROP TYPE "ServiceKind";

CREATE TYPE "ServiceKind" AS ENUM (
  'VLLM',
  'HERMES',
  'SUPERMEMORY',
  'OCR',
  'MCP',
  'OIDC',
  'SIEM',
  'NOTIFICATION',
  'OTHER'
);

ALTER TABLE "ServiceConnection"
  ALTER COLUMN "kind" TYPE "ServiceKind" USING "kind"::"ServiceKind";

UPDATE "ComponentCompatibility"
SET "key" = 'vllm-inference',
    "displayName" = 'vLLM inference',
    "expectedContract" = 'The configured vLLM endpoint exposes authenticated OpenAI-compatible model discovery, streaming chat completions, usage telemetry, and the selected model tool-call contract.',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'litellm-proxy';
