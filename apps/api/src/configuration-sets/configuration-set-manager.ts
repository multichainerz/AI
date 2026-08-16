import type {
  CreateSkillSet,
  CreateToolSet,
  SkillSet,
  SkillSetList,
  ToolSet,
  ToolSetList,
  UpdateSkillSet,
  UpdateToolSet,
} from "@orcasynapse/contracts";
import type { AdminPrincipal } from "../auth/admin-session.js";

export interface ConfigurationSetManager {
  listToolSets(includeRetired: boolean): Promise<ToolSetList>;
  createToolSet(principal: AdminPrincipal, input: CreateToolSet): Promise<ToolSet>;
  updateToolSet(principal: AdminPrincipal, id: string, input: UpdateToolSet): Promise<ToolSet>;
  deleteToolSet(principal: AdminPrincipal, id: string): Promise<void>;

  listSkillSets(includeRetired: boolean): Promise<SkillSetList>;
  createSkillSet(principal: AdminPrincipal, input: CreateSkillSet): Promise<SkillSet>;
  updateSkillSet(principal: AdminPrincipal, id: string, input: UpdateSkillSet): Promise<SkillSet>;
  deleteSkillSet(principal: AdminPrincipal, id: string): Promise<void>;
}

export class ConfigurationSetNotFoundError extends Error {
  constructor(message = "The configuration set does not exist.") {
    super(message);
    this.name = "ConfigurationSetNotFoundError";
  }
}

export class ConfigurationSetConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationSetConflictError";
  }
}
