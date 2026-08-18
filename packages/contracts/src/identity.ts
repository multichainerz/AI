import { z } from "zod";

export const enterpriseUserSchema = z.object({
  id: z.uuid(),
  displayName: z.string().min(1).max(200),
  email: z.email().nullable(),
});

export const enterpriseSessionSchema = z.object({
  id: z.uuid(),
  identityMode: z.literal("ENTERPRISE"),
  user: enterpriseUserSchema,
  scopes: z.tuple([z.literal("chat:use"), z.literal("agents:use")]),
  createdAt: z.iso.datetime(),
  idleExpiresAt: z.iso.datetime(),
  absoluteExpiresAt: z.iso.datetime(),
  /**
   * Local people only. Set at creation and after an administrator reset;
   * omitted (or false) for a federated identity and once they have chosen
   * their own password.
   */
  passwordChangeRequired: z.boolean().optional(),
});

/**
 * The person sign-in body, bounded.
 *
 * This route parsed its body by hand -- `typeof body.username === "string"`
 * with a trim and no ceiling -- while the administrator route next door went
 * through `localAdministratorLoginRequestSchema`. The asymmetry was not
 * cosmetic: a failed sign-in writes `metadata: { username }` into `AuditEvent`,
 * which nothing prunes, so an unauthenticated caller could store a megabyte per
 * attempt in the audit trail.
 *
 * The bounds are the administrator route's, for the columns they land in.
 * `password` takes no minimum here because this route only *checks* a password;
 * refusing a short one before the hash would tell an attacker the length policy,
 * and the password itself is never stored or audited.
 */
export const localPersonLoginRequestSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(1_024),
}).strict();

export const localPersonPasswordChangeRequestSchema = z.object({
  currentPassword: z.string().min(12).max(1_024),
  newPassword: z.string().min(12).max(1_024),
}).strict();

export type EnterpriseUser = z.infer<typeof enterpriseUserSchema>;
export type EnterpriseSession = z.infer<typeof enterpriseSessionSchema>;
export type LocalPersonLoginRequest = z.infer<typeof localPersonLoginRequestSchema>;
export type LocalPersonPasswordChangeRequest = z.infer<typeof localPersonPasswordChangeRequestSchema>;
