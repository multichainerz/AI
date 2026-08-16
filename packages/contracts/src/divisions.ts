import { z } from "zod";

/**
 * A division: the tenant boundary over rows.
 *
 * Deliberately ordinary data. A super admin creates these at runtime with any
 * name and there is no fixed list anywhere in the code — which follows from
 * division not being a scope. Modelled as a scope, every new division would
 * have meant editing `ADMIN_SCOPES`, cutting a release, and upgrading every
 * deployment; as a row it is an insert.
 *
 * A division bounds which profiles a *user* may see and run. It says nothing
 * about administrators, who are deployment-wide, and it is not an isolation
 * boundary: agents on one node still share memory. See `docs/DIVISIONS_PLAN.md`.
 */

export const DIVISION_STATUSES = ["ACTIVE", "SUSPENDED"] as const;
export const divisionStatusSchema = z.enum(DIVISION_STATUSES);
/** Lives here so route handlers need no direct zod dependency. */
export const divisionIdentifierSchema = z.uuid();

const divisionSlugSchema = z.string().trim().min(2).max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const divisionDisplayNameSchema = z.string().trim().min(2).max(120);
const divisionDescriptionSchema = z.string().trim().max(500);

export const divisionSchema = z.object({
  id: z.uuid(),
  slug: divisionSlugSchema,
  displayName: divisionDisplayNameSchema,
  description: divisionDescriptionSchema,
  status: divisionStatusSchema,
  /**
   * What this division currently holds, so a super admin can see the blast
   * radius of a change before making it. Counted on read rather than stored:
   * a denormalised counter that drifts would be worse than none.
   */
  profileCount: z.number().int().nonnegative(),
  userCount: z.number().int().nonnegative(),
  revision: z.number().int().positive(),
  createdBy: z.uuid().nullable(),
  updatedBy: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const divisionListSchema = z.object({ items: z.array(divisionSchema) });

export const createDivisionSchema = z.object({
  slug: divisionSlugSchema,
  displayName: divisionDisplayNameSchema,
  description: divisionDescriptionSchema.optional(),
}).strict();

export const updateDivisionSchema = z.object({
  displayName: divisionDisplayNameSchema.optional(),
  description: divisionDescriptionSchema.optional(),
  status: divisionStatusSchema.optional(),
  expectedRevision: z.number().int().positive(),
}).strict();

/**
 * Assigning a profile to a division, or returning it to deployment-wide.
 *
 * `null` means deployment-wide — visible from every division — which is what
 * every profile is until somebody deliberately assigns one.
 */
export const assignProfileDivisionSchema = z.object({
  divisionId: z.uuid().nullable(),
  expectedRevision: z.number().int().positive(),
}).strict();

export type DivisionStatus = z.infer<typeof divisionStatusSchema>;
export type Division = z.infer<typeof divisionSchema>;
export type DivisionList = z.infer<typeof divisionListSchema>;
export type CreateDivision = z.infer<typeof createDivisionSchema>;
export type UpdateDivision = z.infer<typeof updateDivisionSchema>;
export type AssignProfileDivision = z.infer<typeof assignProfileDivisionSchema>;
