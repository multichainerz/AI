import type {
  ArchitectureDecision,
  CompleteOnboarding,
  ExportRecoveryKit,
  OnboardingSnapshot,
  RecoveryKitExport,
  RunOnboardingValidation,
  UpdateArchitectureDecision,
  UpdateComponentCompatibility,
  UpdateOnboardingStep,
  VerifyRecoveryKit,
} from "@orcasynapse/contracts";
import type { AdminPrincipal } from "../auth/admin-session.js";

export interface OnboardingManager {
  snapshot(): Promise<OnboardingSnapshot>;
  updateArchitecture(principal: AdminPrincipal, input: UpdateArchitectureDecision): Promise<ArchitectureDecision>;
  updateComponent(principal: AdminPrincipal, key: string, input: UpdateComponentCompatibility): Promise<OnboardingSnapshot>;
  updateStep(principal: AdminPrincipal, key: string, input: UpdateOnboardingStep): Promise<OnboardingSnapshot>;
  runValidation(principal: AdminPrincipal, input: RunOnboardingValidation): Promise<OnboardingSnapshot>;
  exportRecoveryKit(principal: AdminPrincipal, input: ExportRecoveryKit): Promise<RecoveryKitExport>;
  verifyRecoveryKit(principal: AdminPrincipal, input: VerifyRecoveryKit): Promise<OnboardingSnapshot>;
  complete(principal: AdminPrincipal, input: CompleteOnboarding): Promise<OnboardingSnapshot>;
}

export class OnboardingNotFoundError extends Error {
  constructor(message = "The onboarding resource does not exist.") {
    super(message);
    this.name = "OnboardingNotFoundError";
  }
}

export class OnboardingConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OnboardingConflictError";
  }
}
