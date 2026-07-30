import type {
  ArchitectureDecision,
  ComponentCompatibility,
  CompleteOnboarding,
  CredentialRecoveryControl,
  ExportRecoveryKit,
  OnboardingEvidence,
  OnboardingGate,
  OnboardingJourney,
  OnboardingSnapshot,
  OnboardingStep,
  ProductionReadiness,
  RecoveryKitExport,
  RunOnboardingValidation,
  UpdateArchitectureDecision,
  UpdateComponentCompatibility,
  UpdateOnboardingStep,
  VerifyRecoveryKit,
} from "@aihub/contracts";
import { Prisma, type AIHubPrismaClient } from "@aihub/database";
import {
  createCredentialRecoveryKit,
  credentialKeyFingerprint,
  recoveryKitChecksum,
  verifyCredentialRecoveryKit,
} from "@aihub/security";
import type { AdminPrincipal } from "../auth/admin-session.js";
import { OnboardingConflictError, OnboardingNotFoundError, type OnboardingManager } from "./onboarding-manager.js";

const COMPONENTS = [
  ["node-runtime", "Node.js runtime", "Application", true, "Pinned Node 24 runtime and Node 24 type definitions pass together."],
  ["typescript-toolchain", "TypeScript toolchain", "Application", true, "TypeScript, Vite, Vitest, Prisma generation, builds, and editor tooling pass together."],
  ["web-runtime", "React, Vite, and Nginx", "Application", true, "Pinned production bundle/server passes browser, accessibility, mobile, headers, and health acceptance."],
  ["fastify-api", "Fastify API", "Application", true, "Request/response schemas, limits, proxy behavior, streaming, and safe error serialization pass."],
  ["document-conversion", "LibreOffice and Poppler", "Documents", true, "Pinned isolated document conversion passes bounded-resource and malformed-input tests."],
  ["postgresql", "PostgreSQL", "Data", true, "Pinned PostgreSQL 17 patch passes connection, migration, backup, restore, and upgrade checks."],
  ["prisma-pg", "Prisma and pg", "Data", true, "Pinned adapter and driver pass pool, timeout, migration, and drift checks."],
  ["pg-boss", "pg-boss", "Data", true, "Transactional enqueue, retries, dead letters, schedules, idempotency, and reconciliation pass."],
  ["litellm-proxy", "LiteLLM Proxy", "Inference", true, "The single inference gateway passes alias, budget, guardrail, routing, error, and usage checks."],
  ["litellm-management-api", "LiteLLM management API", "Inference", false, "Selected reconciliation mode passes desired-state, drift, audit, and rollback tests."],
  ["vllm-laguna", "vLLM and Laguna NVFP4", "Inference", false, "Selected local serving stack passes model, driver, parser, streaming, cancellation, load, and soak checks."],
  ["unlimited-ocr", "Unlimited-OCR", "Documents", true, "Pinned OCR adapter passes schema, corpus, malformed-input, limit, and cancellation checks."],
  ["supermemory-local", "Supermemory API", "Memory", true, "Selected Supermemory deployment passes API, isolation, deletion, telemetry, backup, and restore checks."],
  ["supermemory-external-backend", "Supermemory external backend", "Memory", false, "Selected Supermemory backend passes edition, isolation, recovery, and upgrade checks."],
  ["qwen3-embedding", "Qwen3 embedding route", "Memory", false, "Selected external embedding route passes revision, dimension, retrieval, and rebuild checks."],
  ["hermes-api", "Hermes API Server", "Agents", true, "Pinned Hermes passes capabilities, Runs, SSE, stop, Profile, Skill, Toolset, and state.db checks."],
  ["hermes-runtime-node", "Hermes runtime node", "Agents", false, "An isolated Hermes node completes one-time enrollment, proves its signing identity, and maintains a current heartbeat without standing SSH trust."],
  ["hermes-native-memory", "Hermes native Supermemory provider", "Agents", false, "Selected native provider passes scope, synchronization, retention, deletion, and leakage checks."],
  ["mcp-gateway", "MCP gateway", "Tools", true, "Pinned protocol passes negotiation, discovery, calls, cancellation, authorization, and token-boundary checks."],
  ["enterprise-oidc", "Enterprise OIDC", "Identity", false, "Production identity passes discovery, signatures, PKCE, state, nonce, groups, logout, and revocation."],
  ["signed-installer", "AIHub signed installer", "Deployment", true, "The signed release-bundle installer passes clean install, isolation, upgrade, rollback, and recovery."],
  ["gpu-capacity", "Local GPU capacity", "Infrastructure", false, "Selected local inference stack passes admitted context, concurrency, contention, thermal, and recovery tests."],
] as const;

const STEPS = [
  ["claim-installation", 1, "Claim installation", "Confirm the single-use installation claim, installed release, and host identity.", "Run installation validation"],
  ["system-topology", 2, "System and topology", "Validate the host and select Compact, Control-plane only, or Segmented production.", "Save topology, then validate this host"],
  ["identity-recovery", 3, "Identity and recovery", "Configure final trust, enterprise identity, recovery ownership, and a verified encrypted recovery kit.", "Export and verify recovery; configure OIDC for Production"],
  ["ai-services", 4, "AI services and Hermes node", "Connect LiteLLM, Unlimited-OCR, and Supermemory, then enroll and validate the isolated Hermes runtime.", "Test the service routes, then enroll the Hermes VM"],
  ["knowledge-workflow", 5, "Knowledge workflow", "Validate transient extraction, publication, authorized retrieval/deletion, and scratch purge.", "Process and publish a representative document"],
  ["hermes-profiles", 6, "Hermes and Profiles", "Validate the Hermes boundary and move an immutable Profile Distribution into standby.", "Create, evaluate, and validate a standby Profile"],
  ["guardrails-tools", 7, "Guardrails and tools", "Prove conservative policy, zero-tool operation, approvals, and bounded governed tools.", "Activate a guardrail baseline and validate tool posture"],
  ["validate-activate", 8, "Validate and activate", "Run the target-environment gate and record Development, Pilot, or Production activation.", "Run all validation and resolve remaining blockers"],
] as const;

const CANONICAL_STEP_KEYS = STEPS.map(([key]) => key);
const CORE_RUNTIME_COMPONENTS = new Set(["postgresql", "litellm-proxy", "unlimited-ocr", "supermemory-local", "hermes-api", "mcp-gateway"]);

type StoredArchitecture = Prisma.PlatformArchitectureDecisionGetPayload<object>;
type StoredComponent = Prisma.ComponentCompatibilityGetPayload<object>;
type StoredJourney = Prisma.OnboardingJourneyGetPayload<object>;
type StoredStep = Prisma.OnboardingStepGetPayload<object>;
type StoredEvidence = Prisma.OnboardingEvidenceGetPayload<object>;
type StoredRecovery = Prisma.CredentialRecoveryControlGetPayload<object>;

interface ValidationCheck {
  stageKey: string;
  componentKey?: string;
  outcome: "PASSED" | "FAILED" | "WARNING";
  code: string;
  summary: string;
  observedVersion?: string;
  details?: Record<string, string | number | boolean | null>;
}

function architectureDto(value: StoredArchitecture): ArchitectureDecision {
  return {
    topologyMode: value.topologyMode,
    targetEnvironment: value.targetEnvironment,
    installMethod: value.installMethod,
    localInference: value.localInference,
    liteLlmOwnershipMode: value.liteLlmOwnershipMode,
    supermemoryStorageMode: value.supermemoryStorageMode,
    supermemoryEmbeddingMode: value.supermemoryEmbeddingMode,
    hermesMemoryMode: value.hermesMemoryMode,
    gpuSchedulingMode: value.gpuSchedulingMode,
    reason: value.reason,
    revision: value.revision,
    updatedBy: value.updatedBy,
    updatedAt: value.updatedAt.toISOString(),
  };
}

function componentRequirement(architecture: ArchitectureDecision, component: StoredComponent): { required: boolean; reason: string } {
  const production = architecture.targetEnvironment === "PRODUCTION";
  let required = production ? component.required : CORE_RUNTIME_COMPONENTS.has(component.key);
  let reason = required ? `${architecture.targetEnvironment.toLowerCase()} runtime baseline` : "Not required by the selected target";
  const selected: Array<[boolean, string, string]> = [
    [component.key === "enterprise-oidc" && production, "Production requires enterprise identity", "enterprise-oidc"],
    [component.key === "signed-installer", "The supported AIHub release-bundle installer path must pass", "signed-installer"],
    [component.key === "vllm-laguna" && architecture.localInference, "Local inference was selected", "vllm-laguna"],
    [component.key === "gpu-capacity" && architecture.localInference, "Local inference requires measured GPU admission", "gpu-capacity"],
    [component.key === "litellm-management-api" && architecture.liteLlmOwnershipMode === "PINNED_API_RECONCILED", "LiteLLM reconciliation mode was selected", "litellm-management-api"],
    [component.key === "supermemory-external-backend" && architecture.supermemoryStorageMode === "SUPPORTED_EXTERNAL_POSTGRES", "A supported external Supermemory backend was selected", "supermemory-external-backend"],
    [component.key === "qwen3-embedding" && architecture.supermemoryEmbeddingMode === "OPENAI_COMPATIBLE", "An external embedding route was selected", "qwen3-embedding"],
    [component.key === "hermes-native-memory" && architecture.hermesMemoryMode === "NATIVE_SUPERMEMORY", "Hermes native Supermemory mode was selected", "hermes-native-memory"],
    [component.key === "hermes-runtime-node" && architecture.topologyMode !== "COMPACT", "The selected topology isolates Hermes from the AIHub control plane", "hermes-runtime-node"],
  ];
  for (const [condition, selectedReason, key] of selected) {
    if (condition && component.key === key) {
      required = true;
      reason = selectedReason;
    }
  }
  if (component.key === "enterprise-oidc" && !production) reason = "OIDC is recommended now and becomes blocking for Production";
  if (["vllm-laguna", "gpu-capacity"].includes(component.key) && !architecture.localInference) reason = "Inference is provided behind an external LiteLLM gateway";
  return { required, reason };
}

function componentDto(value: StoredComponent, architecture: ArchitectureDecision, evidence?: StoredEvidence): ComponentCompatibility {
  const requirement = componentRequirement(architecture, value);
  return {
    key: value.key,
    displayName: value.displayName,
    category: value.category,
    required: requirement.required,
    requirementReason: requirement.reason,
    expectedContract: value.expectedContract,
    status: value.status,
    evidenceSource: evidence?.source ?? null,
    observedVersion: value.observedVersion,
    evidenceRef: value.evidenceRef,
    note: value.note,
    testedAt: value.testedAt?.toISOString() ?? null,
    updatedBy: value.updatedBy,
    revision: value.revision,
    updatedAt: value.updatedAt.toISOString(),
  };
}

function journeyDto(value: StoredJourney): OnboardingJourney {
  return {
    status: value.status,
    currentStepKey: value.currentStepKey && CANONICAL_STEP_KEYS.includes(value.currentStepKey as typeof CANONICAL_STEP_KEYS[number])
      ? value.currentStepKey as OnboardingJourney["currentStepKey"]
      : null,
    activatedEnvironment: value.activatedEnvironment,
    reason: value.reason,
    revision: value.revision,
    startedAt: value.startedAt?.toISOString() ?? null,
    completedAt: value.completedAt?.toISOString() ?? null,
    updatedBy: value.updatedBy,
    updatedAt: value.updatedAt.toISOString(),
  };
}

function stageDefinition(key: string): typeof STEPS[number] | undefined {
  return STEPS.find(([candidate]) => candidate === key);
}

function stepDto(value: StoredStep, architecture: ArchitectureDecision): OnboardingStep {
  const definition = stageDefinition(value.key);
  const required = value.key !== "validate-activate" && (value.key !== "identity-recovery" || architecture.targetEnvironment === "PRODUCTION");
  return {
    key: value.key as OnboardingStep["key"],
    ordinal: value.ordinal,
    title: value.title,
    description: value.description,
    required,
    automated: true,
    action: definition?.[4] ?? "Run validation",
    status: value.status,
    evidenceRefs: value.evidenceRefs,
    note: value.note,
    revision: value.revision,
    updatedBy: value.updatedBy,
    completedAt: value.completedAt?.toISOString() ?? null,
    updatedAt: value.updatedAt.toISOString(),
  };
}

function recoveryDto(value: StoredRecovery): CredentialRecoveryControl {
  return {
    status: value.verifiedAt ? "VERIFIED" : value.exportedAt ? "EXPORTED" : "NOT_EXPORTED",
    keyFingerprint: value.keyFingerprint,
    kitChecksum: value.kitChecksum,
    recoveryOwner: value.recoveryOwner,
    exportedAt: value.exportedAt?.toISOString() ?? null,
    verifiedAt: value.verifiedAt?.toISOString() ?? null,
    revision: value.revision,
  };
}

function detailsRecord(value: Prisma.JsonValue): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function evidenceDto(value: StoredEvidence): OnboardingEvidence {
  return {
    id: value.id,
    stageKey: value.stageKey as OnboardingEvidence["stageKey"],
    componentKey: value.componentKey,
    source: value.source,
    outcome: value.outcome,
    code: value.code,
    summary: value.summary,
    observedVersion: value.observedVersion,
    details: detailsRecord(value.details),
    createdBy: value.createdBy,
    createdAt: value.createdAt.toISOString(),
    expiresAt: value.expiresAt?.toISOString() ?? null,
  };
}

export function calculateOnboardingGate(
  architecture: ArchitectureDecision,
  components: ComponentCompatibility[],
  steps: OnboardingStep[],
  recovery?: CredentialRecoveryControl,
  productionReadinessStatus?: ProductionReadiness["status"] | "UNAVAILABLE",
): OnboardingGate {
  const requiredComponents = components.filter((item) => item.required);
  const requiredSteps = steps.filter((item) => item.required);
  const blockers = [
    ...requiredComponents.filter((item) => item.status !== "PASSED").map((item) => `${item.displayName}: ${item.status.toLowerCase().replaceAll("_", " ")}`),
    ...requiredSteps.filter((item) => item.status !== "COMPLETED").map((item) => `${item.title}: ${item.status.toLowerCase().replaceAll("_", " ")}`),
  ];
  if (architecture.targetEnvironment === "PRODUCTION" && recovery?.status !== "VERIFIED") {
    blockers.push("Credential recovery: an encrypted off-host recovery kit must be verified");
  }
  if (architecture.targetEnvironment === "PRODUCTION" && productionReadinessStatus !== "READY") {
    blockers.push(productionReadinessStatus === "UNAVAILABLE"
      ? "Production readiness: the Phase 8 readiness authority is unavailable"
      : `Production readiness: Phase 8 status is ${(productionReadinessStatus ?? "NOT_READY").toLowerCase().replaceAll("_", " ")}`);
  }
  const warnings = components
    .filter((item) => !item.required && ["FAILED", "BLOCKED"].includes(item.status))
    .map((item) => `${item.displayName}: optional contract is ${item.status.toLowerCase()}`);
  return {
    ready: blockers.length === 0,
    targetEnvironment: architecture.targetEnvironment,
    requiredComponents: requiredComponents.length,
    passedComponents: requiredComponents.filter((item) => item.status === "PASSED").length,
    requiredSteps: requiredSteps.length,
    completedSteps: requiredSteps.filter((item) => item.status === "COMPLETED").length,
    blockers: blockers.slice(0, 100),
    warnings: warnings.slice(0, 100),
  };
}

export class PrismaOnboardingManager implements OnboardingManager {
  readonly #masterKey: Uint8Array | undefined;

  constructor(
    private readonly prisma: AIHubPrismaClient,
    masterKey?: Uint8Array,
    private readonly readiness?: { productionReadiness(): Promise<ProductionReadiness> },
  ) {
    this.#masterKey = masterKey ? new Uint8Array(masterKey) : undefined;
  }

  private async ensureState(): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      for (const [key, displayName, category, required, expectedContract] of COMPONENTS) {
        await transaction.componentCompatibility.upsert({
          where: { key },
          create: { key, displayName, category, required, expectedContract },
          update: { displayName, category, required, expectedContract },
        });
      }
      await transaction.componentCompatibility.deleteMany({
        where: { category: "Deployment", key: { not: "signed-installer" } },
      });
      for (const [key, ordinal, title, description] of STEPS) {
        await transaction.onboardingStep.upsert({
          where: { key },
          create: { key, ordinal, title, description, required: true },
          update: { ordinal, title, description, required: true },
        });
      }
      await transaction.onboardingStep.updateMany({
        where: { key: { notIn: CANONICAL_STEP_KEYS } },
        data: { required: false },
      });
      await transaction.platformArchitectureDecision.upsert({ where: { id: "global" }, create: { id: "global" }, update: {} });
      await transaction.onboardingJourney.upsert({ where: { id: "global" }, create: { id: "global", currentStepKey: "claim-installation" }, update: {} });
      await transaction.credentialRecoveryControl.upsert({ where: { id: "global" }, create: { id: "global" }, update: {} });
    });
  }

  async snapshot(): Promise<OnboardingSnapshot> {
    await this.ensureState();
    const [architecture, journey, components, steps, installationClaim, recovery, evidence] = await Promise.all([
      this.prisma.platformArchitectureDecision.findUniqueOrThrow({ where: { id: "global" } }),
      this.prisma.onboardingJourney.findUniqueOrThrow({ where: { id: "global" } }),
      this.prisma.componentCompatibility.findMany({ orderBy: [{ category: "asc" }, { displayName: "asc" }] }),
      this.prisma.onboardingStep.findMany({ where: { key: { in: CANONICAL_STEP_KEYS } }, orderBy: { ordinal: "asc" } }),
      this.prisma.installationClaim.findUnique({ where: { id: "initial" } }),
      this.prisma.credentialRecoveryControl.findUniqueOrThrow({ where: { id: "global" } }),
      this.prisma.onboardingEvidence.findMany({ orderBy: { createdAt: "desc" }, take: 100 }),
    ]);
    const architectureValue = architectureDto(architecture);
    const componentEvidenceByRef = new Map(evidence.map((item) => [`validation:${item.id}`, item]));
    const componentValues = components.map((item) => componentDto(item, architectureValue, item.evidenceRef ? componentEvidenceByRef.get(item.evidenceRef) : undefined));
    const stepValues = steps.map((item) => stepDto(item, architectureValue));
    const recoveryValue = recoveryDto(recovery);
    let productionReadinessStatus: ProductionReadiness["status"] | "UNAVAILABLE" | undefined;
    if (architectureValue.targetEnvironment === "PRODUCTION") {
      try {
        productionReadinessStatus = this.readiness
          ? (await this.readiness.productionReadiness()).status
          : "UNAVAILABLE";
      } catch {
        productionReadinessStatus = "UNAVAILABLE";
      }
    }
    return {
      generatedAt: new Date().toISOString(),
      installation: { status: installationClaim?.redeemedAt ? "CLAIMED" : "UNKNOWN", claimedAt: installationClaim?.redeemedAt?.toISOString() ?? null },
      architecture: architectureValue,
      recovery: recoveryValue,
      journey: journeyDto(journey),
      components: componentValues,
      steps: stepValues,
      evidence: evidence.map(evidenceDto),
      gate: calculateOnboardingGate(architectureValue, componentValues, stepValues, recoveryValue, productionReadinessStatus),
    };
  }

  async updateArchitecture(principal: AdminPrincipal, input: UpdateArchitectureDecision): Promise<ArchitectureDecision> {
    await this.ensureState();
    const updated = await this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('aihub-phase9-architecture', 0))`;
      const [current, journey] = await Promise.all([
        transaction.platformArchitectureDecision.findUniqueOrThrow({ where: { id: "global" } }),
        transaction.onboardingJourney.findUniqueOrThrow({ where: { id: "global" } }),
      ]);
      if (current.revision !== input.expectedRevision) throw new OnboardingConflictError("Architecture decisions changed in another session. Refresh and try again.");
      const architectureChanged =
        (input.topologyMode !== undefined && input.topologyMode !== current.topologyMode) ||
        (input.targetEnvironment !== undefined && input.targetEnvironment !== current.targetEnvironment) ||
        (input.installMethod !== undefined && input.installMethod !== current.installMethod) ||
        (input.localInference !== undefined && input.localInference !== current.localInference) ||
        (input.liteLlmOwnershipMode !== undefined && input.liteLlmOwnershipMode !== current.liteLlmOwnershipMode) ||
        (input.supermemoryStorageMode !== undefined && input.supermemoryStorageMode !== current.supermemoryStorageMode) ||
        (input.supermemoryEmbeddingMode !== undefined && input.supermemoryEmbeddingMode !== current.supermemoryEmbeddingMode) ||
        (input.hermesMemoryMode !== undefined && input.hermesMemoryMode !== current.hermesMemoryMode) ||
        (input.gpuSchedulingMode !== undefined && input.gpuSchedulingMode !== current.gpuSchedulingMode);
      const changedFields = Object.keys(input).filter((key) => key !== "expectedRevision" && key !== "reason");
      const data: Prisma.PlatformArchitectureDecisionUpdateInput = { reason: input.reason, updatedBy: principal.id, revision: { increment: 1 } };
      if (input.topologyMode !== undefined) data.topologyMode = input.topologyMode;
      if (input.targetEnvironment !== undefined) data.targetEnvironment = input.targetEnvironment;
      if (input.installMethod !== undefined) data.installMethod = input.installMethod;
      if (input.localInference !== undefined) data.localInference = input.localInference;
      if (input.liteLlmOwnershipMode !== undefined) data.liteLlmOwnershipMode = input.liteLlmOwnershipMode;
      if (input.supermemoryStorageMode !== undefined) data.supermemoryStorageMode = input.supermemoryStorageMode;
      if (input.supermemoryEmbeddingMode !== undefined) data.supermemoryEmbeddingMode = input.supermemoryEmbeddingMode;
      if (input.hermesMemoryMode !== undefined) data.hermesMemoryMode = input.hermesMemoryMode;
      if (input.gpuSchedulingMode !== undefined) data.gpuSchedulingMode = input.gpuSchedulingMode;
      const saved = await transaction.platformArchitectureDecision.update({ where: { id: "global" }, data });
      if (architectureChanged) {
        await transaction.componentCompatibility.updateMany({
          data: {
            status: "NOT_TESTED",
            observedVersion: null,
            evidenceRef: null,
            note: "Architecture changed; revalidation is required.",
            testedAt: null,
            updatedBy: principal.id,
            revision: { increment: 1 },
          },
        });
        await transaction.onboardingStep.updateMany({
          where: { key: { in: CANONICAL_STEP_KEYS.filter((key) => key !== "claim-installation") } },
          data: {
            status: "NOT_STARTED",
            evidenceRefs: [],
            note: "Architecture changed; rerun this validation stage.",
            completedAt: null,
            updatedBy: principal.id,
            revision: { increment: 1 },
          },
        });
      }
      await transaction.onboardingJourney.update({
        where: { id: "global" },
        data: { status: "IN_PROGRESS", startedAt: journey.startedAt ?? new Date(), completedAt: null, activatedEnvironment: null, currentStepKey: "system-topology", updatedBy: principal.id, reason: input.reason, revision: { increment: 1 } },
      });
      await transaction.auditEvent.create({ data: {
        actorType: "USER", actorId: principal.id, action: "onboarding.architecture_updated",
        resourceType: "PlatformArchitectureDecision", resourceId: "global", outcome: "SUCCESS",
        metadata: { changedFields, evidenceInvalidated: architectureChanged, revision: saved.revision, reason: input.reason },
      } });
      return saved;
    });
    return architectureDto(updated);
  }

  async updateComponent(principal: AdminPrincipal, key: string, input: UpdateComponentCompatibility): Promise<OnboardingSnapshot> {
    await this.ensureState();
    await this.prisma.$transaction(async (transaction) => {
      const existing = await transaction.componentCompatibility.findUnique({ where: { key } });
      if (!existing) throw new OnboardingNotFoundError("The component contract does not exist.");
      const changed = await transaction.componentCompatibility.updateMany({
        where: { key, revision: input.expectedRevision },
        data: {
          status: input.status,
          observedVersion: input.observedVersion ?? null,
          evidenceRef: input.evidenceRef ?? null,
          note: input.note,
          testedAt: ["PASSED", "FAILED"].includes(input.status) ? new Date() : null,
          updatedBy: principal.id,
          revision: { increment: 1 },
        },
      });
      if (changed.count !== 1) throw new OnboardingConflictError("The component contract changed in another session. Refresh and try again.");
      await transaction.onboardingEvidence.create({ data: {
        stageKey: "validate-activate",
        componentKey: key,
        source: "EXTERNAL_ATTESTATION",
        outcome: input.status === "PASSED" ? "PASSED" : input.status === "FAILED" ? "FAILED" : "WARNING",
        code: `external-attestation-${key}`,
        summary: input.note,
        observedVersion: input.observedVersion ?? null,
        details: { authority: input.attestationAuthority ?? "not-supplied", evidenceRef: input.evidenceRef ?? null },
        createdBy: principal.id,
      } });
      await transaction.onboardingJourney.update({ where: { id: "global" }, data: { status: input.status === "BLOCKED" ? "BLOCKED" : "IN_PROGRESS", completedAt: null, activatedEnvironment: null, updatedBy: principal.id, revision: { increment: 1 } } });
    });
    return this.snapshot();
  }

  async updateStep(principal: AdminPrincipal, key: string, input: UpdateOnboardingStep): Promise<OnboardingSnapshot> {
    if (input.status === "COMPLETED") throw new OnboardingConflictError("Technical stages complete only from automated validation evidence.");
    await this.ensureState();
    const changed = await this.prisma.onboardingStep.updateMany({
      where: { key: { equals: key, in: CANONICAL_STEP_KEYS }, revision: input.expectedRevision },
      data: { status: input.status, note: input.note, updatedBy: principal.id, revision: { increment: 1 } },
    });
    if (changed.count !== 1) throw new OnboardingConflictError("The onboarding stage changed in another session. Refresh and try again.");
    return this.snapshot();
  }

  async exportRecoveryKit(principal: AdminPrincipal, input: ExportRecoveryKit): Promise<RecoveryKitExport> {
    if (!this.#masterKey) throw new OnboardingConflictError("The AIHub credential-encryption key is unavailable.");
    await this.ensureState();
    const created = await createCredentialRecoveryKit(this.#masterKey, input.passphrase);
    const changed = await this.prisma.credentialRecoveryControl.updateMany({
      where: { id: "global", revision: input.expectedRevision },
      data: {
        keyFingerprint: created.keyFingerprint,
        kitChecksum: created.checksum,
        recoveryOwner: input.recoveryOwner,
        exportedAt: new Date(),
        exportedBy: principal.id,
        verifiedAt: null,
        verifiedBy: null,
        revision: { increment: 1 },
      },
    });
    if (changed.count !== 1) throw new OnboardingConflictError("Recovery state changed in another session. Refresh and try again.");
    await this.prisma.auditEvent.create({ data: {
      actorType: "USER", actorId: principal.id, action: "onboarding.recovery_kit_exported",
      resourceType: "CredentialRecoveryControl", resourceId: "global", outcome: "SUCCESS",
      metadata: { checksum: created.checksum, keyFingerprint: created.keyFingerprint, recoveryOwner: input.recoveryOwner },
    } });
    return {
      fileName: `aihub-recovery-${created.keyFingerprint.slice(0, 12)}.json`,
      serializedKit: created.serialized,
      checksum: created.checksum,
      keyFingerprint: created.keyFingerprint,
    };
  }

  async verifyRecoveryKit(principal: AdminPrincipal, input: VerifyRecoveryKit): Promise<OnboardingSnapshot> {
    if (!this.#masterKey) throw new OnboardingConflictError("The AIHub credential-encryption key is unavailable.");
    const parsed = await verifyCredentialRecoveryKit(input.serializedKit, input.passphrase, this.#masterKey);
    const checksum = recoveryKitChecksum(input.serializedKit);
    const current = await this.prisma.credentialRecoveryControl.findUniqueOrThrow({ where: { id: "global" } });
    if (current.revision !== input.expectedRevision || current.kitChecksum !== checksum || current.keyFingerprint !== parsed.keyFingerprint) {
      throw new OnboardingConflictError("Verify the most recently exported recovery kit against the current recovery revision.");
    }
    const changed = await this.prisma.credentialRecoveryControl.updateMany({
      where: { id: "global", revision: input.expectedRevision, kitChecksum: checksum },
      data: { verifiedAt: new Date(), verifiedBy: principal.id, revision: { increment: 1 } },
    });
    if (changed.count !== 1) throw new OnboardingConflictError("Recovery state changed in another session. Refresh and try again.");
    await this.prisma.auditEvent.create({ data: {
      actorType: "USER", actorId: principal.id, action: "onboarding.recovery_kit_verified",
      resourceType: "CredentialRecoveryControl", resourceId: "global", outcome: "SUCCESS",
      metadata: { checksum, keyFingerprint: credentialKeyFingerprint(this.#masterKey) },
    } });
    return this.runValidation(principal, { stageKey: "identity-recovery" });
  }

  private async validationChecks(stageKey: string, architecture: ArchitectureDecision): Promise<ValidationCheck[]> {
    const contractOutcome = (passed: boolean): ValidationCheck["outcome"] => passed
      ? architecture.targetEnvironment === "PRODUCTION" ? "WARNING" : "PASSED"
      : "FAILED";
    if (stageKey === "claim-installation") {
      const claim = await this.prisma.installationClaim.findUnique({ where: { id: "initial" } });
      return [{ stageKey, outcome: claim?.redeemedAt ? "PASSED" : "FAILED", code: "installation-claim", summary: claim?.redeemedAt ? "The single-use installation claim was consumed successfully." : "No consumed installation claim is recorded." }];
    }
    if (stageKey === "system-topology") {
      const versionRows = await this.prisma.$queryRaw<Array<{ version: string }>>`SELECT version()`;
      return [
        { stageKey, componentKey: "node-runtime", outcome: contractOutcome(process.versions.node.startsWith("24.")), code: "node-runtime", summary: `AIHub is running on Node ${process.versions.node}; Production still requires the retained compatibility suite.`, observedVersion: process.versions.node },
        { stageKey, componentKey: "postgresql", outcome: contractOutcome(Boolean(versionRows[0]?.version)), code: "postgresql-connectivity", summary: versionRows[0]?.version ? "PostgreSQL accepted a live query through Prisma; Production still requires backup, restore, and upgrade evidence." : "PostgreSQL version could not be read.", ...(versionRows[0]?.version ? { observedVersion: versionRows[0].version.slice(0, 240) } : {}) },
        { stageKey, componentKey: "prisma-pg", outcome: contractOutcome(true), code: "prisma-database-path", summary: "Prisma and the PostgreSQL driver completed the onboarding query path; Production still requires pool, timeout, and drift evidence.", observedVersion: "7.9.1" },
        { stageKey, componentKey: "fastify-api", outcome: contractOutcome(true), code: "api-runtime", summary: "The authenticated onboarding API is operational; Production still requires its retained contract and negative-security suite.", observedVersion: "0.1.0" },
        { stageKey, outcome: architecture.reason ? "PASSED" : "FAILED", code: "topology-decision", summary: architecture.reason ? `${architecture.topologyMode.toLowerCase().replaceAll("_", " ")} topology is recorded for ${architecture.targetEnvironment.toLowerCase()}.` : "Save a topology decision and rationale before validation." },
      ];
    }
    if (stageKey === "identity-recovery") {
      const [recovery, oidc] = await Promise.all([
        this.prisma.credentialRecoveryControl.findUnique({ where: { id: "global" } }),
        this.prisma.serviceConnection.findFirst({ where: { kind: "OIDC", enabled: true }, orderBy: { updatedAt: "desc" } }),
      ]);
      const production = architecture.targetEnvironment === "PRODUCTION";
      const oidcConfiguration = oidc?.configuration && typeof oidc.configuration === "object" && !Array.isArray(oidc.configuration)
        ? oidc.configuration as Record<string, unknown>
        : {};
      const administratorGroupKeys = ["platformAdminGroups", "securityAdminGroups", "operationsAdminGroups", "auditorGroups"];
      const administratorGroupsConfigured = administratorGroupKeys.some((key) => Array.isArray(oidcConfiguration[key]) && oidcConfiguration[key].length > 0);
      const enterpriseIdentityReady = oidc?.status === "HEALTHY" && (!production || administratorGroupsConfigured);
      return [
        { stageKey, outcome: recovery?.verifiedAt ? "PASSED" : production ? "FAILED" : "WARNING", code: "credential-recovery", summary: recovery?.verifiedAt ? "The current encrypted recovery kit was verified." : production ? "Production requires a verified encrypted off-host recovery kit." : "Recovery verification is recommended now and required for Production." },
        { stageKey, componentKey: "enterprise-oidc", outcome: enterpriseIdentityReady ? contractOutcome(true) : production ? "FAILED" : "WARNING", code: "enterprise-identity", summary: enterpriseIdentityReady ? "An enabled enterprise OIDC connection is healthy and has administrator group mapping; Production still requires a retained login, logout, and revocation exercise." : production && oidc?.status === "HEALTHY" ? "Production requires at least one OIDC administrator group mapping." : production ? "Production requires an enabled healthy enterprise OIDC connection." : "Enterprise OIDC can be completed before Production activation." },
      ];
    }
    if (stageKey === "ai-services") {
      const [connections, runtimeNode] = await Promise.all([
        this.prisma.serviceConnection.findMany({
          where: { kind: { in: ["LITELLM", "OCR", "SUPERMEMORY", "HERMES"] }, enabled: true },
          orderBy: { updatedAt: "desc" },
        }),
        architecture.topologyMode === "COMPACT" ? Promise.resolve(null) : this.prisma.hermesRuntimeNode.findFirst({
          where: { status: "ONLINE", identityFingerprint: { not: null }, lastSeenAt: { gt: new Date(Date.now() - 180_000) } },
          orderBy: { lastSeenAt: "desc" },
          include: { serviceConnection: { select: { status: true } } },
        }),
      ]);
      const required: Array<["LITELLM" | "OCR" | "SUPERMEMORY" | "HERMES", string, string]> = [
        ["LITELLM", "litellm-proxy", "LiteLLM"], ["OCR", "unlimited-ocr", "Unlimited-OCR"],
        ["SUPERMEMORY", "supermemory-local", "Supermemory"], ["HERMES", "hermes-api", "Hermes"],
      ];
      const serviceChecks = required.map(([kind, componentKey, label]) => {
        const connection = connections.find((item) => item.kind === kind);
        return { stageKey, componentKey, outcome: contractOutcome(connection?.status === "HEALTHY"), code: `service-${kind.toLowerCase()}`, summary: connection?.status === "HEALTHY" ? `${label} has an enabled healthy connection; Production still requires its retained compatibility suite.` : `${label} requires an enabled connection with a current successful diagnostic.` };
      });
      if (architecture.topologyMode === "COMPACT") return serviceChecks;
      return [...serviceChecks, {
        stageKey,
        componentKey: "hermes-runtime-node",
        outcome: runtimeNode?.serviceConnection?.status === "HEALTHY" ? contractOutcome(true) : "FAILED" as const,
        code: "hermes-node-enrollment",
        summary: runtimeNode?.serviceConnection?.status === "HEALTHY"
          ? `Hermes node '${runtimeNode.slug}' has a verified signing identity, a current outbound heartbeat, and a healthy inbound AIHub route; Production still requires customer firewall evidence.`
          : runtimeNode
            ? `Hermes node '${runtimeNode.slug}' is reporting outbound, but AIHub cannot yet validate the inbound Hermes API route.`
            : "After LiteLLM is healthy, enroll an isolated Hermes VM and receive a current signed heartbeat.",
        ...(runtimeNode?.hermesVersion ? { observedVersion: runtimeNode.hermesVersion } : {}),
        details: runtimeNode ? { nodeId: runtimeNode.id, identityFingerprint: runtimeNode.identityFingerprint } : {},
      }];
    }
    if (stageKey === "knowledge-workflow") {
      const document = await this.prisma.document.findFirst({
        where: { status: "READY", stagingPurgedAt: { not: null }, memoryPublication: { is: { status: "READY" } } },
        orderBy: { completedAt: "desc" },
        select: { id: true, stagingPurgedAt: true, memoryPublication: { select: { syncedAt: true } } },
      });
      return [{ stageKey, componentKey: "document-conversion", outcome: contractOutcome(Boolean(document)), code: "knowledge-roundtrip", summary: document ? "A ready document was published to Supermemory and its transient staging was purged; Production still requires malformed-input and recovery evidence." : "Process one representative document through OCR, Supermemory publication, and staging purge.", details: document ? { documentId: document.id } : {} }];
    }
    if (stageKey === "hermes-profiles") {
      const profile = await this.prisma.agentProfile.findFirst({
        where: { status: { in: ["STANDBY", "ACTIVE"] } },
        orderBy: { updatedAt: "desc" },
        include: { versions: { orderBy: { version: "desc" }, take: 1 } },
      });
      const distribution = profile?.versions[0];
      return [{ stageKey, outcome: profile && distribution?.distributionDigest ? "PASSED" : "FAILED", code: "standby-profile", summary: profile && distribution?.distributionDigest ? `Profile '${profile.slug}' has a checksummed distribution in ${profile.status.toLowerCase()} service.` : "Create an evaluated Profile Distribution and validate it into standby." , details: profile && distribution?.distributionDigest ? { profileId: profile.id, digest: distribution.distributionDigest } : {} }];
    }
    if (stageKey === "guardrails-tools") {
      const [policy, toolControl] = await Promise.all([
        this.prisma.guardrailPolicy.findFirst({ where: { status: "ACTIVE" }, orderBy: { updatedAt: "desc" } }),
        this.prisma.toolRuntimeControl.findUnique({ where: { id: "global" } }),
      ]);
      return [
        { stageKey, outcome: policy ? "PASSED" : "FAILED", code: "guardrail-baseline", summary: policy ? `Guardrail policy '${policy.slug}' is active.` : "Activate an evaluated guardrail policy." },
        { stageKey, componentKey: "mcp-gateway", outcome: toolControl?.enabled || architecture.targetEnvironment === "PRODUCTION" ? "WARNING" : "PASSED", code: "zero-tool-posture", summary: toolControl?.enabled ? "Governed tools are enabled; complete the tool security acceptance before Production." : architecture.targetEnvironment === "PRODUCTION" ? "Tool runtime is disabled; Production still requires retained gateway protocol and authorization evidence." : "Tool runtime is disabled, preserving the zero-tool baseline." },
      ];
    }
    return [];
  }

  private async applyValidation(principal: AdminPrincipal, stageKey: string, checks: ValidationCheck[]): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction(async (transaction) => {
      const journey = await transaction.onboardingJourney.findUniqueOrThrow({ where: { id: "global" } });
      const evidenceRefs: string[] = [];
      for (const check of checks) {
        const evidence = await transaction.onboardingEvidence.create({ data: {
          stageKey: check.stageKey,
          componentKey: check.componentKey ?? null,
          source: "AUTOMATED",
          outcome: check.outcome,
          code: check.code,
          summary: check.summary,
          observedVersion: check.observedVersion ?? null,
          details: check.details ?? {},
          createdBy: principal.id,
        } });
        evidenceRefs.push(`validation:${evidence.id}`);
        if (check.componentKey) {
          const existing = await transaction.componentCompatibility.findUniqueOrThrow({ where: { key: check.componentKey } });
          if (check.outcome === "WARNING" && existing.status === "PASSED") continue;
          const componentData: Prisma.ComponentCompatibilityUpdateInput = {
            status: check.outcome === "PASSED" ? "PASSED" : check.outcome === "FAILED" ? "FAILED" : "IN_PROGRESS",
            evidenceRef: `validation:${evidence.id}`,
            note: check.summary,
            testedAt: now,
            updatedBy: principal.id,
            revision: { increment: 1 },
          };
          if (check.observedVersion !== undefined) componentData.observedVersion = check.observedVersion;
          await transaction.componentCompatibility.update({
            where: { key: check.componentKey },
            data: componentData,
          });
        }
      }
      const failed = checks.some((check) => check.outcome === "FAILED");
      const passed = checks.length > 0 && !failed;
      await transaction.onboardingStep.update({
        where: { key: stageKey },
        data: {
          status: passed ? "COMPLETED" : "BLOCKED",
          evidenceRefs,
          note: passed ? "Automated validation completed without a blocking result." : "Automated validation found one or more blocking results.",
          completedAt: passed ? now : null,
          updatedBy: principal.id,
          revision: { increment: 1 },
        },
      });
      const next = await transaction.onboardingStep.findFirst({
        where: { key: { in: CANONICAL_STEP_KEYS.filter((key) => key !== "validate-activate") }, status: { not: "COMPLETED" } },
        orderBy: { ordinal: "asc" },
      });
      await transaction.onboardingJourney.update({
        where: { id: "global" },
        data: { status: failed ? "BLOCKED" : "IN_PROGRESS", currentStepKey: next?.key ?? "validate-activate", startedAt: journey.startedAt ?? now, completedAt: null, activatedEnvironment: null, updatedBy: principal.id, revision: { increment: 1 } },
      });
      await transaction.auditEvent.create({ data: {
        actorType: "USER", actorId: principal.id, action: "onboarding.validation_completed",
        resourceType: "OnboardingStep", resourceId: stageKey, outcome: failed ? "FAILURE" : "SUCCESS",
        metadata: { passed: checks.filter((item) => item.outcome === "PASSED").length, failed: checks.filter((item) => item.outcome === "FAILED").length, warnings: checks.filter((item) => item.outcome === "WARNING").length },
      } });
    });
  }

  async runValidation(principal: AdminPrincipal, input: RunOnboardingValidation): Promise<OnboardingSnapshot> {
    await this.ensureState();
    const architecture = architectureDto(await this.prisma.platformArchitectureDecision.findUniqueOrThrow({ where: { id: "global" } }));
    const requested = input.stageKey === "validate-activate" || !input.stageKey
      ? CANONICAL_STEP_KEYS.filter((key) => key !== "validate-activate")
      : [input.stageKey];
    for (const stageKey of requested) {
      if (!CANONICAL_STEP_KEYS.includes(stageKey as typeof CANONICAL_STEP_KEYS[number])) throw new OnboardingNotFoundError("The onboarding stage does not exist.");
      await this.applyValidation(principal, stageKey, await this.validationChecks(stageKey, architecture));
    }
    const current = await this.snapshot();
    await this.prisma.onboardingStep.update({
      where: { key: "validate-activate" },
      data: {
        status: current.gate.ready ? "COMPLETED" : "BLOCKED",
        evidenceRefs: current.evidence.slice(0, 20).map((item) => `validation:${item.id}`),
        note: current.gate.ready ? `All ${current.gate.targetEnvironment.toLowerCase()} gates passed.` : `${current.gate.blockers.length} blockers remain.`,
        completedAt: current.gate.ready ? new Date() : null,
        updatedBy: principal.id,
        revision: { increment: 1 },
      },
    });
    return this.snapshot();
  }

  async complete(principal: AdminPrincipal, input: CompleteOnboarding): Promise<OnboardingSnapshot> {
    await this.ensureState();
    const current = await this.snapshot();
    if (!current.gate.ready) throw new OnboardingConflictError(`Onboarding remains blocked: ${current.gate.blockers.slice(0, 3).join("; ")}.`);
    const changed = await this.prisma.onboardingJourney.updateMany({
      where: { id: "global", revision: input.expectedRevision },
      data: { status: "COMPLETED", currentStepKey: null, activatedEnvironment: current.architecture.targetEnvironment, reason: input.reason, completedAt: new Date(), updatedBy: principal.id, revision: { increment: 1 } },
    });
    if (changed.count !== 1) throw new OnboardingConflictError("Onboarding changed in another session. Refresh and try again.");
    await this.prisma.auditEvent.create({ data: {
      actorType: "USER", actorId: principal.id, action: "onboarding.environment_activated",
      resourceType: "OnboardingJourney", resourceId: "global", outcome: "SUCCESS",
      metadata: { reason: input.reason, environment: current.architecture.targetEnvironment, architectureRevision: current.architecture.revision },
    } });
    return this.snapshot();
  }
}
