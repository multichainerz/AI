import { z } from "zod";
import { agentSkillReferenceSchema } from "./agents.js";

/**
 * Named, reusable selections a profile points at: a **tool set** of Hermes
 * toolsets and a **skill set** of Skills.
 *
 * Both live here rather than in two modules because they are the same shape
 * with a different payload, and splitting them invites the two to drift.
 *
 * Vocabulary, because three nearby things are easy to confuse:
 *
 * - a *Hermes toolset* is the runtime's own unit, admitted deployment-wide by
 *   `RuntimeToolsetAdmission`;
 * - a **tool set** here names a reusable subset of those;
 * - a *governed tool* (`GovernedTool` / `AgentToolGrant`) is an
 *   OrcaSynapse-implemented tool on the MCP plane, granted per profile version
 *   and enforced by us. A tool set does not name those and never should --
 *   putting the same decision in two places is how they drift apart.
 */

export const CONFIGURATION_SET_STATUSES = ["ACTIVE", "RETIRED"] as const;
export const configurationSetStatusSchema = z.enum(CONFIGURATION_SET_STATUSES);
/** Lives here so route handlers need no direct zod dependency. */
export const configurationSetIdentifierSchema = z.uuid();

const setSlugSchema = z.string().trim().min(2).max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const setDisplayNameSchema = z.string().trim().min(2).max(120);
const setDescriptionSchema = z.string().trim().max(500);

/** Matches the bound the desired-state document already enforces on a name. */
const toolsetNameSchema = z.string().trim().min(1).max(120);

const setCommonSchema = {
  id: z.uuid(),
  slug: setSlugSchema,
  displayName: setDisplayNameSchema,
  description: setDescriptionSchema,
  status: configurationSetStatusSchema,
  revision: z.number().int().positive(),
  createdBy: z.uuid().nullable(),
  updatedBy: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
};

export const toolSetSchema = z.object({
  ...setCommonSchema,
  toolsetNames: z.array(toolsetNameSchema).max(200),
  /**
   * The set means "everything this deployment admits", resolved when read.
   *
   * The seeded default carries this because nothing is admitted at install: a
   * set that snapshotted admission at seed time would be empty, and an empty
   * list is indistinguishable from a deliberate "no tools". It is also the only
   * value that cannot break a run -- a set narrower than what the node has
   * enabled makes the Hermes tool boundary assertion throw.
   */
  tracksAdmission: z.boolean(),
  /**
   * What `tracksAdmission` resolves to right now, filled in by the reader.
   *
   * Null on a set that lists its own members, so a caller can always tell "this
   * set names these" from "this set means whatever is admitted, which is
   * currently these".
   */
  resolvedToolsetNames: z.array(toolsetNameSchema).max(200).nullable(),
});

export const skillSetSchema = z.object({
  ...setCommonSchema,
  skills: z.array(agentSkillReferenceSchema).max(200),
  /** As `tracksAdmission`, for the Skills the enrolled runtime reports. */
  tracksRuntime: z.boolean(),
});

export const toolSetListSchema = z.object({ items: z.array(toolSetSchema) });
export const skillSetListSchema = z.object({ items: z.array(skillSetSchema) });

export const createToolSetSchema = z.object({
  slug: setSlugSchema,
  displayName: setDisplayNameSchema,
  description: setDescriptionSchema.optional(),
  toolsetNames: z.array(toolsetNameSchema).max(200),
}).strict();

export const updateToolSetSchema = z.object({
  displayName: setDisplayNameSchema.optional(),
  description: setDescriptionSchema.optional(),
  toolsetNames: z.array(toolsetNameSchema).max(200).optional(),
  status: configurationSetStatusSchema.optional(),
  expectedRevision: z.number().int().positive(),
}).strict();

export const createSkillSetSchema = z.object({
  slug: setSlugSchema,
  displayName: setDisplayNameSchema,
  description: setDescriptionSchema.optional(),
  skills: z.array(agentSkillReferenceSchema).max(200),
}).strict();

export const updateSkillSetSchema = z.object({
  displayName: setDisplayNameSchema.optional(),
  description: setDescriptionSchema.optional(),
  skills: z.array(agentSkillReferenceSchema).max(200).optional(),
  status: configurationSetStatusSchema.optional(),
  expectedRevision: z.number().int().positive(),
}).strict();

export type ConfigurationSetStatus = z.infer<typeof configurationSetStatusSchema>;
export type ToolSet = z.infer<typeof toolSetSchema>;
export type SkillSet = z.infer<typeof skillSetSchema>;
export type ToolSetList = z.infer<typeof toolSetListSchema>;
export type SkillSetList = z.infer<typeof skillSetListSchema>;
export type CreateToolSet = z.infer<typeof createToolSetSchema>;
export type UpdateToolSet = z.infer<typeof updateToolSetSchema>;
export type CreateSkillSet = z.infer<typeof createSkillSetSchema>;
export type UpdateSkillSet = z.infer<typeof updateSkillSetSchema>;
