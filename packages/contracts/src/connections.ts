import { z } from "zod";

export const SERVICE_KINDS = [
  "VLLM",
  "HERMES",
  "SUPERMEMORY",
  "MCP",
  "OIDC",
  "SIEM",
  "NOTIFICATION",
  "OTHER",
] as const;

export const ENVIRONMENTS = ["DEVELOPMENT", "STAGING", "PRODUCTION"] as const;

export const CONNECTION_STATUSES = [
  "NOT_TESTED",
  "HEALTHY",
  "DEGRADED",
  "UNREACHABLE",
  "DISABLED",
] as const;

export const serviceKindSchema = z.enum(SERVICE_KINDS);
export const environmentSchema = z.enum(ENVIRONMENTS);
export const connectionStatusSchema = z.enum(CONNECTION_STATUSES);
export const serviceConnectionIdentifierSchema = z.uuid();

export const serviceEndpointSchema = z.url().max(2_048).refine(
  (value) => value.startsWith("http://") || value.startsWith("https://"),
  { message: "Service endpoint must use HTTP or HTTPS." },
).refine((value) => !/^https?:\/\/[^/]*@/i.test(value), {
  message: "Credentials must be stored as secrets, not embedded in the endpoint URL.",
});

const secretFieldNameSchema = z
  .string()
  .min(2)
  .max(120)
  .regex(/^[a-z][a-zA-Z0-9]*$/, "Secret field names must use camelCase.");

const secretValuesSchema = z.record(secretFieldNameSchema, z.string().min(1).max(16_384));

const relativeHealthPathSchema = z
  .string()
  .min(1)
  .max(240)
  .regex(/^\/(?!\/)[^\s?#]*$/, "Path must be a relative service path beginning with one slash.");

const modelAliasSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, "Model alias contains unsupported characters.");

const oidcClaimNameSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/, "Claim names must use dot-separated identifier segments.");

const oidcGroupSchema = z.string().trim().min(1).max(200);

export const serviceConnectionConfigurationSchema = z
  .object({
    timeoutMs: z.number().int().min(1_000).max(30_000).optional(),
    healthPath: relativeHealthPathSchema.optional(),
    modelsPath: relativeHealthPathSchema.optional(),
    modelAlias: modelAliasSchema.optional(),
    chatPath: relativeHealthPathSchema.optional(),
    maxOutputTokens: z.number().int().min(64).max(32_768).optional(),
    temperature: z.number().min(0).max(2).optional(),
    inferenceTimeoutMs: z.number().int().min(5_000).max(600_000).optional(),
    requestsPerMinute: z.number().int().min(1).max(120).optional(),
    documentsPath: relativeHealthPathSchema.optional(),
    searchPath: relativeHealthPathSchema.optional(),
    memoryTimeoutMs: z.number().int().min(10_000).max(900_000).optional(),
    memoryPollIntervalMs: z.number().int().min(500).max(30_000).optional(),
    retrievalLimit: z.number().int().min(2).max(20).optional(),
    retrievalThreshold: z.number().min(0).max(1).optional(),
    capabilitiesPath: relativeHealthPathSchema.optional(),
    runsPath: relativeHealthPathSchema.optional(),
    toolsetsPath: relativeHealthPathSchema.optional(),
    runPollIntervalMs: z.number().int().min(500).max(10_000).optional(),
    governedMcpUrl: serviceEndpointSchema.optional(),
    governedToolsetName: z.string().trim().min(2).max(120)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Governed toolset name contains unsupported characters.")
      .optional(),
    clientId: z.string().trim().min(1).max(256).optional(),
    redirectUri: serviceEndpointSchema.optional(),
    scopes: z.array(z.string().trim().min(1).max(120)).min(1).max(20).optional(),
    groupsClaim: oidcClaimNameSchema.optional(),
    allowedGroups: z.array(oidcGroupSchema).max(100).optional(),
    platformAdminGroups: z.array(oidcGroupSchema).max(100).optional(),
    securityAdminGroups: z.array(oidcGroupSchema).max(100).optional(),
    operationsAdminGroups: z.array(oidcGroupSchema).max(100).optional(),
    auditorGroups: z.array(oidcGroupSchema).max(100).optional(),
    emailClaim: oidcClaimNameSchema.optional(),
    nameClaim: oidcClaimNameSchema.optional(),
    tokenAuthMethod: z.enum(["client_secret_basic", "client_secret_post"]).optional(),
    caseSensitiveGroups: z.boolean().optional(),
  })
  .strict();

const connectionConfigurationSchemas = {
  VLLM: serviceConnectionConfigurationSchema.pick({
    timeoutMs: true,
    healthPath: true,
    modelsPath: true,
    modelAlias: true,
    chatPath: true,
    maxOutputTokens: true,
    temperature: true,
    inferenceTimeoutMs: true,
    requestsPerMinute: true,
  }),
  HERMES: serviceConnectionConfigurationSchema.pick({
    timeoutMs: true,
    healthPath: true,
    capabilitiesPath: true,
    runsPath: true,
    toolsetsPath: true,
    runPollIntervalMs: true,
    governedMcpUrl: true,
    governedToolsetName: true,
  }),
  SUPERMEMORY: serviceConnectionConfigurationSchema.pick({
    timeoutMs: true,
    healthPath: true,
    documentsPath: true,
    searchPath: true,
    memoryTimeoutMs: true,
    memoryPollIntervalMs: true,
    retrievalLimit: true,
    retrievalThreshold: true,
  }),
  MCP: serviceConnectionConfigurationSchema.pick({ timeoutMs: true, healthPath: true }),
  OIDC: serviceConnectionConfigurationSchema.pick({
    timeoutMs: true,
    clientId: true,
    redirectUri: true,
    scopes: true,
    groupsClaim: true,
    allowedGroups: true,
    platformAdminGroups: true,
    securityAdminGroups: true,
    operationsAdminGroups: true,
    auditorGroups: true,
    emailClaim: true,
    nameClaim: true,
    tokenAuthMethod: true,
    caseSensitiveGroups: true,
  }),
  SIEM: serviceConnectionConfigurationSchema.pick({ timeoutMs: true, healthPath: true }),
  NOTIFICATION: serviceConnectionConfigurationSchema.pick({
    timeoutMs: true,
    healthPath: true,
  }),
  OTHER: serviceConnectionConfigurationSchema.pick({ timeoutMs: true, healthPath: true }),
} satisfies Record<(typeof SERVICE_KINDS)[number], z.ZodType<ServiceConnectionConfiguration>>;

export function serviceConnectionConfigurationSchemaFor(
  kind: ServiceKind,
): z.ZodType<ServiceConnectionConfiguration> {
  return connectionConfigurationSchemas[kind];
}

export function parseServiceConnectionConfiguration(
  kind: ServiceKind,
  configuration: unknown,
): ServiceConnectionConfiguration {
  return serviceConnectionConfigurationSchemaFor(kind).parse(configuration) as ServiceConnectionConfiguration;
}

function validateKindConfiguration(
  value: { kind: ServiceKind; configuration: ServiceConnectionConfiguration },
  context: z.RefinementCtx,
): void {
  const result = serviceConnectionConfigurationSchemaFor(value.kind).safeParse(value.configuration);
  if (!result.success) {
    context.addIssue({
      code: "custom",
      path: ["configuration"],
      message: result.error.issues.map(({ message }) => message).join(" "),
    });
  }
}

export const serviceConnectionSummarySchema = z.object({
  id: z.uuid(),
  slug: z.string().min(1),
  displayName: z.string().min(1),
  kind: serviceKindSchema,
  environment: environmentSchema,
  baseUrl: serviceEndpointSchema.nullable(),
  enabled: z.boolean(),
  status: connectionStatusSchema,
  configuration: serviceConnectionConfigurationSchema.default({}),
  activeRevision: z.number().int().positive(),
  secretFieldNames: z.array(z.string()),
  lastHealthcheckAt: z.iso.datetime().nullable(),
  lastHealthcheckMessage: z.string().nullable(),
  updatedAt: z.iso.datetime(),
});

export const createServiceConnectionSchema = z
  .object({
    slug: z.string().min(2).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    displayName: z.string().min(2).max(120),
    kind: serviceKindSchema,
    environment: environmentSchema,
    baseUrl: serviceEndpointSchema.nullable().default(null),
    enabled: z.boolean().default(false),
    configuration: serviceConnectionConfigurationSchema.default({}),
    secrets: secretValuesSchema.default({}),
  })
  .strict()
  .superRefine(validateKindConfiguration);

export const updateServiceConnectionSchema = z
  .object({
    displayName: z.string().min(2).max(120).optional(),
    environment: environmentSchema.optional(),
    baseUrl: serviceEndpointSchema.nullable().optional(),
    enabled: z.boolean().optional(),
    configuration: serviceConnectionConfigurationSchema.optional(),
    secrets: secretValuesSchema.optional(),
    removeSecretFields: z.array(secretFieldNameSchema).max(20).optional(),
  })
  .strict()
  .refine(
    (value) =>
      !value.secrets ||
      !value.removeSecretFields ||
      !value.removeSecretFields.some((field) => Object.hasOwn(value.secrets ?? {}, field)),
    { message: "A secret cannot be replaced and removed in the same update." },
  )
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one connection field must be provided.",
  });

export const serviceConnectionListSchema = z.object({
  items: z.array(serviceConnectionSummarySchema),
});

export const connectionTestResultSchema = z.object({
  connectionId: z.uuid(),
  status: z.enum(["HEALTHY", "DEGRADED", "UNREACHABLE"]),
  message: z.string(),
  checkedAt: z.iso.datetime(),
  latencyMs: z.number().int().nonnegative(),
  details: z.record(z.string(), z.unknown()).default({}),
});

export const connectionMonitoringControlSchema = z.object({
  enabled: z.boolean(),
  intervalSeconds: z.number().int().min(30).max(86_400),
  reason: z.string().nullable(),
  updatedAt: z.iso.datetime(),
  updatedBy: z.uuid().nullable(),
});

export const updateConnectionMonitoringControlSchema = z.object({
  enabled: z.boolean(),
  intervalSeconds: z.number().int().min(30).max(86_400),
  reason: z.string().trim().min(3).max(500),
}).strict();

export const configurationRevisionSummarySchema = z.object({
  id: z.uuid(),
  revision: z.number().int().positive(),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  secretFieldNames: z.array(z.string()),
  displayName: z.string().min(2).max(120),
  environment: environmentSchema,
  baseUrl: serviceEndpointSchema.nullable(),
  enabled: z.boolean(),
  configuration: serviceConnectionConfigurationSchema,
  createdBy: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  activatedAt: z.iso.datetime().nullable(),
  active: z.boolean(),
});

export const configurationRevisionListSchema = z.object({
  activeRevision: z.number().int().positive(),
  items: z.array(configurationRevisionSummarySchema),
});

export const rollbackConfigurationRequestSchema = z.object({
  expectedActiveRevision: z.number().int().positive(),
}).strict();

export const rollbackConfigurationResultSchema = z.object({
  connection: serviceConnectionSummarySchema,
  rolledBackFromRevision: z.number().int().positive(),
  targetRevision: z.number().int().positive(),
  createdRevision: z.number().int().positive(),
  preservedSecretFields: z.array(z.string()),
  message: z.string(),
});

export type ServiceKind = z.infer<typeof serviceKindSchema>;
export type Environment = z.infer<typeof environmentSchema>;
export type ConnectionStatus = z.infer<typeof connectionStatusSchema>;
export type ServiceConnectionConfiguration = z.infer<
  typeof serviceConnectionConfigurationSchema
>;
export type ServiceConnectionSummary = z.infer<typeof serviceConnectionSummarySchema>;
export type CreateServiceConnection = z.infer<typeof createServiceConnectionSchema>;
export type UpdateServiceConnection = z.infer<typeof updateServiceConnectionSchema>;
export type ServiceConnectionList = z.infer<typeof serviceConnectionListSchema>;
export type ConnectionTestResult = z.infer<typeof connectionTestResultSchema>;
export type ConnectionMonitoringControl = z.infer<typeof connectionMonitoringControlSchema>;
export type UpdateConnectionMonitoringControl = z.infer<typeof updateConnectionMonitoringControlSchema>;
export type ConfigurationRevisionSummary = z.infer<
  typeof configurationRevisionSummarySchema
>;
export type ConfigurationRevisionList = z.infer<typeof configurationRevisionListSchema>;
export type RollbackConfigurationRequest = z.infer<
  typeof rollbackConfigurationRequestSchema
>;
export type RollbackConfigurationResult = z.infer<
  typeof rollbackConfigurationResultSchema
>;
