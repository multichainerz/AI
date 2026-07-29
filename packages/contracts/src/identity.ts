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
  scopes: z.tuple([z.literal("chat:use"), z.literal("documents:use"), z.literal("agents:use")]),
  createdAt: z.iso.datetime(),
  idleExpiresAt: z.iso.datetime(),
  absoluteExpiresAt: z.iso.datetime(),
});

export const oidcStatusSchema = z.object({
  configured: z.boolean(),
  message: z.string(),
});

export type EnterpriseUser = z.infer<typeof enterpriseUserSchema>;
export type EnterpriseSession = z.infer<typeof enterpriseSessionSchema>;
export type OidcStatus = z.infer<typeof oidcStatusSchema>;
