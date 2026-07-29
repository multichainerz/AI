import { z } from "zod";

export const ADMIN_ROLES = [
  "PLATFORM_ADMIN",
  "SECURITY_ADMIN",
  "OPERATIONS_ADMIN",
  "AUDITOR",
] as const;

export const ADMIN_SCOPES = [
  "connections:read",
  "connections:write",
  "connections:test",
  "operations:read",
  "operations:execute",
  "audit:read",
  "sessions:manage",
] as const;

export const adminRoleSchema = z.enum(ADMIN_ROLES);
export const adminScopeSchema = z.enum(ADMIN_SCOPES);

export const bootstrapSessionRequestSchema = z.object({
  token: z.string().min(32).max(4_096),
}).strict();

export const administratorSessionSchema = z.object({
  id: z.uuid(),
  subject: z.string().min(1).max(160),
  role: adminRoleSchema,
  scopes: z.array(adminScopeSchema),
  createdAt: z.iso.datetime(),
  idleExpiresAt: z.iso.datetime(),
  absoluteExpiresAt: z.iso.datetime(),
});

export type AdminRole = z.infer<typeof adminRoleSchema>;
export type AdminScope = z.infer<typeof adminScopeSchema>;
export type BootstrapSessionRequest = z.infer<typeof bootstrapSessionRequestSchema>;
export type AdministratorSession = z.infer<typeof administratorSessionSchema>;
