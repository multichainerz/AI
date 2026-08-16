import type {
  AgentSkillReference,
  CreateSkillSet,
  CreateToolSet,
  SkillSet,
  SkillSetList,
  ToolSet,
  ToolSetList,
  UpdateSkillSet,
  UpdateToolSet,
} from "@orcasynapse/contracts";
import {
  agentProfile,
  agentProfileVersion,
  auditEvent,
  runtimeToolsetAdmission,
  skillSet,
  toolSet,
  type OrcaSynapseDatabase,
} from "@orcasynapse/database";
import { and, asc, eq } from "drizzle-orm";
import type { AdminPrincipal } from "../auth/admin-session.js";
import { advisoryLock, increment, isUniqueViolation } from "../database-support.js";
import {
  ConfigurationSetConflictError,
  ConfigurationSetNotFoundError,
  type ConfigurationSetManager,
} from "./configuration-set-manager.js";

type StoredToolSet = typeof toolSet.$inferSelect;
type StoredSkillSet = typeof skillSet.$inferSelect;

export class DrizzleConfigurationSetManager implements ConfigurationSetManager {
  constructor(private readonly database: OrcaSynapseDatabase) {}

  /**
   * Every toolset this deployment admits, which is what a tracking set means.
   *
   * Read once per list rather than per row: a tracking set resolves to the same
   * answer for every set that tracks, and the seeded default is usually the only
   * one.
   */
  private async admittedToolsetNames(): Promise<string[]> {
    const rows = await this.database
      .select({ name: runtimeToolsetAdmission.toolsetName })
      .from(runtimeToolsetAdmission)
      // `admitted` is the decision, and it defaults to FALSE: a row here records
      // that somebody considered a toolset, not that they allowed it. Reading
      // every row would report refused toolsets as admitted, and the tracking
      // default would then claim to include tools the node must never enable.
      // The worker filters the same way; these two must agree.
      .where(eq(runtimeToolsetAdmission.admitted, true))
      .orderBy(asc(runtimeToolsetAdmission.toolsetName));
    return rows.map(({ name }) => name);
  }

  private toolSetDto(row: StoredToolSet, admitted: readonly string[]): ToolSet {
    return {
      id: row.id,
      slug: row.slug,
      displayName: row.displayName,
      description: row.description,
      status: row.status,
      toolsetNames: row.toolsetNames,
      tracksAdmission: row.tracksAdmission,
      // Null when the set names its own members, so a caller can always tell
      // "this set names these" from "this set means whatever is admitted,
      // which currently happens to be these".
      resolvedToolsetNames: row.tracksAdmission ? [...admitted] : null,
      revision: row.revision,
      createdBy: row.createdBy,
      updatedBy: row.updatedBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private skillSetDto(row: StoredSkillSet): SkillSet {
    return {
      id: row.id,
      slug: row.slug,
      displayName: row.displayName,
      description: row.description,
      status: row.status,
      skills: row.skills as AgentSkillReference[],
      tracksRuntime: row.tracksRuntime,
      revision: row.revision,
      createdBy: row.createdBy,
      updatedBy: row.updatedBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * Refuse a delete that would silently rewrite a shipped profile version.
   *
   * The message names the profiles rather than saying "in use", because an
   * operator who cannot see which profile is holding the set has no next step.
   * `ON DELETE RESTRICT` on the foreign key is the backstop if this is ever
   * bypassed; this exists so the answer is legible rather than a constraint
   * violation.
   */
  private async assertUnreferenced(
    column: typeof agentProfileVersion.toolSetId | typeof agentProfileVersion.skillSetId,
    id: string,
  ): Promise<void> {
    const holders = await this.database
      .selectDistinct({ slug: agentProfile.slug })
      .from(agentProfileVersion)
      .innerJoin(agentProfile, eq(agentProfile.id, agentProfileVersion.profileId))
      .where(eq(column, id))
      .limit(6);
    if (holders.length === 0) return;
    const named = holders.slice(0, 5).map(({ slug }) => slug).join(", ");
    throw new ConfigurationSetConflictError(
      holders.length > 5
        ? `This set is used by ${named} and other profiles. Point them at another set first.`
        : `This set is used by ${named}. Point ${holders.length === 1 ? "it" : "them"} at another set first.`,
    );
  }

  async listToolSets(includeRetired: boolean): Promise<ToolSetList> {
    const [rows, admitted] = await Promise.all([
      this.database
        .select()
        .from(toolSet)
        .where(includeRetired ? undefined : eq(toolSet.status, "ACTIVE"))
        .orderBy(asc(toolSet.displayName))
        .limit(200),
      this.admittedToolsetNames(),
    ]);
    return { items: rows.map((row) => this.toolSetDto(row, admitted)) };
  }

  async createToolSet(principal: AdminPrincipal, input: CreateToolSet): Promise<ToolSet> {
    try {
      const created = await this.database.transaction(async (transaction) => {
        const [row] = await transaction
          .insert(toolSet)
          .values({
            slug: input.slug,
            displayName: input.displayName,
            description: input.description ?? "",
            toolsetNames: input.toolsetNames,
            createdBy: principal.id,
            updatedBy: principal.id,
          })
          .returning();
        if (!row) throw new ConfigurationSetConflictError("The tool set could not be created.");
        await transaction.insert(auditEvent).values({
          actorType: "USER", actorId: principal.id, action: "configuration.tool_set_created",
          resourceType: "ToolSet", resourceId: row.id, outcome: "SUCCESS",
        });
        return row;
      });
      return this.toolSetDto(created, await this.admittedToolsetNames());
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConfigurationSetConflictError("A tool set with that slug already exists.");
      throw error;
    }
  }

  async updateToolSet(principal: AdminPrincipal, id: string, input: UpdateToolSet): Promise<ToolSet> {
    const { expectedRevision, ...changes } = input;
    const updated = await this.database.transaction(async (transaction) => {
      await transaction.execute(advisoryLock(`orcasynapse-tool-set:${id}`));
      const [current] = await transaction.select().from(toolSet).where(eq(toolSet.id, id)).limit(1);
      if (!current) throw new ConfigurationSetNotFoundError();
      /*
       * A tracking set cannot be given an explicit member list.
       *
       * Letting both be set would leave two answers to "what is in this set?"
       * with nothing deciding between them, and the seeded default is exactly
       * the set an operator is most likely to try to edit.
       */
      if (current.tracksAdmission && changes.toolsetNames !== undefined) {
        throw new ConfigurationSetConflictError(
          "This set tracks everything the deployment admits, so it has no fixed member list. Create a new set to name specific toolsets.",
        );
      }
      const [row] = await transaction
        .update(toolSet)
        .set({
          ...(changes.displayName === undefined ? {} : { displayName: changes.displayName }),
          ...(changes.description === undefined ? {} : { description: changes.description }),
          ...(changes.toolsetNames === undefined ? {} : { toolsetNames: changes.toolsetNames }),
          ...(changes.status === undefined ? {} : { status: changes.status }),
          revision: increment(toolSet.revision),
          updatedBy: principal.id,
        })
        .where(and(eq(toolSet.id, id), eq(toolSet.revision, expectedRevision)))
        .returning();
      if (!row) throw new ConfigurationSetConflictError("The tool set changed in another session. Refresh and try again.");
      await transaction.insert(auditEvent).values({
        actorType: "USER", actorId: principal.id, action: "configuration.tool_set_updated",
        resourceType: "ToolSet", resourceId: id, outcome: "SUCCESS",
      });
      return row;
    });
    return this.toolSetDto(updated, await this.admittedToolsetNames());
  }

  async deleteToolSet(principal: AdminPrincipal, id: string): Promise<void> {
    const [current] = await this.database.select().from(toolSet).where(eq(toolSet.id, id)).limit(1);
    if (!current) throw new ConfigurationSetNotFoundError();
    await this.assertUnreferenced(agentProfileVersion.toolSetId, id);
    await this.database.transaction(async (transaction) => {
      await transaction.delete(toolSet).where(eq(toolSet.id, id));
      await transaction.insert(auditEvent).values({
        actorType: "USER", actorId: principal.id, action: "configuration.tool_set_deleted",
        resourceType: "ToolSet", resourceId: id, outcome: "SUCCESS",
      });
    });
  }

  async listSkillSets(includeRetired: boolean): Promise<SkillSetList> {
    const rows = await this.database
      .select()
      .from(skillSet)
      .where(includeRetired ? undefined : eq(skillSet.status, "ACTIVE"))
      .orderBy(asc(skillSet.displayName))
      .limit(200);
    return { items: rows.map((row) => this.skillSetDto(row)) };
  }

  async createSkillSet(principal: AdminPrincipal, input: CreateSkillSet): Promise<SkillSet> {
    try {
      const created = await this.database.transaction(async (transaction) => {
        const [row] = await transaction
          .insert(skillSet)
          .values({
            slug: input.slug,
            displayName: input.displayName,
            description: input.description ?? "",
            skills: input.skills,
            createdBy: principal.id,
            updatedBy: principal.id,
          })
          .returning();
        if (!row) throw new ConfigurationSetConflictError("The skill set could not be created.");
        await transaction.insert(auditEvent).values({
          actorType: "USER", actorId: principal.id, action: "configuration.skill_set_created",
          resourceType: "SkillSet", resourceId: row.id, outcome: "SUCCESS",
        });
        return row;
      });
      return this.skillSetDto(created);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConfigurationSetConflictError("A skill set with that slug already exists.");
      throw error;
    }
  }

  async updateSkillSet(principal: AdminPrincipal, id: string, input: UpdateSkillSet): Promise<SkillSet> {
    const { expectedRevision, ...changes } = input;
    const updated = await this.database.transaction(async (transaction) => {
      await transaction.execute(advisoryLock(`orcasynapse-skill-set:${id}`));
      const [current] = await transaction.select().from(skillSet).where(eq(skillSet.id, id)).limit(1);
      if (!current) throw new ConfigurationSetNotFoundError();
      if (current.tracksRuntime && changes.skills !== undefined) {
        throw new ConfigurationSetConflictError(
          "This set tracks every Skill the runtime reports, so it has no fixed member list. Create a new set to name specific Skills.",
        );
      }
      const [row] = await transaction
        .update(skillSet)
        .set({
          ...(changes.displayName === undefined ? {} : { displayName: changes.displayName }),
          ...(changes.description === undefined ? {} : { description: changes.description }),
          ...(changes.skills === undefined ? {} : { skills: changes.skills }),
          ...(changes.status === undefined ? {} : { status: changes.status }),
          revision: increment(skillSet.revision),
          updatedBy: principal.id,
        })
        .where(and(eq(skillSet.id, id), eq(skillSet.revision, expectedRevision)))
        .returning();
      if (!row) throw new ConfigurationSetConflictError("The skill set changed in another session. Refresh and try again.");
      await transaction.insert(auditEvent).values({
        actorType: "USER", actorId: principal.id, action: "configuration.skill_set_updated",
        resourceType: "SkillSet", resourceId: id, outcome: "SUCCESS",
      });
      return row;
    });
    return this.skillSetDto(updated);
  }

  async deleteSkillSet(principal: AdminPrincipal, id: string): Promise<void> {
    const [current] = await this.database.select().from(skillSet).where(eq(skillSet.id, id)).limit(1);
    if (!current) throw new ConfigurationSetNotFoundError();
    await this.assertUnreferenced(agentProfileVersion.skillSetId, id);
    await this.database.transaction(async (transaction) => {
      await transaction.delete(skillSet).where(eq(skillSet.id, id));
      await transaction.insert(auditEvent).values({
        actorType: "USER", actorId: principal.id, action: "configuration.skill_set_deleted",
        resourceType: "SkillSet", resourceId: id, outcome: "SUCCESS",
      });
    });
  }
}
