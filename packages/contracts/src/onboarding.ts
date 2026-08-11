import { z } from "zod";

export const COMPONENT_COMPATIBILITY_STATUSES = ["NOT_TESTED", "IN_PROGRESS", "PASSED", "FAILED", "BLOCKED"] as const;
export const ONBOARDING_JOURNEY_STATUSES = ["NOT_STARTED", "IN_PROGRESS", "BLOCKED", "COMPLETED"] as const;
export const ONBOARDING_STEP_STATUSES = ["NOT_STARTED", "IN_PROGRESS", "BLOCKED", "COMPLETED"] as const;
export const DEPLOYMENT_TOPOLOGY_MODES = ["COMPACT", "CONTROL_PLANE", "SEGMENTED_PRODUCTION"] as const;
export const ONBOARDING_TARGET_ENVIRONMENTS = ["DEVELOPMENT", "PILOT", "PRODUCTION"] as const;
export const ONBOARDING_EVIDENCE_SOURCES = ["AUTOMATED", "EXTERNAL_ATTESTATION"] as const;
export const ONBOARDING_EVIDENCE_OUTCOMES = ["PASSED", "FAILED", "WARNING"] as const;
export const RECOVERY_CONTROL_STATUSES = ["NOT_EXPORTED", "EXPORTED", "VERIFIED"] as const;
export const INSTALLATION_ACTIVATION_STATUSES = ["UNKNOWN", "ACTIVATED"] as const;
export const ONBOARDING_STEP_KEYS = [
  "activate-installation",
  "system-topology",
  "identity-recovery",
  "ai-services",
  "hermes-profiles",
  "guardrails-tools",
  "validate-activate",
] as const;

export const componentCompatibilityStatusSchema = z.enum(COMPONENT_COMPATIBILITY_STATUSES);
export const onboardingJourneyStatusSchema = z.enum(ONBOARDING_JOURNEY_STATUSES);
export const onboardingStepStatusSchema = z.enum(ONBOARDING_STEP_STATUSES);
export const deploymentTopologyModeSchema = z.enum(DEPLOYMENT_TOPOLOGY_MODES);
export const onboardingTargetEnvironmentSchema = z.enum(ONBOARDING_TARGET_ENVIRONMENTS);
export const onboardingEvidenceSourceSchema = z.enum(ONBOARDING_EVIDENCE_SOURCES);
export const onboardingEvidenceOutcomeSchema = z.enum(ONBOARDING_EVIDENCE_OUTCOMES);
export const componentCompatibilityKeySchema = z.string().min(2).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const onboardingStepKeySchema = z.enum(ONBOARDING_STEP_KEYS);

export const architectureDecisionSchema = z.object({
  topologyMode: deploymentTopologyModeSchema,
  targetEnvironment: onboardingTargetEnvironmentSchema,
  reason: z.string().nullable(),
  revision: z.number().int().nonnegative(),
  updatedBy: z.uuid().nullable(),
  updatedAt: z.iso.datetime(),
});

export const updateArchitectureDecisionSchema = z.object({
  topologyMode: deploymentTopologyModeSchema.optional(),
  targetEnvironment: onboardingTargetEnvironmentSchema.optional(),
  reason: z.string().trim().min(3).max(1000),
  expectedRevision: z.number().int().nonnegative(),
}).strict().refine((value) => Object.keys(value).some((key) => !["reason", "expectedRevision"].includes(key)), {
  message: "At least one architecture decision must change.",
});

export const componentCompatibilitySchema = z.object({
  key: componentCompatibilityKeySchema,
  displayName: z.string().min(2).max(160),
  category: z.string().min(2).max(80),
  required: z.boolean(),
  requirementReason: z.string().min(2).max(500),
  expectedContract: z.string().min(3).max(1000),
  status: componentCompatibilityStatusSchema,
  evidenceSource: onboardingEvidenceSourceSchema.nullable(),
  observedVersion: z.string().nullable(),
  evidenceRef: z.string().nullable(),
  note: z.string().nullable(),
  testedAt: z.iso.datetime().nullable(),
  updatedBy: z.uuid().nullable(),
  revision: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime(),
});

export const updateComponentCompatibilitySchema = z.object({
  status: componentCompatibilityStatusSchema,
  observedVersion: z.string().trim().min(1).max(240).optional(),
  evidenceRef: z.string().trim().min(3).max(500).optional(),
  attestationAuthority: z.string().trim().min(2).max(160).optional(),
  note: z.string().trim().min(3).max(1000),
  expectedRevision: z.number().int().nonnegative(),
}).strict().superRefine((value, context) => {
  if (value.status === "PASSED" && (!value.observedVersion || !value.evidenceRef || !value.attestationAuthority)) {
    context.addIssue({ code: "custom", message: "External pass attestation requires an authority, observed version, and immutable evidence reference." });
  }
});

export const onboardingStepSchema = z.object({
  key: onboardingStepKeySchema,
  ordinal: z.number().int().positive(),
  title: z.string().min(2).max(160),
  description: z.string().min(3).max(1000),
  required: z.boolean(),
  automated: z.boolean(),
  action: z.string().min(2).max(500),
  status: onboardingStepStatusSchema,
  evidenceRefs: z.array(z.string().min(1).max(500)).max(50),
  note: z.string().nullable(),
  revision: z.number().int().nonnegative(),
  updatedBy: z.uuid().nullable(),
  completedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
});

export const updateOnboardingStepSchema = z.object({
  status: onboardingStepStatusSchema,
  evidenceRefs: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
  note: z.string().trim().min(3).max(1000),
  expectedRevision: z.number().int().nonnegative(),
}).strict().superRefine((value, context) => {
  if (value.status === "COMPLETED" && value.evidenceRefs.length === 0) {
    context.addIssue({ code: "custom", message: "A completed onboarding step requires at least one evidence reference." });
  }
});

export const onboardingJourneySchema = z.object({
  status: onboardingJourneyStatusSchema,
  currentStepKey: onboardingStepKeySchema.nullable(),
  activatedEnvironment: onboardingTargetEnvironmentSchema.nullable(),
  reason: z.string().nullable(),
  revision: z.number().int().nonnegative(),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  updatedBy: z.uuid().nullable(),
  updatedAt: z.iso.datetime(),
});

export const installationCredentialSummarySchema = z.object({
  status: z.enum(INSTALLATION_ACTIVATION_STATUSES),
  activatedAt: z.iso.datetime().nullable(),
});

export const credentialRecoveryControlSchema = z.object({
  status: z.enum(RECOVERY_CONTROL_STATUSES),
  keyFingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  kitChecksum: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  recoveryOwner: z.string().nullable(),
  exportedAt: z.iso.datetime().nullable(),
  verifiedAt: z.iso.datetime().nullable(),
  revision: z.number().int().nonnegative(),
});

export const onboardingEvidenceSchema = z.object({
  id: z.uuid(),
  stageKey: onboardingStepKeySchema,
  componentKey: componentCompatibilityKeySchema.nullable(),
  source: onboardingEvidenceSourceSchema,
  outcome: onboardingEvidenceOutcomeSchema,
  code: z.string().min(2).max(120),
  summary: z.string().min(2).max(1000),
  observedVersion: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
  createdBy: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
});

export const onboardingGateSchema = z.object({
  ready: z.boolean(),
  targetEnvironment: onboardingTargetEnvironmentSchema,
  requiredComponents: z.number().int().nonnegative(),
  passedComponents: z.number().int().nonnegative(),
  requiredSteps: z.number().int().nonnegative(),
  completedSteps: z.number().int().nonnegative(),
  blockers: z.array(z.string().min(1).max(500)),
  warnings: z.array(z.string().min(1).max(500)),
});

export const onboardingSnapshotSchema = z.object({
  generatedAt: z.iso.datetime(),
  installation: installationCredentialSummarySchema,
  architecture: architectureDecisionSchema,
  recovery: credentialRecoveryControlSchema,
  journey: onboardingJourneySchema,
  components: z.array(componentCompatibilitySchema),
  steps: z.array(onboardingStepSchema),
  evidence: z.array(onboardingEvidenceSchema),
  gate: onboardingGateSchema,
});

export const runOnboardingValidationSchema = z.object({
  stageKey: onboardingStepKeySchema.optional(),
}).strict();

export const exportRecoveryKitSchema = z.object({
  recoveryOwner: z.string().trim().min(2).max(160),
  passphrase: z.string().min(16).max(1024),
  expectedRevision: z.number().int().nonnegative(),
}).strict();

export const recoveryKitExportSchema = z.object({
  fileName: z.string().min(1).max(240),
  serializedKit: z.string().min(100).max(16_384),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  keyFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});

export const verifyRecoveryKitSchema = z.object({
  serializedKit: z.string().min(100).max(16_384),
  passphrase: z.string().min(16).max(1024),
  expectedRevision: z.number().int().nonnegative(),
}).strict();

export const completeOnboardingSchema = z.object({
  reason: z.string().trim().min(3).max(1000),
  expectedRevision: z.number().int().nonnegative(),
}).strict();

export type ComponentCompatibilityStatus = z.infer<typeof componentCompatibilityStatusSchema>;
export type OnboardingStepKey = z.infer<typeof onboardingStepKeySchema>;
export type OnboardingJourneyStatus = z.infer<typeof onboardingJourneyStatusSchema>;
export type OnboardingStepStatus = z.infer<typeof onboardingStepStatusSchema>;
export type DeploymentTopologyMode = z.infer<typeof deploymentTopologyModeSchema>;
export type OnboardingTargetEnvironment = z.infer<typeof onboardingTargetEnvironmentSchema>;
export type ArchitectureDecision = z.infer<typeof architectureDecisionSchema>;
export type UpdateArchitectureDecision = z.infer<typeof updateArchitectureDecisionSchema>;
export type ComponentCompatibility = z.infer<typeof componentCompatibilitySchema>;
export type UpdateComponentCompatibility = z.infer<typeof updateComponentCompatibilitySchema>;
export type OnboardingStep = z.infer<typeof onboardingStepSchema>;
export type UpdateOnboardingStep = z.infer<typeof updateOnboardingStepSchema>;
export type OnboardingJourney = z.infer<typeof onboardingJourneySchema>;
export type InstallationCredentialSummary = z.infer<typeof installationCredentialSummarySchema>;
export type CredentialRecoveryControl = z.infer<typeof credentialRecoveryControlSchema>;
export type OnboardingEvidence = z.infer<typeof onboardingEvidenceSchema>;
export type OnboardingGate = z.infer<typeof onboardingGateSchema>;
export type OnboardingSnapshot = z.infer<typeof onboardingSnapshotSchema>;
export type RunOnboardingValidation = z.infer<typeof runOnboardingValidationSchema>;
export type ExportRecoveryKit = z.infer<typeof exportRecoveryKitSchema>;
export type RecoveryKitExport = z.infer<typeof recoveryKitExportSchema>;
export type VerifyRecoveryKit = z.infer<typeof verifyRecoveryKitSchema>;
export type CompleteOnboarding = z.infer<typeof completeOnboardingSchema>;
