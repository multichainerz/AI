import type {
  ChangePromptTemplateState,
  CreatePromptTemplate,
  PromptTemplate,
  PromptTemplateList,
  UpdatePromptTemplate,
} from "@orcasynapse/contracts";
import type { AdminPrincipal } from "../auth/admin-session.js";

export interface PromptManager {
  list(): Promise<PromptTemplateList>;
  create(principal: AdminPrincipal, input: CreatePromptTemplate): Promise<PromptTemplate>;
  update(principal: AdminPrincipal, id: string, input: UpdatePromptTemplate): Promise<PromptTemplate>;
  activate(principal: AdminPrincipal, id: string, input: ChangePromptTemplateState): Promise<PromptTemplate>;
  suspend(principal: AdminPrincipal, id: string, input: ChangePromptTemplateState): Promise<PromptTemplate>;
}

export class PromptNotFoundError extends Error {
  constructor(message = "The prompt template does not exist.") {
    super(message);
    this.name = "PromptNotFoundError";
  }
}

export class PromptConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptConflictError";
  }
}
