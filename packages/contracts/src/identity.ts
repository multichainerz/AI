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

export const localPersonPasswordChangeRequestSchema = z.object({
  currentPassword: z.string().min(12).max(1_024),
  newPassword: z.string().min(12).max(1_024),
}).strict();

export const oidcStatusSchema = z.object({
  configured: z.boolean(),
  administratorSignIn: z.boolean().optional(),
  message: z.string(),
});

export type EnterpriseUser = z.infer<typeof enterpriseUserSchema>;
export type EnterpriseSession = z.infer<typeof enterpriseSessionSchema>;
export type LocalPersonPasswordChangeRequest = z.infer<typeof localPersonPasswordChangeRequestSchema>;
export type OidcStatus = z.infer<typeof oidcStatusSchema>;
