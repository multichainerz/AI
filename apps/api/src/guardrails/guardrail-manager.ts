import type {
  ChangeGuardrailPolicyState,
  CreateGuardrailPolicy,
  GuardrailPolicy,
  GuardrailPolicyList,
  UpdateGuardrailPolicy,
} from "@orcasynapse/contracts";
import type { AdminPrincipal } from "../auth/admin-session.js";

export interface GuardrailManager {
  list(): Promise<GuardrailPolicyList>;
  create(principal: AdminPrincipal, input: CreateGuardrailPolicy): Promise<GuardrailPolicy>;
  update(principal: AdminPrincipal, id: string, input: UpdateGuardrailPolicy): Promise<GuardrailPolicy>;
  activate(principal: AdminPrincipal, id: string, input: ChangeGuardrailPolicyState): Promise<GuardrailPolicy>;
  suspend(principal: AdminPrincipal, id: string, input: ChangeGuardrailPolicyState): Promise<GuardrailPolicy>;
}

export class GuardrailNotFoundError extends Error {
  constructor(message = "The guardrail policy does not exist.") {
    super(message);
    this.name = "GuardrailNotFoundError";
  }
}

export class GuardrailConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardrailConflictError";
  }
}
