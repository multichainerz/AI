import { z } from "zod";

export const ADMIN_ROLES = [
  "PLATFORM_ADMIN",
  "SECURITY_ADMIN",
  "OPERATIONS_ADMIN",
  "AUDITOR",
] as const;

export const ADMIN_SCOPES = [
  "chat:use",
  "connections:read",
  "connections:write",
  "connections:test",
  "operations:read",
  "operations:execute",
  "audit:read",
  "sessions:manage",
  "models:read",
  "models:manage",
  "guardrails:read",
  "guardrails:manage",
  "prompts:read",
  "prompts:manage",
  "agents:read",
  "agents:manage",
  "agents:control",
  "tools:read",
  "tools:manage",
  "evaluations:read",
  "evaluations:manage",
  "evaluations:promote",
  "readiness:read",
  "readiness:manage",
  "readiness:approve",
] as const;

export const adminRoleSchema = z.enum(ADMIN_ROLES);
export const adminScopeSchema = z.enum(ADMIN_SCOPES);

export const ADMIN_AUTHENTICATION_METHODS = [
  "LOCAL_PASSWORD",
  "INSTALLATION_KEY_RECOVERY",
  "OIDC",
] as const;

export const adminAuthenticationMethodSchema = z.enum(ADMIN_AUTHENTICATION_METHODS);

export const localAdministratorLoginRequestSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(12).max(1_024),
}).strict();

export const localAdministratorPasswordChangeRequestSchema = z.object({
  currentPassword: z.string().min(12).max(1_024),
  newPassword: z.string().min(12).max(1_024),
}).strict();

export const installationKeyRecoveryRequestSchema = z.object({
  username: z.string().trim().min(1).max(64),
  newPassword: z.string().min(12).max(1_024),
}).strict();

export const installationKeySessionRequestSchema = z.object({
  installationKey: z.string().min(32).max(4_096),
}).strict();

export const administratorSessionSchema = z.object({
  id: z.uuid(),
  subject: z.string().min(1).max(160),
  role: adminRoleSchema,
  scopes: z.array(adminScopeSchema),
  createdAt: z.iso.datetime(),
  idleExpiresAt: z.iso.datetime(),
  absoluteExpiresAt: z.iso.datetime(),
  authenticationMethod: adminAuthenticationMethodSchema.optional(),
  passwordChangeRequired: z.boolean().optional(),
});

export type AdminRole = z.infer<typeof adminRoleSchema>;
export type AdminScope = z.infer<typeof adminScopeSchema>;
export type AdminAuthenticationMethod = z.infer<typeof adminAuthenticationMethodSchema>;
export type LocalAdministratorLoginRequest = z.infer<typeof localAdministratorLoginRequestSchema>;
export type LocalAdministratorPasswordChangeRequest = z.infer<typeof localAdministratorPasswordChangeRequestSchema>;
export type InstallationKeyRecoveryRequest = z.infer<typeof installationKeyRecoveryRequestSchema>;
export type InstallationKeySessionRequest = z.infer<typeof installationKeySessionRequestSchema>;
export type AdministratorSession = z.infer<typeof administratorSessionSchema>;
