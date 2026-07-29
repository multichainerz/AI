import type {
  DecideToolApproval,
  GatewayCredentialList,
  GovernedToolList,
  IssuedGatewayCredential,
  ToolApproval,
  ToolApprovalList,
  ToolCallList,
  ToolGrant,
  ToolGrantList,
  ToolMetrics,
  ToolRuntimeControl,
  ToolStatus,
  UpdateToolRuntimeControl,
  UpsertToolGrant,
} from "@aihub/contracts";

export interface ToolingPrincipal {
  id: string;
  subject: string;
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
  listApprovals(): Promise<ToolApprovalList>;
  decideApproval(principal: ToolingPrincipal, approvalId: string, input: DecideToolApproval): Promise<ToolApproval>;
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
  constructor(message = "The governed tool invocation was denied by current AIHub policy.") {
    super(message);
    this.name = "ToolingDeniedError";
  }
}
