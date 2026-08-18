import { z } from "zod";

export const AUDIT_ACTOR_TYPES = ["USER", "SERVICE", "SYSTEM"] as const;
export const auditActorTypeSchema = z.enum(AUDIT_ACTOR_TYPES);

export const auditEventSchema = z.object({
  id: z.string().uuid(),
  occurredAt: z.string(),
  actorType: auditActorTypeSchema,
  actorId: z.string().uuid().nullable(),
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.string().nullable(),
  outcome: z.string(),
  correlationId: z.string().uuid().nullable(),
  sourceIp: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
});

/**
 * Filters are deliberately exact-match rather than free-text: the trail is
 * evidence, and a substring search over attacker-influenced action names would
 * invite both false positives and expensive scans.
 */
export const auditEventQuerySchema = z.object({
  action: z.string().trim().min(1).max(160).optional(),
  actorType: auditActorTypeSchema.optional(),
  actorId: z.string().uuid().optional(),
  resourceType: z.string().trim().min(1).max(120).optional(),
  resourceId: z.string().trim().min(1).max(160).optional(),
  outcome: z.string().trim().min(1).max(40).optional(),
  correlationId: z.string().uuid().optional(),
  occurredFrom: z.string().datetime().optional(),
  occurredTo: z.string().datetime().optional(),
  // Keyset pagination on (occurredAt, id): an append-only trail cannot use
  // offsets without skipping or repeating rows as it grows underneath a reader.
  beforeOccurredAt: z.string().datetime().optional(),
  beforeId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).strict();

export const auditEventListSchema = z.object({
  items: z.array(auditEventSchema),
  nextCursor: z.object({
    beforeOccurredAt: z.string(),
    beforeId: z.string().uuid(),
  }).nullable(),
});

export type AuditEvent = z.infer<typeof auditEventSchema>;
export type AuditEventQuery = z.infer<typeof auditEventQuerySchema>;
export type AuditEventList = z.infer<typeof auditEventListSchema>;
