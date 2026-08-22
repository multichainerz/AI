import type { WorkspaceReadiness } from "./platform-readiness.js";
import type { SetupStepKey } from "./setup-steps.js";
import type { ActiveView } from "./workspace-navigation.js";

export type SetupLockReadiness = Pick<
  WorkspaceReadiness,
  "inferenceReady" | "agentModelReady" | "agenticInfrastructureReady"
>;

/**
 * Whether a local-admin session must stay on Setup.
 *
 * On until step 3 is current: unique healthy inference, a default AGENT route,
 * and an online Hermes node. Profile create and the execution toggle then
 * happen on Agents with the full rail back.
 */
export function setupLockActive(readiness: SetupLockReadiness): boolean {
  return !readiness.inferenceReady
    || !readiness.agentModelReady
    || !readiness.agenticInfrastructureReady;
}

export function viewAllowedDuringSetupLock(view: ActiveView): boolean {
  return view === "Deployment";
}

/** The Setup step the lock should land on. */
export function setupLockStep(readiness: Pick<SetupLockReadiness, "inferenceReady">): SetupStepKey {
  return readiness.inferenceReady ? "runtime" : "inference";
}
