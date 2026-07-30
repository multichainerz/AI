import type {
  CreateHermesNodeInvitation,
  EnrollHermesNode,
  HermesNodeEnrollmentResult,
  HermesNodeHeartbeat,
  HermesNodeHeartbeatResult,
  HermesNodeInvitation,
  HermesRuntimeNode,
  MutateHermesRuntimeNode,
} from "@aihub/contracts";
import type { AdminPrincipal } from "../auth/admin-session.js";

export interface NodeSignatureHeaders {
  timestamp?: string | undefined;
  nonce?: string | undefined;
  signature?: string | undefined;
}

export interface HermesRuntimeNodeManager {
  list(): Promise<HermesRuntimeNode[]>;
  createInvitation(principal: AdminPrincipal, input: CreateHermesNodeInvitation): Promise<HermesNodeInvitation>;
  enroll(input: EnrollHermesNode, sourceIp?: string): Promise<HermesNodeEnrollmentResult>;
  heartbeat(
    nodeId: string,
    headers: NodeSignatureHeaders,
    input: HermesNodeHeartbeat,
  ): Promise<HermesNodeHeartbeatResult>;
  mutate(principal: AdminPrincipal, nodeId: string, input: MutateHermesRuntimeNode): Promise<HermesRuntimeNode>;
}

export class RuntimeNodeNotFoundError extends Error {
  constructor(message = "The Hermes runtime node does not exist.") {
    super(message);
    this.name = "RuntimeNodeNotFoundError";
  }
}

export class RuntimeNodeConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeNodeConflictError";
  }
}

export class RuntimeNodeEnrollmentError extends Error {
  constructor(
    message: string,
    readonly code: "INVALID" | "EXPIRED" | "CONSUMED" | "HOSTNAME_MISMATCH",
  ) {
    super(message);
    this.name = "RuntimeNodeEnrollmentError";
  }
}

export class RuntimeNodeAuthenticationError extends Error {
  constructor(message = "The runtime node signature is invalid.") {
    super(message);
    this.name = "RuntimeNodeAuthenticationError";
  }
}
