import type { AgentProfile, AgentRun } from "@orcasynapse/contracts";

/**
 * The status vocabulary profiles and runs share.
 *
 * It was extracted when they were two tabs, and it outlived the split for the
 * reason it was written: a status dot has to mean the same thing on both. An
 * ACTIVE Profile and a COMPLETED run are the same green, and now that a profile
 * row and the runs it produced sit on one screen a few centimetres apart, two
 * private copies of this table disagreeing would be visible at a glance rather
 * than only to someone who changed tabs.
 *
 * `agents-view.tsx` reads it for profile rows and the poll's stop condition;
 * `agent-run-ledger.tsx` reads it for runs.
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
