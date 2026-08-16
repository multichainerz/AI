import type {
  ScopedMemoryList,
  DecideToolsetAdmission,
  ToolApproval,
  GatewayCredentialList,
  GovernedToolList,
  IssuedGatewayCredential,
  ToolCallList,
  ToolGrant,
  ToolGrantList,
  ToolMetrics,
  ToolRuntimeControl,
  ToolsetAdmission,
  ToolStatus,
  UpdateToolRuntimeControl,
  UpsertToolGrant,
} from "@orcasynapse/contracts";

export interface ToolingPrincipal {
  id: string;
  subject: string;
}

export interface ToolBoundaryVerifier {
  assertAdmittedToolBoundary(admitted?: Iterable<string>): Promise<void>;
}

export interface GovernedToolInvocation {
  requestId: string;
  authorization: string;
  arguments: Record<string, unknown>;
}

export interface GovernedToolResult {
  callId: string;
  status: "COMPLETED" | "APPROVAL_PENDING" | "EXECUTING" | "FAILED" | "DENIED";
  data: Record<string, unknown>;
  isError: boolean;
}

export interface ToolingManager {
  listTools(): Promise<GovernedToolList>;
  /** What agents have remembered, for Agents → Memory. Division-labelled, not division-filtered. */
  listScopedMemory(limit?: number): Promise<ScopedMemoryList>;
  listToolsForRun(authorization: string | undefined): Promise<GovernedToolList>;
  setToolStatus(principal: ToolingPrincipal, toolId: string, status: ToolStatus): Promise<void>;
  listGrants(): Promise<ToolGrantList>;
  upsertGrant(principal: ToolingPrincipal, input: UpsertToolGrant): Promise<ToolGrant>;
  listCredentials(): Promise<GatewayCredentialList>;
  issueCredential(principal: ToolingPrincipal, name: string): Promise<IssuedGatewayCredential>;
  revokeCredential(principal: ToolingPrincipal, credentialId: string): Promise<void>;
  authenticateGateway(token: string | undefined): Promise<boolean>;
  invoke(toolSlug: string, invocation: GovernedToolInvocation): Promise<GovernedToolResult>;
  recordDeniedInvocation(toolSlug: string, invocation: GovernedToolInvocation, reason: string): Promise<void>;
  listCalls(): Promise<ToolCallList>;
  /** Approvals still awaiting a human decision. */
  listPendingApprovals(): Promise<{ items: ToolApproval[] }>;
  /** Records a human decision on a pending consequential tool call. */
  decideApproval(principal: ToolingPrincipal, approvalId: string, approve: boolean, reason: string): Promise<void>;
  admittedToolsetNames(): Promise<string[]>;
  listToolsetAdmissions(): Promise<{ items: ToolsetAdmission[] }>;
  decideToolsetAdmission(
    principal: ToolingPrincipal,
    toolsetName: string,
    input: DecideToolsetAdmission,
  ): Promise<ToolsetAdmission>;
  getRuntimeControl(): Promise<ToolRuntimeControl>;
  updateRuntimeControl(principal: ToolingPrincipal, input: UpdateToolRuntimeControl): Promise<ToolRuntimeControl>;
  metrics(): Promise<ToolMetrics>;
}

export class ToolingNotFoundError extends Error {
  constructor(message = "The governed-tool resource does not exist.") {
    super(message);
    this.name = "ToolingNotFoundError";
  }
}

export class ToolingConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolingConflictError";
  }
}

export class ToolingDeniedError extends Error {
  constructor(message = "The governed tool invocation was denied by current OrcaSynapse policy.") {
    super(message);
    this.name = "ToolingDeniedError";
  }
}
