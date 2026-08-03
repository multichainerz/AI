ALTER TABLE "GuardrailPolicy"
  ADD COLUMN "maxOutputCharacters" INTEGER NOT NULL DEFAULT 200000,
  ADD COLUMN "blockControlCharacters" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "blockCredentialPatterns" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "GuardrailPolicy" DROP COLUMN "liteLLMGuardrails";
