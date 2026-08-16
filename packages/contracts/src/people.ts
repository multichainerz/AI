import { z } from "zod";

/**
 * People: the users a division bounds.
 *
 * Until v7.1.0 an `EnterpriseUser` row could only come into existence when
 * somebody arrived through an identity provider, so a deployment with no IdP
 * had a division boundary and nobody to apply it to. An administrator can now
 * create the account directly, which is what "the super admin creates the
 * account" always meant.
 *
 * A person is an identity; a local credential is one way of proving it. The two
 * are separate so a person can later move to an identity provider by dropping a
 * credential rather than by rebuilding an identity.
 */

export const personIdentifierSchema = z.uuid();

/**
 * The group every locally created person belongs to.
 *
 * A tool grant matches an enterprise identity by intersecting the user's groups
 * with the grant's `allowedGroups`. An identity provider supplies groups; a
 * person an administrator created has none, so without this every grant would
 * refuse them and no local person could ever call a tool.
 *
 * A named group rather than a wildcard, so the matcher stays one rule --
 * intersection -- with nothing to special-case, and so an administrator can see
 * in the grant exactly who it admits.
 */
export const LOCAL_PEOPLE_GROUP = "orcasynapse:people";

const usernameSchema = z.string().trim().min(2).max(64).regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);
const displayNameSchema = z.string().trim().min(2).max(200);
const passwordSchema = z.string().min(12).max(1_024);

export const personSchema = z.object({
  id: z.uuid(),
  displayName: displayNameSchema,
  email: z.string().max(320).nullable(),
  divisionId: z.uuid().nullable(),
  enabled: z.boolean(),
  /** Null means created but never signed in. */
  lastLoginAt: z.iso.datetime().nullable(),
  /**
   * How this person proves who they are. `LOCAL` has a username and password
   * here; `FEDERATED` arrived through an identity provider and has no
   * credential this product holds.
   */
  credential: z.enum(["LOCAL", "FEDERATED"]),
  username: z.string().nullable(),
  /** Local only: set at creation and after a reset, cleared once they change it. */
  passwordChangeRequired: z.boolean(),
  /** Local only: non-null while lockout is in force. */
  lockedUntil: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const personListSchema = z.object({ items: z.array(personSchema) });

export const createPersonSchema = z.object({
  displayName: displayNameSchema,
  username: usernameSchema,
  password: passwordSchema,
  email: z.email().max(320).optional(),
  divisionId: z.uuid().nullable().optional(),
}).strict();

export const updatePersonSchema = z.object({
  displayName: displayNameSchema.optional(),
  email: z.email().max(320).nullable().optional(),
  divisionId: z.uuid().nullable().optional(),
  enabled: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: "At least one field must be provided.",
});

export const resetPersonPasswordSchema = z.object({
  password: passwordSchema,
}).strict();

export type Person = z.infer<typeof personSchema>;
export type PersonList = z.infer<typeof personListSchema>;
export type CreatePerson = z.infer<typeof createPersonSchema>;
export type UpdatePerson = z.infer<typeof updatePersonSchema>;
export type ResetPersonPassword = z.infer<typeof resetPersonPasswordSchema>;
