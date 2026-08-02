import type {
  ChangeModelDeploymentState,
  CreateModelDeployment,
  ModelDeployment,
  ModelDeploymentList,
  UpdateModelDeployment,
} from "@orcasynapse/contracts";
import type { AdminPrincipal } from "../auth/admin-session.js";

export interface ModelManager {
  list(): Promise<ModelDeploymentList>;
  create(principal: AdminPrincipal, input: CreateModelDeployment): Promise<ModelDeployment>;
  update(principal: AdminPrincipal, id: string, input: UpdateModelDeployment): Promise<ModelDeployment>;
  activate(principal: AdminPrincipal, id: string, input: ChangeModelDeploymentState): Promise<ModelDeployment>;
  suspend(principal: AdminPrincipal, id: string, input: ChangeModelDeploymentState): Promise<ModelDeployment>;
}

export class ModelNotFoundError extends Error {
  constructor() {
    super("The model route does not exist.");
    this.name = "ModelNotFoundError";
  }
}

export class ModelConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelConflictError";
  }
}
