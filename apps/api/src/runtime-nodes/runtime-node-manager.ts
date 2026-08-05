import type {
  CreateHermesNodeInvitation,
  EnrollHermesNode,
  HermesNodeEnrollmentResult,
  HermesNodeEnrollmentBundle,
  HermesNodeHeartbeat,
  HermesNodeHeartbeatResult,
  HermesNodeInvitation,
  HermesRuntimeNode,
  MutateHermesRuntimeNode,
  RemoveHermesRuntimeNode,
  RuntimeDesiredState,
} from "@orcasynapse/contracts";
import type { AdminPrincipal } from "../auth/admin-session.js";

export interface NodeSignatureHeaders {
  timestamp?: string | undefined;
  nonce?: string | undefined;
  signature?: string | undefined;
}

export interface HermesNodeInstallerReadiness {
  ready: boolean;
  dashboardReady: boolean;
  inferenceReady: boolean;
  invitationReady: boolean;
}

export interface HermesRuntimeNodeManager {
  list(): Promise<HermesRuntimeNode[]>;
  installerReadiness(): Promise<HermesNodeInstallerReadiness>;
  createInvitation(principal: AdminPrincipal, input: CreateHermesNodeInvitation): Promise<HermesNodeInvitation>;
  resolveInvitation(token: string): Promise<HermesNodeEnrollmentBundle>;
  enroll(input: EnrollHermesNode, sourceIp?: string): Promise<HermesNodeEnrollmentResult>;
  desiredState(nodeId: string, headers: NodeSignatureHeaders): Promise<RuntimeDesiredState>;
  controlPlanePublicKey(): Promise<{ publicKeyPem: string; fingerprint: string }>;
  heartbeat(
    nodeId: string,
    headers: NodeSignatureHeaders,
    input: HermesNodeHeartbeat,
  ): Promise<HermesNodeHeartbeatResult>;
  mutate(principal: AdminPrincipal, nodeId: string, input: MutateHermesRuntimeNode): Promise<HermesRuntimeNode>;
  remove(principal: AdminPrincipal, nodeId: string, input: RemoveHermesRuntimeNode): Promise<void>;
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
