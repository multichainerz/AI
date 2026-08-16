import type {
  CreateDivision,
  Division,
  DivisionList,
  UpdateDivision,
} from "@orcasynapse/contracts";
import type { AdminPrincipal } from "../auth/admin-session.js";

export interface DivisionManager {
  list(includeSuspended: boolean): Promise<DivisionList>;
  create(principal: AdminPrincipal, input: CreateDivision): Promise<Division>;
  update(principal: AdminPrincipal, id: string, input: UpdateDivision): Promise<Division>;
  remove(principal: AdminPrincipal, id: string): Promise<void>;
  /** `divisionId: null` returns the profile to deployment-wide. */
  assignProfile(
    principal: AdminPrincipal,
    profileId: string,
    divisionId: string | null,
    expectedRevision: number,
  ): Promise<void>;
}

export class DivisionNotFoundError extends Error {
  constructor(message = "The division does not exist.") {
    super(message);
    this.name = "DivisionNotFoundError";
  }
}

export class DivisionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DivisionConflictError";
  }
}
