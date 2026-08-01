import type {
  AgentMetrics,
  AgentProfile,
  AgentProfileList,
  AgentRun,
  AgentRunEventList,
  AgentRunList,
  AgentRuntimeControl,
  CreateAgentProfile,
  SubmitAgentRun,
  UpdateAgentProfile,
  UpdateAgentRuntimeControl,
} from "@aihub/contracts";

export interface AgentPrincipal {
  id: string;
  subject: string;
  identityMode: "ENTERPRISE" | "ADMINISTRATOR_PREVIEW";
  scopes: readonly string[];
}

export interface AgentBoundaryVerifier {
  assertZeroToolBoundary(): Promise<void>;
  assertGovernedToolBoundary(): Promise<void>;
}

export interface AgentManager {
  listProfiles(principal: AgentPrincipal, includeInactive: boolean): Promise<AgentProfileList>;
  createProfile(principal: AgentPrincipal, input: CreateAgentProfile): Promise<AgentProfile>;
  updateProfile(principal: AgentPrincipal, profileId: string, input: UpdateAgentProfile): Promise<AgentProfile>;
  standbyProfile(principal: AgentPrincipal, profileId: string): Promise<AgentProfile>;
  activateProfile(principal: AgentPrincipal, profileId: string): Promise<AgentProfile>;
  suspendProfile(principal: AgentPrincipal, profileId: string): Promise<AgentProfile>;
  listRuns(principal: AgentPrincipal, includeAll: boolean): Promise<AgentRunList>;
  getRun(principal: AgentPrincipal, runId: string, includeAll: boolean): Promise<AgentRun>;
  listRunEvents(principal: AgentPrincipal, runId: string, includeAll: boolean): Promise<AgentRunEventList>;
  submitRun(principal: AgentPrincipal, input: SubmitAgentRun): Promise<AgentRun>;
  cancelRun(principal: AgentPrincipal, runId: string, includeAll: boolean): Promise<AgentRun>;
  getRuntimeControl(): Promise<AgentRuntimeControl>;
  updateRuntimeControl(principal: AgentPrincipal, input: UpdateAgentRuntimeControl): Promise<AgentRuntimeControl>;
  metrics(): Promise<AgentMetrics>;
}

export class AgentNotFoundError extends Error {
  constructor(message = "The agent resource does not exist or is not available to this identity.") {
    super(message);
    this.name = "AgentNotFoundError";
  }
}

export class AgentConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentConflictError";
  }
}

export class AgentRuntimeDisabledError extends Error {
  constructor(message = "Hermes agent execution is disabled by the global runtime control.") {
    super(message);
    this.name = "AgentRuntimeDisabledError";
  }
}
