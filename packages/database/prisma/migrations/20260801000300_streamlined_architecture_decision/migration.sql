ALTER TABLE "PlatformArchitectureDecision"
  DROP COLUMN "installMethod",
  DROP COLUMN "localInference",
  DROP COLUMN "liteLlmOwnershipMode",
  DROP COLUMN "supermemoryStorageMode",
  DROP COLUMN "supermemoryEmbeddingMode",
  DROP COLUMN "hermesMemoryMode",
  DROP COLUMN "gpuSchedulingMode";

DROP TYPE "DeploymentInstallMethod";
DROP TYPE "LiteLlmOwnershipMode";
DROP TYPE "SupermemoryStorageMode";
DROP TYPE "SupermemoryEmbeddingMode";
DROP TYPE "HermesMemoryMode";
DROP TYPE "GpuSchedulingMode";
