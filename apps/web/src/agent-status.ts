import type { AgentProfile, AgentRun } from "@orcasynapse/contracts";

/**
 * The status vocabulary the two halves of the Agents area share.
 *
 * Profiles and Runtime are separate screens with separate data, but a status
 * dot has to mean the same thing on both -- an ACTIVE Profile and a COMPLETED
 * run are the same green, and an operator moving between the tabs is entitled
 * to assume that. Leaving a copy of this table in each view is how they would
 * stop agreeing.
 */

/** A run that is still moving, which is what makes the ledger keep polling. */
export const runningStatuses = new Set<string>(["QUEUED", "RUNNING", "CANCEL_REQUESTED"]);

/** Terminal and unhappy. `DENIED` is a policy refusal, not a crash, but it is still not a result. */
export const failedStatuses = new Set<string>(["FAILED", "TIMED_OUT", "DENIED"]);

const terminalGood = new Set<string>(["COMPLETED"]);

export function statusTone(status: AgentRun["status"] | AgentProfile["status"]): string {
  if (terminalGood.has(status) || status === "ACTIVE") return "ready";
  if (runningStatuses.has(status) || status === "STANDBY") return "processing";
  if (failedStatuses.has(status)) return "failed";
  return "neutral";
}
