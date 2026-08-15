import type { ApproveReleaseTarget, PlatformReleaseTarget, PlatformUpdate } from "@orcasynapse/contracts";
import type { AdminPrincipal } from "../auth/admin-session.js";

/**
 * The approved release target: what an operator has decided this deployment
 * should be running.
 *
 * Recording a target does not update anything. The dashboard runs inside the
 * application container and has no host-root or Docker control, and that
 * boundary is deliberate — root agents on VM1 and VM2 read this record and act
 * on it. Everything here is intent.
 */
export interface PlatformReleaseTargetManager {
  /** The release check and the approved target together, for one screen. */
  snapshot(): Promise<PlatformUpdate>;
  approve(principal: AdminPrincipal, input: ApproveReleaseTarget): Promise<PlatformReleaseTarget>;
  clear(principal: AdminPrincipal): Promise<void>;
}

/** The operator asked for something that is not a release this may move to. */
export class ReleaseTargetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseTargetValidationError";
  }
}

/** The stored target moved under the operator's feet. */
export class ReleaseTargetConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseTargetConflictError";
  }
}

/**
 * The release lookup itself failed. Separate from a refusal because the
 * operator did nothing wrong and retrying is the right response.
 */
export class ReleaseTargetUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseTargetUnavailableError";
  }
}
