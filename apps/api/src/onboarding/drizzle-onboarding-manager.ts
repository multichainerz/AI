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
} from "@orcasynapse/contracts";
import { ORCASYNAPSE_VERSION } from "@orcasynapse/contracts";
import {
  agentProfile,
  agentProfileVersion,
  auditEvent,
  componentCompatibility,
  credentialRecoveryControl,
  guardrailPolicy,
  hermesRuntimeNode,
  localAdministrator,
  onboardingEvidence,
  onboardingJourney,
  onboardingStep,
  platformArchitectureDecision,
  serviceConnection,
  toolRuntimeControl,
  type OrcaSynapseDatabase,
} from "@orcasynapse/database";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, ne, notInArray, sql } from "drizzle-orm";
import {
  createCredentialRecoveryKit,
  credentialKeyFingerprint,
  recoveryKitChecksum,
  verifyCredentialRecoveryKit,
} from "@orcasynapse/security";
import type { AdminPrincipal } from "../auth/admin-session.js";
import { advisoryLock, increment } from "../database-support.js";
import { OnboardingConflictError, OnboardingNotFoundError, type OnboardingManager } from "./onboarding-manager.js";

const COMPONENTS = [
  ["node-runtime", "Node.js runtime", "Application", true, "Pinned Node 24 runtime and Node 24 type definitions pass together."],
  ["typescript-toolchain", "TypeScript toolchain", "Application", true, "TypeScript, Vite, Vitest, schema generation, builds, and editor tooling pass together."],
  ["web-runtime", "React, Vite, and Nginx", "Application", true, "Pinned production bundle/server passes browser, accessibility, mobile, headers, and health acceptance."],
  ["fastify-api", "Fastify API", "Application", true, "Request/response schemas, limits, proxy behavior, streaming, and safe error serialization pass."],
  ["postgresql", "PostgreSQL", "Data", true, "Pinned PostgreSQL 17 patch passes connection, migration, backup, restore, and upgrade checks."],
  ["database-orm", "Drizzle and pg", "Data", true, "Pinned ORM and driver pass pool, timeout, migration, and drift checks."],
  ["postgresql-runtime", "PostgreSQL runtime state", "Data", true, "Durable domain state, compare-and-set claims, restart reconciliation, and executor heartbeats pass without a separate queue broker."],
  ["inference-server", "Inference Server", "Inference", true, "The selected OpenAI-compatible inference server passes model discovery, parser, streaming, cancellation, usage, load, and soak checks."],
  ["hermes-api", "Hermes API Server", "Agents", true, "Pinned Hermes passes native session streaming, stop, Profile, Skill, Toolset, and state.db checks."],
  ["hermes-runtime-node", "Hermes runtime node", "Agents", false, "An isolated Hermes node completes one-time enrollment, proves its signing identity, and maintains a current heartbeat without standing SSH trust."],
  ["mcp-gateway", "MCP gateway", "Tools", false, "Optional governed tools pass negotiation, discovery, calls, cancellation, authorization, and token-boundary checks."],
  ["enterprise-oidc", "Enterprise OIDC", "Identity", false, "Production identity passes discovery, signatures, PKCE, state, nonce, groups, logout, and revocation."],
  ["signed-installer", "OrcaSynapse signed installer", "Deployment", true, "The signed release-bundle installer passes clean install, isolation, upgrade, rollback, and recovery."],
  ["gpu-capacity", "Local GPU capacity", "Infrastructure", false, "Selected local inference stack passes admitted context, concurrency, contention, thermal, and recovery tests."],
] as const;

const STEPS = [
  ["activate-installation", 1, "Activate installation", "Confirm the local administrator account, installed release, and host identity.", "Run installation validation"],
  ["system-topology", 2, "System and topology", "Validate the host and select Compact, Control-plane only, or Segmented production.", "Save topology, then validate this host"],
  ["identity-recovery", 3, "Identity and recovery", "Configure final trust, enterprise identity, recovery ownership, and a verified encrypted recovery kit.", "Export and verify recovery; configure OIDC for Production"],
  ["ai-services", 4, "AI services and Hermes node", "Connect an inference server, then enroll and validate the isolated Hermes runtime.", "Test the inference server, then enroll the Hermes VM"],
  ["hermes-profiles", 5, "Hermes and Profiles", "Validate the Hermes boundary and move an immutable Profile Distribution into standby.", "Create, evaluate, and validate a standby Profile"],
  ["guardrails-tools", 6, "Guardrails and tools", "Prove conservative policy, zero-tool operation, approvals, and bounded governed tools.", "Activate a guardrail baseline and validate tool posture"],
  ["validate-activate", 7, "Validate and activate", "Run the target-environment gate and record Development, Pilot, or Production activation.", "Run all validation and resolve remaining blockers"],
] as const;

/** Reported as the ORM's observed version on the system-topology stage. */
const DRIZZLE_VERSION = "0.45.2";

const CANONICAL_STEP_KEYS = STEPS.map(([key]) => key);
const CORE_RUNTIME_COMPONENTS = new Set(["postgresql", "inference-server", "hermes-api"]);

type StoredArchitecture = typeof platformArchitectureDecision.$inferSelect;
type StoredComponent = typeof componentCompatibility.$inferSelect;
type StoredJourney = typeof onboardingJourney.$inferSelect;
type StoredStep = typeof onboardingStep.$inferSelect;
type StoredEvidence = typeof onboardingEvidence.$inferSelect;
type StoredRecovery = typeof credentialRecoveryControl.$inferSelect;

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
    [component.key === "signed-installer", "The supported OrcaSynapse release-bundle installer path must pass", "signed-installer"],
    [component.key === "inference-server", "An approved OpenAI-compatible inference server is required", "inference-server"],
    [component.key === "gpu-capacity" && production, "Production inference requires measured GPU admission", "gpu-capacity"],
    [component.key === "hermes-runtime-node" && architecture.topologyMode !== "COMPACT", "The selected topology isolates Hermes from the OrcaSynapse control plane", "hermes-runtime-node"],
  ];
  for (const [condition, selectedReason, key] of selected) {
    if (condition && component.key === key) {
      required = true;
      reason = selectedReason;
    }
  }
  if (component.key === "enterprise-oidc" && !production) reason = "OIDC is recommended now and becomes blocking for Production";
  if (component.key === "gpu-capacity" && !production) reason = "GPU capacity is attested on the separately managed inference server before Production";
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
    evidenceRefs: value.evidenceRefs ?? [],
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

function detailsRecord(value: unknown): Record<string, unknown> {
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
      ? "Production readiness: the readiness authority is unavailable"
      : `Production readiness: status is ${(productionReadinessStatus ?? "NOT_READY").toLowerCase().replaceAll("_", " ")}`);
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

export class DrizzleOnboardingManager implements OnboardingManager {
  readonly #masterKey: Uint8Array | undefined;

  constructor(
    private readonly database: OrcaSynapseDatabase,
    masterKey?: Uint8Array,
    private readonly readiness?: { productionReadiness(): Promise<ProductionReadiness> },
  ) {
    this.#masterKey = masterKey ? new Uint8Array(masterKey) : undefined;
  }

  private async ensureState(): Promise<void> {
    await this.database.transaction(async (transaction) => {
      for (const [key, displayName, category, required, expectedContract] of COMPONENTS) {
        await transaction
          .insert(componentCompatibility)
          .values({ key, displayName, category, required, expectedContract })
          .onConflictDoUpdate({
            target: componentCompatibility.key,
            set: { displayName, category, required, expectedContract },
          });
      }
      // Contracts that were renamed or withdrawn must not linger as blockers.
      await transaction
        .delete(componentCompatibility)
        .where(and(
          eq(componentCompatibility.category, "Deployment"),
          ne(componentCompatibility.key, "signed-installer"),
        ));
      for (const [key, ordinal, title, description] of STEPS) {
        await transaction
          .insert(onboardingStep)
          .values({ key, ordinal, title, description, required: true })
          .onConflictDoUpdate({
            target: onboardingStep.key,
            set: { ordinal, title, description, required: true },
          });
      }
      await transaction
        .update(onboardingStep)
        .set({ required: false })
        .where(notInArray(onboardingStep.key, [...CANONICAL_STEP_KEYS]));
      await transaction.insert(platformArchitectureDecision).values({ id: "global" }).onConflictDoNothing();
      await transaction
        .insert(onboardingJourney)
        .values({ id: "global", currentStepKey: "activate-installation" })
        .onConflictDoNothing();
      await transaction.insert(credentialRecoveryControl).values({ id: "global" }).onConflictDoNothing();
    });
  }

  /** The three singleton control rows ensureState guarantees exist. */
  private async architectureRow(): Promise<StoredArchitecture> {
    const [row] = await this.database
      .select().from(platformArchitectureDecision)
      .where(eq(platformArchitectureDecision.id, "global")).limit(1);
    if (!row) throw new OnboardingNotFoundError("The architecture decision is missing.");
    return row;
  }

  private async journeyRow(): Promise<StoredJourney> {
    const [row] = await this.database
      .select().from(onboardingJourney).where(eq(onboardingJourney.id, "global")).limit(1);
    if (!row) throw new OnboardingNotFoundError("The onboarding journey is missing.");
    return row;
  }

  private async recoveryRow(): Promise<StoredRecovery> {
    const [row] = await this.database
      .select().from(credentialRecoveryControl)
      .where(eq(credentialRecoveryControl.id, "global")).limit(1);
    if (!row) throw new OnboardingNotFoundError("The credential recovery control is missing.");
    return row;
  }

  async snapshot(): Promise<OnboardingSnapshot> {
    await this.ensureState();
    const [architecture, journey, components, steps, administrators, recovery, evidence] = await Promise.all([
      this.architectureRow(),
      this.journeyRow(),
      this.database.select().from(componentCompatibility)
        .orderBy(asc(componentCompatibility.category), asc(componentCompatibility.displayName)),
      this.database.select().from(onboardingStep)
        .where(inArray(onboardingStep.key, [...CANONICAL_STEP_KEYS]))
        .orderBy(asc(onboardingStep.ordinal)),
      this.database.select({ createdAt: localAdministrator.createdAt }).from(localAdministrator)
        .where(isNull(localAdministrator.disabledAt))
        .orderBy(asc(localAdministrator.createdAt)).limit(1),
      this.recoveryRow(),
      this.database.select().from(onboardingEvidence)
        .orderBy(desc(onboardingEvidence.createdAt)).limit(100),
    ]);
    const provisionedAdministrator = administrators[0];
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
      installation: {
        status: provisionedAdministrator ? "ACTIVATED" : "UNKNOWN",
        activatedAt: provisionedAdministrator?.createdAt.toISOString() ?? null,
      },
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
    const updated = await this.database.transaction(async (transaction) => {
      await transaction.execute(advisoryLock("orcasynapse-phase9-architecture"));
      const [current] = await transaction
        .select().from(platformArchitectureDecision)
        .where(eq(platformArchitectureDecision.id, "global")).limit(1);
      const [journey] = await transaction
        .select().from(onboardingJourney).where(eq(onboardingJourney.id, "global")).limit(1);
      if (!current || !journey) throw new OnboardingNotFoundError("The onboarding control rows are missing.");
      if (current.revision !== input.expectedRevision) throw new OnboardingConflictError("Architecture decisions changed in another session. Refresh and try again.");
      const architectureChanged =
        (input.topologyMode !== undefined && input.topologyMode !== current.topologyMode) ||
        (input.targetEnvironment !== undefined && input.targetEnvironment !== current.targetEnvironment);
      const changedFields = Object.keys(input).filter((key) => key !== "expectedRevision" && key !== "reason");
      const [saved] = await transaction
        .update(platformArchitectureDecision)
        .set({
          reason: input.reason,
          updatedBy: principal.id,
          revision: increment(platformArchitectureDecision.revision),
          ...(input.topologyMode !== undefined ? { topologyMode: input.topologyMode } : {}),
          ...(input.targetEnvironment !== undefined ? { targetEnvironment: input.targetEnvironment } : {}),
        })
        .where(eq(platformArchitectureDecision.id, "global"))
        .returning();
      if (!saved) throw new OnboardingNotFoundError("The architecture decision is missing.");
      if (architectureChanged) {
        // Every contract was proven against the previous architecture, so the
        // evidence no longer describes what is deployed.
        await transaction
          .update(componentCompatibility)
          .set({
            status: "NOT_TESTED",
            observedVersion: null,
            evidenceRef: null,
            note: "Architecture changed; revalidation is required.",
            testedAt: null,
            updatedBy: principal.id,
            revision: increment(componentCompatibility.revision),
          });
        await transaction
          .update(onboardingStep)
          .set({
            status: "NOT_STARTED",
            evidenceRefs: [],
            note: "Architecture changed; rerun this validation stage.",
            completedAt: null,
            updatedBy: principal.id,
            revision: increment(onboardingStep.revision),
          })
          .where(inArray(onboardingStep.key, CANONICAL_STEP_KEYS.filter((key) => key !== "activate-installation")));
      }
      await transaction
        .update(onboardingJourney)
        .set({
          status: "IN_PROGRESS",
          startedAt: journey.startedAt ?? new Date(),
          completedAt: null,
          activatedEnvironment: null,
          currentStepKey: "system-topology",
          updatedBy: principal.id,
          reason: input.reason,
          revision: increment(onboardingJourney.revision),
        })
        .where(eq(onboardingJourney.id, "global"));
      await transaction.insert(auditEvent).values({
        actorType: "USER", actorId: principal.id, action: "onboarding.architecture_updated",
        resourceType: "PlatformArchitectureDecision", resourceId: "global", outcome: "SUCCESS",
        metadata: { changedFields, evidenceInvalidated: architectureChanged, revision: saved.revision, reason: input.reason },
      });
      return saved;
    });
    return architectureDto(updated);
  }

  async updateComponent(principal: AdminPrincipal, key: string, input: UpdateComponentCompatibility): Promise<OnboardingSnapshot> {
    await this.ensureState();
    await this.database.transaction(async (transaction) => {
      const [existing] = await transaction
        .select({ key: componentCompatibility.key })
        .from(componentCompatibility)
        .where(eq(componentCompatibility.key, key)).limit(1);
      if (!existing) throw new OnboardingNotFoundError("The component contract does not exist.");
      const changed = await transaction
        .update(componentCompatibility)
        .set({
          status: input.status,
          observedVersion: input.observedVersion ?? null,
          evidenceRef: input.evidenceRef ?? null,
          note: input.note,
          testedAt: ["PASSED", "FAILED"].includes(input.status) ? new Date() : null,
          updatedBy: principal.id,
          revision: increment(componentCompatibility.revision),
        })
        .where(and(
          eq(componentCompatibility.key, key),
          eq(componentCompatibility.revision, input.expectedRevision),
        ))
        .returning({ key: componentCompatibility.key });
      if (changed.length !== 1) throw new OnboardingConflictError("The component contract changed in another session. Refresh and try again.");
      await transaction.insert(onboardingEvidence).values({
        stageKey: "validate-activate",
        componentKey: key,
        source: "EXTERNAL_ATTESTATION",
        outcome: input.status === "PASSED" ? "PASSED" : input.status === "FAILED" ? "FAILED" : "WARNING",
        code: `external-attestation-${key}`,
        summary: input.note,
        observedVersion: input.observedVersion ?? null,
        details: { authority: input.attestationAuthority ?? "not-supplied", evidenceRef: input.evidenceRef ?? null },
        createdBy: principal.id,
      });
      await transaction
        .update(onboardingJourney)
        .set({
          status: input.status === "BLOCKED" ? "BLOCKED" : "IN_PROGRESS",
          completedAt: null,
          activatedEnvironment: null,
          updatedBy: principal.id,
          revision: increment(onboardingJourney.revision),
        })
        .where(eq(onboardingJourney.id, "global"));
    });
    return this.snapshot();
  }

  async updateStep(principal: AdminPrincipal, key: string, input: UpdateOnboardingStep): Promise<OnboardingSnapshot> {
    if (input.status === "COMPLETED") throw new OnboardingConflictError("Technical stages complete only from automated validation evidence.");
    await this.ensureState();
    const changed = await this.database
      .update(onboardingStep)
      .set({ status: input.status, note: input.note, updatedBy: principal.id, revision: increment(onboardingStep.revision) })
      .where(and(
        eq(onboardingStep.key, key),
        inArray(onboardingStep.key, [...CANONICAL_STEP_KEYS]),
        eq(onboardingStep.revision, input.expectedRevision),
      ))
      .returning({ key: onboardingStep.key });
    if (changed.length !== 1) throw new OnboardingConflictError("The onboarding stage changed in another session. Refresh and try again.");
    return this.snapshot();
  }

  async exportRecoveryKit(principal: AdminPrincipal, input: ExportRecoveryKit): Promise<RecoveryKitExport> {
    if (!this.#masterKey) throw new OnboardingConflictError("The OrcaSynapse credential-encryption key is unavailable.");
    await this.ensureState();
    const created = await createCredentialRecoveryKit(this.#masterKey, input.passphrase);
    const changed = await this.database
      .update(credentialRecoveryControl)
      .set({
        keyFingerprint: created.keyFingerprint,
        kitChecksum: created.checksum,
        recoveryOwner: input.recoveryOwner,
        exportedAt: new Date(),
        exportedBy: principal.id,
        // A freshly exported kit is unverified until it round-trips.
        verifiedAt: null,
        verifiedBy: null,
        revision: increment(credentialRecoveryControl.revision),
      })
      .where(and(
        eq(credentialRecoveryControl.id, "global"),
        eq(credentialRecoveryControl.revision, input.expectedRevision),
      ))
      .returning({ id: credentialRecoveryControl.id });
    if (changed.length !== 1) throw new OnboardingConflictError("Recovery state changed in another session. Refresh and try again.");
    await this.database.insert(auditEvent).values({
      actorType: "USER", actorId: principal.id, action: "onboarding.recovery_kit_exported",
      resourceType: "CredentialRecoveryControl", resourceId: "global", outcome: "SUCCESS",
      metadata: { checksum: created.checksum, keyFingerprint: created.keyFingerprint, recoveryOwner: input.recoveryOwner },
    });
    return {
      fileName: `orcasynapse-recovery-${created.keyFingerprint.slice(0, 12)}.json`,
      serializedKit: created.serialized,
      checksum: created.checksum,
      keyFingerprint: created.keyFingerprint,
    };
  }

  async verifyRecoveryKit(principal: AdminPrincipal, input: VerifyRecoveryKit): Promise<OnboardingSnapshot> {
    if (!this.#masterKey) throw new OnboardingConflictError("The OrcaSynapse credential-encryption key is unavailable.");
    const parsed = await verifyCredentialRecoveryKit(input.serializedKit, input.passphrase, this.#masterKey);
    const checksum = recoveryKitChecksum(input.serializedKit);
    const current = await this.recoveryRow();
    if (current.revision !== input.expectedRevision || current.kitChecksum !== checksum || current.keyFingerprint !== parsed.keyFingerprint) {
      throw new OnboardingConflictError("Verify the most recently exported recovery kit against the current recovery revision.");
    }
    const changed = await this.database
      .update(credentialRecoveryControl)
      .set({ verifiedAt: new Date(), verifiedBy: principal.id, revision: increment(credentialRecoveryControl.revision) })
      .where(and(
        eq(credentialRecoveryControl.id, "global"),
        eq(credentialRecoveryControl.revision, input.expectedRevision),
        eq(credentialRecoveryControl.kitChecksum, checksum),
      ))
      .returning({ id: credentialRecoveryControl.id });
    if (changed.length !== 1) throw new OnboardingConflictError("Recovery state changed in another session. Refresh and try again.");
    await this.database.insert(auditEvent).values({
      actorType: "USER", actorId: principal.id, action: "onboarding.recovery_kit_verified",
      resourceType: "CredentialRecoveryControl", resourceId: "global", outcome: "SUCCESS",
      metadata: { checksum, keyFingerprint: credentialKeyFingerprint(this.#masterKey) },
    });
    return this.runValidation(principal, { stageKey: "identity-recovery" });
  }

  private async validationChecks(stageKey: string, architecture: ArchitectureDecision): Promise<ValidationCheck[]> {
    const contractOutcome = (passed: boolean): ValidationCheck["outcome"] => passed
      ? architecture.targetEnvironment === "PRODUCTION" ? "WARNING" : "PASSED"
      : "FAILED";
    if (stageKey === "activate-installation") {
      const [administrator] = await this.database
        .select({ id: localAdministrator.id }).from(localAdministrator)
        .where(isNull(localAdministrator.disabledAt))
        .orderBy(asc(localAdministrator.createdAt)).limit(1);
      return [{ stageKey, outcome: administrator ? "PASSED" : "FAILED", code: "local-administrator", summary: administrator ? "The installer-provisioned local administrator account is active." : "No active local administrator account has been provisioned." }];
    }
    if (stageKey === "system-topology") {
      const versionResult = await this.database.execute<{ version: string }>(sql`SELECT version()`);
      const observedPostgres = versionResult.rows[0]?.version;
      return [
        { stageKey, componentKey: "node-runtime", outcome: contractOutcome(process.versions.node.startsWith("24.")), code: "node-runtime", summary: `OrcaSynapse is running on Node ${process.versions.node}; Production still requires the retained compatibility suite.`, observedVersion: process.versions.node },
        { stageKey, componentKey: "postgresql", outcome: contractOutcome(Boolean(observedPostgres)), code: "postgresql-connectivity", summary: observedPostgres ? "PostgreSQL accepted a live query through the ORM; Production still requires backup, restore, and upgrade evidence." : "PostgreSQL version could not be read.", ...(observedPostgres ? { observedVersion: observedPostgres.slice(0, 240) } : {}) },
        { stageKey, componentKey: "database-orm", outcome: contractOutcome(true), code: "orm-database-path", summary: "Drizzle and the PostgreSQL driver completed the onboarding query path; Production still requires pool, timeout, and drift evidence.", observedVersion: DRIZZLE_VERSION },
        { stageKey, componentKey: "fastify-api", outcome: contractOutcome(true), code: "api-runtime", summary: "The authenticated onboarding API is operational; Production still requires its retained contract and negative-security suite.", observedVersion: ORCASYNAPSE_VERSION },
        { stageKey, outcome: architecture.reason ? "PASSED" : "FAILED", code: "topology-decision", summary: architecture.reason ? `${architecture.topologyMode.toLowerCase().replaceAll("_", " ")} topology is recorded for ${architecture.targetEnvironment.toLowerCase()}.` : "Save a topology decision and rationale before validation." },
      ];
    }
    if (stageKey === "identity-recovery") {
      const [recovery, oidcRows] = await Promise.all([
        this.recoveryRow(),
        this.database.select().from(serviceConnection)
          .where(and(eq(serviceConnection.kind, "OIDC"), eq(serviceConnection.enabled, true)))
          .orderBy(desc(serviceConnection.updatedAt)).limit(1),
      ]);
      const oidc = oidcRows[0];
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
      const [connections, runtimeNodes] = await Promise.all([
        this.database.select().from(serviceConnection)
          .where(and(
            inArray(serviceConnection.kind, ["INFERENCE", "HERMES"]),
            eq(serviceConnection.enabled, true),
          ))
          .orderBy(desc(serviceConnection.updatedAt)),
        architecture.topologyMode === "COMPACT" ? Promise.resolve([]) : this.database
          .select({
            id: hermesRuntimeNode.id,
            slug: hermesRuntimeNode.slug,
            hermesVersion: hermesRuntimeNode.hermesVersion,
            identityFingerprint: hermesRuntimeNode.identityFingerprint,
            connectionStatus: serviceConnection.status,
          })
          .from(hermesRuntimeNode)
          .leftJoin(serviceConnection, eq(hermesRuntimeNode.serviceConnectionId, serviceConnection.id))
          .where(and(
            eq(hermesRuntimeNode.status, "ONLINE"),
            isNotNull(hermesRuntimeNode.identityFingerprint),
            gt(hermesRuntimeNode.lastSeenAt, new Date(Date.now() - 180_000)),
          ))
          .orderBy(desc(hermesRuntimeNode.lastSeenAt)).limit(1),
      ]);
      const runtimeNode = runtimeNodes[0];
      const required: Array<["INFERENCE" | "HERMES", string, string]> = [
        ["INFERENCE", "inference-server", "Inference Server"],
        ["HERMES", "hermes-api", "Hermes"],
      ];
      const serviceChecks = required.map(([kind, componentKey, label]) => {
        const connection = connections.find((item) => item.kind === kind);
        return { stageKey, componentKey, outcome: contractOutcome(connection?.status === "HEALTHY"), code: `service-${kind.toLowerCase()}`, summary: connection?.status === "HEALTHY" ? `${label} has an enabled healthy connection; Production still requires its retained compatibility suite.` : `${label} requires an enabled connection with a current successful diagnostic.` };
      });
      if (architecture.topologyMode === "COMPACT") return serviceChecks;
      return [...serviceChecks, {
        stageKey,
        componentKey: "hermes-runtime-node",
        outcome: runtimeNode?.connectionStatus === "HEALTHY" ? contractOutcome(true) : "FAILED" as const,
        code: "hermes-node-enrollment",
        summary: runtimeNode?.connectionStatus === "HEALTHY"
          ? `Hermes node '${runtimeNode.slug}' has a verified signing identity, a current outbound heartbeat, and a healthy inbound OrcaSynapse route; Production still requires customer firewall evidence.`
          : runtimeNode
            ? `Hermes node '${runtimeNode.slug}' is reporting outbound, but OrcaSynapse cannot yet validate the inbound Hermes API route.`
            : "After the inference server is healthy, enroll an isolated Hermes VM and receive a current signed heartbeat.",
        ...(runtimeNode?.hermesVersion ? { observedVersion: runtimeNode.hermesVersion } : {}),
        details: runtimeNode ? { nodeId: runtimeNode.id, identityFingerprint: runtimeNode.identityFingerprint } : {},
      }];
    }
    if (stageKey === "hermes-profiles") {
      const [released] = await this.database
        .select({
          id: agentProfile.id,
          slug: agentProfile.slug,
          status: agentProfile.status,
          distributionDigest: agentProfileVersion.distributionDigest,
        })
        .from(agentProfile)
        .innerJoin(agentProfileVersion, eq(agentProfileVersion.profileId, agentProfile.id))
        .where(inArray(agentProfile.status, ["STANDBY", "ACTIVE"]))
        .orderBy(desc(agentProfile.updatedAt), desc(agentProfileVersion.version)).limit(1);
      return [{ stageKey, outcome: released?.distributionDigest ? "PASSED" : "FAILED", code: "standby-profile", summary: released?.distributionDigest ? `Profile '${released.slug}' has a checksummed distribution in ${released.status.toLowerCase()} service.` : "Create an evaluated Profile Distribution and validate it into standby." , details: released?.distributionDigest ? { profileId: released.id, digest: released.distributionDigest } : {} }];
    }
    if (stageKey === "guardrails-tools") {
      const [policyRows, toolControlRows] = await Promise.all([
        this.database.select({ slug: guardrailPolicy.slug }).from(guardrailPolicy)
          .where(eq(guardrailPolicy.status, "ACTIVE"))
          .orderBy(desc(guardrailPolicy.updatedAt)).limit(1),
        this.database.select({ enabled: toolRuntimeControl.enabled }).from(toolRuntimeControl)
          .where(eq(toolRuntimeControl.id, "global")).limit(1),
      ]);
      const policy = policyRows[0];
      const toolControl = toolControlRows[0];
      return [
        { stageKey, outcome: policy ? "PASSED" : "FAILED", code: "guardrail-baseline", summary: policy ? `Guardrail policy '${policy.slug}' is active.` : "Activate an evaluated guardrail policy." },
        { stageKey, componentKey: "mcp-gateway", outcome: toolControl?.enabled || architecture.targetEnvironment === "PRODUCTION" ? "WARNING" : "PASSED", code: "zero-tool-posture", summary: toolControl?.enabled ? "Governed tools are enabled; complete the tool security acceptance before Production." : architecture.targetEnvironment === "PRODUCTION" ? "Tool runtime is disabled; Production still requires retained gateway protocol and authorization evidence." : "Tool runtime is disabled, preserving the zero-tool baseline." },
      ];
    }
    return [];
  }

  private async applyValidation(principal: AdminPrincipal, stageKey: string, checks: ValidationCheck[]): Promise<void> {
    const now = new Date();
    await this.database.transaction(async (transaction) => {
      const [journey] = await transaction
        .select().from(onboardingJourney).where(eq(onboardingJourney.id, "global")).limit(1);
      if (!journey) throw new OnboardingNotFoundError("The onboarding journey is missing.");
      const evidenceRefs: string[] = [];
      for (const check of checks) {
        const [evidence] = await transaction
          .insert(onboardingEvidence)
          .values({
            stageKey: check.stageKey,
            componentKey: check.componentKey ?? null,
            source: "AUTOMATED",
            outcome: check.outcome,
            code: check.code,
            summary: check.summary,
            observedVersion: check.observedVersion ?? null,
            details: check.details ?? {},
            createdBy: principal.id,
          })
          .returning({ id: onboardingEvidence.id });
        if (!evidence) throw new OnboardingConflictError("Validation evidence could not be recorded.");
        evidenceRefs.push(`validation:${evidence.id}`);
        if (check.componentKey) {
          const [existing] = await transaction
            .select({ status: componentCompatibility.status })
            .from(componentCompatibility)
            .where(eq(componentCompatibility.key, check.componentKey)).limit(1);
          if (!existing) throw new OnboardingNotFoundError("The component contract does not exist.");
          // A warning must not demote a contract that has already passed.
          if (check.outcome === "WARNING" && existing.status === "PASSED") continue;
          await transaction
            .update(componentCompatibility)
            .set({
              status: check.outcome === "PASSED" ? "PASSED" : check.outcome === "FAILED" ? "FAILED" : "IN_PROGRESS",
              evidenceRef: `validation:${evidence.id}`,
              note: check.summary,
              testedAt: now,
              updatedBy: principal.id,
              revision: increment(componentCompatibility.revision),
              ...(check.observedVersion !== undefined ? { observedVersion: check.observedVersion } : {}),
            })
            .where(eq(componentCompatibility.key, check.componentKey));
        }
      }
      const failed = checks.some((check) => check.outcome === "FAILED");
      const passed = checks.length > 0 && !failed;
      await transaction
        .update(onboardingStep)
        .set({
          status: passed ? "COMPLETED" : "BLOCKED",
          evidenceRefs,
          note: passed ? "Automated validation completed without a blocking result." : "Automated validation found one or more blocking results.",
          completedAt: passed ? now : null,
          updatedBy: principal.id,
          revision: increment(onboardingStep.revision),
        })
        .where(eq(onboardingStep.key, stageKey));
      const [next] = await transaction
        .select({ key: onboardingStep.key })
        .from(onboardingStep)
        .where(and(
          inArray(onboardingStep.key, CANONICAL_STEP_KEYS.filter((key) => key !== "validate-activate")),
          ne(onboardingStep.status, "COMPLETED"),
        ))
        .orderBy(asc(onboardingStep.ordinal)).limit(1);
      await transaction
        .update(onboardingJourney)
        .set({
          status: failed ? "BLOCKED" : "IN_PROGRESS",
          currentStepKey: next?.key ?? "validate-activate",
          startedAt: journey.startedAt ?? now,
          completedAt: null,
          activatedEnvironment: null,
          updatedBy: principal.id,
          revision: increment(onboardingJourney.revision),
        })
        .where(eq(onboardingJourney.id, "global"));
      await transaction.insert(auditEvent).values({
        actorType: "USER", actorId: principal.id, action: "onboarding.validation_completed",
        resourceType: "OnboardingStep", resourceId: stageKey, outcome: failed ? "FAILURE" : "SUCCESS",
        metadata: { passed: checks.filter((item) => item.outcome === "PASSED").length, failed: checks.filter((item) => item.outcome === "FAILED").length, warnings: checks.filter((item) => item.outcome === "WARNING").length },
      });
    });
  }

  async runValidation(principal: AdminPrincipal, input: RunOnboardingValidation): Promise<OnboardingSnapshot> {
    await this.ensureState();
    const architecture = architectureDto(await this.architectureRow());
    const requested = input.stageKey === "validate-activate" || !input.stageKey
      ? CANONICAL_STEP_KEYS.filter((key) => key !== "validate-activate")
      : [input.stageKey];
    for (const stageKey of requested) {
      if (!CANONICAL_STEP_KEYS.includes(stageKey as typeof CANONICAL_STEP_KEYS[number])) throw new OnboardingNotFoundError("The onboarding stage does not exist.");
      await this.applyValidation(principal, stageKey, await this.validationChecks(stageKey, architecture));
    }
    const current = await this.snapshot();
    await this.database
      .update(onboardingStep)
      .set({
        status: current.gate.ready ? "COMPLETED" : "BLOCKED",
        evidenceRefs: current.evidence.slice(0, 20).map((item) => `validation:${item.id}`),
        note: current.gate.ready ? `All ${current.gate.targetEnvironment.toLowerCase()} gates passed.` : `${current.gate.blockers.length} blockers remain.`,
        completedAt: current.gate.ready ? new Date() : null,
        updatedBy: principal.id,
        revision: increment(onboardingStep.revision),
      })
      .where(eq(onboardingStep.key, "validate-activate"));
    return this.snapshot();
  }

  async complete(principal: AdminPrincipal, input: CompleteOnboarding): Promise<OnboardingSnapshot> {
    await this.ensureState();
    const current = await this.snapshot();
    if (!current.gate.ready) throw new OnboardingConflictError(`Onboarding remains blocked: ${current.gate.blockers.slice(0, 3).join("; ")}.`);
    const changed = await this.database
      .update(onboardingJourney)
      .set({
        status: "COMPLETED",
        currentStepKey: null,
        activatedEnvironment: current.architecture.targetEnvironment,
        reason: input.reason,
        completedAt: new Date(),
        updatedBy: principal.id,
        revision: increment(onboardingJourney.revision),
      })
      .where(and(
        eq(onboardingJourney.id, "global"),
        eq(onboardingJourney.revision, input.expectedRevision),
      ))
      .returning({ id: onboardingJourney.id });
    if (changed.length !== 1) throw new OnboardingConflictError("Onboarding changed in another session. Refresh and try again.");
    await this.database.insert(auditEvent).values({
      actorType: "USER", actorId: principal.id, action: "onboarding.environment_activated",
      resourceType: "OnboardingJourney", resourceId: "global", outcome: "SUCCESS",
      metadata: { reason: input.reason, environment: current.architecture.targetEnvironment, architectureRevision: current.architecture.revision },
    });
    return this.snapshot();
  }
}
