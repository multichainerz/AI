import type {
  ChangeGuardrailPolicyState,
  CreateGuardrailPolicy,
  GuardrailPolicy,
  GuardrailPolicyList,
  UpdateGuardrailPolicy,
} from "@orcasynapse/contracts";
import { and, arrayContains, asc, desc, eq, isNotNull, ne, sql } from "drizzle-orm";
import {
  auditEvent,
  evaluationRun,
  guardrailPolicy,
  modelDeployment,
  serviceConnection,
  type OrcaSynapseDatabase,
} from "@orcasynapse/database";
import type { AdminPrincipal } from "../auth/admin-session.js";
import { advisoryLock, increment, isUniqueViolation } from "../database-support.js";
import {
  GuardrailConflictError,
  GuardrailNotFoundError,
  type GuardrailManager,
} from "./guardrail-manager.js";

type StoredPolicy = typeof guardrailPolicy.$inferSelect;

function dto(policy: StoredPolicy): GuardrailPolicy {
  return {
    id: policy.id,
    slug: policy.slug,
    displayName: policy.displayName,
    description: policy.description,
    version: policy.version,
    status: policy.status,
    maxInputCharacters: policy.maxInputCharacters,
    maxOutputCharacters: policy.maxOutputCharacters,
    blockControlCharacters: policy.blockControlCharacters,
    blockCredentialPatterns: policy.blockCredentialPatterns,
    activationEvaluationId: policy.activationEvaluationId,
    firstActivatedAt: policy.firstActivatedAt?.toISOString() ?? null,
    revision: policy.revision,
    createdBy: policy.createdBy,
    updatedBy: policy.updatedBy,
    createdAt: policy.createdAt.toISOString(),
    updatedAt: policy.updatedAt.toISOString(),
  };
}

export class DrizzleGuardrailManager implements GuardrailManager {
  constructor(private readonly database: OrcaSynapseDatabase) {}

  async list(): Promise<GuardrailPolicyList> {
    const items = await this.database
      .select()
      .from(guardrailPolicy)
      .orderBy(asc(guardrailPolicy.status), desc(guardrailPolicy.updatedAt))
      .limit(100);
    return { items: items.map(dto) };
  }

  async create(principal: AdminPrincipal, input: CreateGuardrailPolicy): Promise<GuardrailPolicy> {
    try {
      const created = await this.database.transaction(async (transaction) => {
        const [policy] = await transaction
          .insert(guardrailPolicy)
          .values({ ...input, createdBy: principal.id, updatedBy: principal.id })
          .returning();
        if (!policy) throw new GuardrailConflictError("The guardrail policy could not be created.");
        await transaction.insert(auditEvent).values({
          actorType: "USER",
          actorId: principal.id,
          action: "guardrail.policy_created",
          resourceType: "GuardrailPolicy",
          resourceId: policy.id,
          outcome: "SUCCESS",
          metadata: { slug: policy.slug, version: policy.version, enforcementPlane: "ORCASYNAPSE" },
        });
        return policy;
      });
      return dto(created);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new GuardrailConflictError("A guardrail policy already uses this slug.");
      }
      throw error;
    }
  }

  async update(principal: AdminPrincipal, id: string, input: UpdateGuardrailPolicy): Promise<GuardrailPolicy> {
    return this.database.transaction(async (transaction) => {
      const { expectedRevision, ...changes } = input;
      await transaction.execute(advisoryLock(`orcasynapse-guardrail:${id}`));
      const [current] = await transaction.select().from(guardrailPolicy).where(eq(guardrailPolicy.id, id));
      if (!current) throw new GuardrailNotFoundError();
      if (current.status === "ACTIVE") {
        throw new GuardrailConflictError("Suspend the active policy before changing it.");
      }

      const materialChange =
        (changes.version !== undefined && changes.version !== current.version)
        || (changes.maxInputCharacters !== undefined && changes.maxInputCharacters !== current.maxInputCharacters)
        || (changes.maxOutputCharacters !== undefined && changes.maxOutputCharacters !== current.maxOutputCharacters)
        || (changes.blockControlCharacters !== undefined && changes.blockControlCharacters !== current.blockControlCharacters)
        || (changes.blockCredentialPatterns !== undefined && changes.blockCredentialPatterns !== current.blockCredentialPatterns);
      if (materialChange && (!changes.version || changes.version === current.version)) {
        throw new GuardrailConflictError("Runtime guardrail changes require a new policy version.");
      }

      const updated = await transaction
        .update(guardrailPolicy)
        .set({
          ...(changes.displayName === undefined ? {} : { displayName: changes.displayName }),
          ...(changes.description === undefined ? {} : { description: changes.description }),
          ...(changes.version === undefined ? {} : { version: changes.version }),
          ...(changes.maxInputCharacters === undefined ? {} : { maxInputCharacters: changes.maxInputCharacters }),
          ...(changes.maxOutputCharacters === undefined ? {} : { maxOutputCharacters: changes.maxOutputCharacters }),
          ...(changes.blockControlCharacters === undefined ? {} : { blockControlCharacters: changes.blockControlCharacters }),
          ...(changes.blockCredentialPatterns === undefined ? {} : { blockCredentialPatterns: changes.blockCredentialPatterns }),
          status: materialChange ? "DRAFT" : current.status,
          activationEvaluationId: materialChange ? null : current.activationEvaluationId,
          revision: increment(guardrailPolicy.revision),
          updatedBy: principal.id,
        })
        .where(
          and(
            eq(guardrailPolicy.id, id),
            eq(guardrailPolicy.revision, expectedRevision),
            eq(guardrailPolicy.status, current.status),
          ),
        )
        .returning();

      const saved = updated[0];
      if (!saved) {
        throw new GuardrailConflictError("The policy changed in another session. Refresh and try again.");
      }
      await transaction.insert(auditEvent).values({
        actorType: "USER",
        actorId: principal.id,
        action: "guardrail.policy_updated",
        resourceType: "GuardrailPolicy",
        resourceId: id,
        outcome: "SUCCESS",
        metadata: { revision: saved.revision, materialChange, version: saved.version },
      });
      return dto(saved);
    });
  }

  async activate(principal: AdminPrincipal, id: string, input: ChangeGuardrailPolicyState): Promise<GuardrailPolicy> {
    try {
      return await this.database.transaction(async (transaction) => {
        await transaction.execute(advisoryLock(`orcasynapse-guardrail:${id}`));
        await transaction.execute(advisoryLock("orcasynapse-guardrail-active"));
        const [current] = await transaction.select().from(guardrailPolicy).where(eq(guardrailPolicy.id, id));
        if (!current) throw new GuardrailNotFoundError();
        if (current.status === "ACTIVE") throw new GuardrailConflictError("The policy is already active.");

        const [existing] = await transaction
          .select({ displayName: guardrailPolicy.displayName })
          .from(guardrailPolicy)
          .where(and(eq(guardrailPolicy.status, "ACTIVE"), ne(guardrailPolicy.id, id)))
          .limit(1);
        if (existing) {
          throw new GuardrailConflictError(
            `Suspend '${existing.displayName}' before activating another chat policy.`,
          );
        }

        const [enforced] = await transaction
          .select({ total: sql<number>`count(*)::int` })
          .from(modelDeployment)
          .where(and(eq(modelDeployment.workload, "CHAT"), isNotNull(modelDeployment.firstActivatedAt)));
        const catalogueEnforced = (enforced?.total ?? 0) > 0;

        const servingColumns = {
          kind: serviceConnection.kind,
          enabled: serviceConnection.enabled,
          status: serviceConnection.status,
        };

        // Once a chat model route has ever been activated the catalogue is
        // authoritative. Before that, fall back to a single enabled inference
        // connection so a first activation is not blocked by an empty catalogue.
        let effective: { kind: string; enabled: boolean; status: string } | null;
        if (catalogueEnforced) {
          const [route] = await transaction
            .select(servingColumns)
            .from(modelDeployment)
            .innerJoin(serviceConnection, eq(serviceConnection.id, modelDeployment.connectionId))
            .where(
              and(
                eq(modelDeployment.workload, "CHAT"),
                eq(modelDeployment.status, "ACTIVE"),
                eq(modelDeployment.isDefault, true),
              ),
            )
            .limit(1);
          effective = route ?? null;
        } else {
          const legacy = await transaction
            .select(servingColumns)
            .from(serviceConnection)
            .where(and(eq(serviceConnection.kind, "INFERENCE"), eq(serviceConnection.enabled, true)))
            .limit(2);
          effective = legacy.length === 1 ? legacy[0]! : null;
        }

        if (!effective || effective.kind !== "INFERENCE" || !effective.enabled || effective.status !== "HEALTHY") {
          throw new GuardrailConflictError(
            "One effective inference server connection must be enabled and healthy before policy activation.",
          );
        }

        const [evaluation] = await transaction
          .select({ id: evaluationRun.id })
          .from(evaluationRun)
          .where(
            and(
              eq(evaluationRun.targetType, "POLICY"),
              eq(evaluationRun.targetReference, `policy:${current.slug}`),
              eq(evaluationRun.targetVersion, current.version),
              eq(evaluationRun.status, "PROMOTED"),
              arrayContains(evaluationRun.requiredCategories, ["SAFETY"]),
            ),
          )
          .orderBy(desc(evaluationRun.promotedAt))
          .limit(1);
        if (!evaluation) {
          throw new GuardrailConflictError(
            `Activation requires promoted safety evaluation evidence for policy:${current.slug} version ${current.version}.`,
          );
        }

        const activated = await transaction
          .update(guardrailPolicy)
          .set({
            status: "ACTIVE",
            activationEvaluationId: evaluation.id,
            firstActivatedAt: current.firstActivatedAt ?? new Date(),
            revision: increment(guardrailPolicy.revision),
            updatedBy: principal.id,
          })
          .where(
            and(
              eq(guardrailPolicy.id, id),
              eq(guardrailPolicy.revision, input.expectedRevision),
              eq(guardrailPolicy.status, current.status),
            ),
          )
          .returning();

        const saved = activated[0];
        if (!saved) {
          throw new GuardrailConflictError("The policy changed in another session. Refresh and try again.");
        }
        await transaction.insert(auditEvent).values({
          actorType: "USER",
          actorId: principal.id,
          action: "guardrail.policy_activated",
          resourceType: "GuardrailPolicy",
          resourceId: id,
          outcome: "SUCCESS",
          metadata: {
            reason: input.reason,
            evaluationRunId: evaluation.id,
            version: current.version,
            enforcementPlane: "ORCASYNAPSE",
          },
        });
        return dto(saved);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new GuardrailConflictError("Only one chat guardrail policy can be active.");
      }
      throw error;
    }
  }

  async suspend(principal: AdminPrincipal, id: string, input: ChangeGuardrailPolicyState): Promise<GuardrailPolicy> {
    return this.database.transaction(async (transaction) => {
      await transaction.execute(advisoryLock(`orcasynapse-guardrail:${id}`));
      const [current] = await transaction.select().from(guardrailPolicy).where(eq(guardrailPolicy.id, id));
      if (!current) throw new GuardrailNotFoundError();
      if (current.status !== "ACTIVE") throw new GuardrailConflictError("Only the active policy can be suspended.");

      const suspended = await transaction
        .update(guardrailPolicy)
        .set({ status: "SUSPENDED", revision: increment(guardrailPolicy.revision), updatedBy: principal.id })
        .where(
          and(
            eq(guardrailPolicy.id, id),
            eq(guardrailPolicy.revision, input.expectedRevision),
            eq(guardrailPolicy.status, "ACTIVE"),
          ),
        )
        .returning();

      const saved = suspended[0];
      if (!saved) {
        throw new GuardrailConflictError("The policy changed in another session. Refresh and try again.");
      }
      await transaction.insert(auditEvent).values({
        actorType: "USER",
        actorId: principal.id,
        action: "guardrail.policy_suspended",
        resourceType: "GuardrailPolicy",
        resourceId: id,
        outcome: "SUCCESS",
        metadata: { reason: input.reason, version: current.version },
      });
      return dto(saved);
    });
  }
}
