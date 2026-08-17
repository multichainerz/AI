import type { UsageReport, UsageWindow } from "@orcasynapse/contracts";

export interface UsageReportOptions {
  window: UsageWindow;
  /**
   * Whether to resolve the per-person breakdown.
   *
   * A parameter rather than something the manager decides, because the decision
   * is the route's: it is a scope test on the caller, and a manager that read
   * the session would be a second place authorization lives. False produces
   * `byUser: null`, which the contract distinguishes from an empty breakdown.
   */
  includeUsers: boolean;
}

export interface UsageManager {
  report(options: UsageReportOptions): Promise<UsageReport>;
}
