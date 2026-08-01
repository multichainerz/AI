import { describe, expect, it } from "vitest";
import {
  completeOnboardingSchema,
  exportRecoveryKitSchema,
  runOnboardingValidationSchema,
  updateArchitectureDecisionSchema,
  updateComponentCompatibilitySchema,
  updateOnboardingStepSchema,
  verifyRecoveryKitSchema,
} from "./onboarding.js";

describe("onboarding contracts", () => {
  it("requires version and evidence before a component can pass", () => {
    expect(updateComponentCompatibilitySchema.safeParse({
      status: "PASSED", note: "Validated in the target deployment.", expectedRevision: 0,
    }).success).toBe(false);
    expect(updateComponentCompatibilitySchema.safeParse({
      status: "PASSED", observedVersion: "24.18.0", evidenceRef: "report:node-runtime:42",
      attestationAuthority: "MPM Infrastructure", note: "Validated in the target deployment.", expectedRevision: 0,
    }).success).toBe(true);
  });

  it("requires evidence before a journey stage can complete", () => {
    expect(updateOnboardingStepSchema.safeParse({
      status: "COMPLETED", evidenceRefs: [], note: "Reviewed by the operator.", expectedRevision: 1,
    }).success).toBe(false);
    expect(updateOnboardingStepSchema.safeParse({
      status: "COMPLETED", evidenceRefs: ["signed:preflight:42"], note: "Reviewed by the operator.", expectedRevision: 1,
    }).success).toBe(true);
  });

  it("makes architecture changes revision-safe and completion explicit", () => {
    expect(updateArchitectureDecisionSchema.safeParse({
      topologyMode: "SEGMENTED_PRODUCTION", reason: "Isolate the agent runtime from the control plane.", expectedRevision: 2,
    }).success).toBe(true);
    expect(updateArchitectureDecisionSchema.safeParse({ reason: "No actual decision.", expectedRevision: 2 }).success).toBe(false);
    expect(completeOnboardingSchema.safeParse({ reason: "Evidence accepted by MPM.", expectedRevision: 4 }).success).toBe(true);
  });

  it("bounds automated validation and customer-held recovery payloads", () => {
    expect(runOnboardingValidationSchema.safeParse({ stageKey: "system-topology" }).success).toBe(true);
    expect(runOnboardingValidationSchema.safeParse({ stageKey: "invented-stage" }).success).toBe(false);
    expect(exportRecoveryKitSchema.safeParse({ recoveryOwner: "MPM Infrastructure", passphrase: "short", expectedRevision: 0 }).success).toBe(false);
    expect(exportRecoveryKitSchema.safeParse({ recoveryOwner: "MPM Infrastructure", passphrase: "a-long-customer-held-secret", expectedRevision: 0 }).success).toBe(true);
    expect(verifyRecoveryKitSchema.safeParse({ serializedKit: "{}", passphrase: "a-long-customer-held-secret", expectedRevision: 1 }).success).toBe(false);
    expect(verifyRecoveryKitSchema.safeParse({ serializedKit: "{" + "x".repeat(120) + "}", passphrase: "a-long-customer-held-secret", expectedRevision: 1 }).success).toBe(true);
  });
});
