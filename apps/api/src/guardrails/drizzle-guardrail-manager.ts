import type {
  ChangeGuardrailPolicyState,
  CreateGuardrailPolicy,
  GuardrailPolicy,
  GuardrailPolicyList,
  GuardrailRule,
  UpdateGuardrailPolicy,
} from "@orcasynapse/contracts";
import { and, asc, desc, eq, isNotNull, ne, sql } from "drizzle-orm";
import {
  auditEvent,
  guardrailPolicy,
  modelDeployment,
  serviceConnection,
  type OrcaSynapseDatabase,
} from "@orcasynapse/database";
import type { AdminPrincipal } from "../auth/admin-session.js";
import { canonicalize } from "../canonical-json.js";
import { advisoryLock, increment, isUniqueViolation } from "../database-support.js";
import { assertPatternIsSafe } from "./rule-compiler.js";
import {
  GuardrailConflictError,
  GuardrailNotFoundError,
  type GuardrailManager,
} from "./guardrail-manager.js";

type StoredPolicy = typeof guardrailPolicy.$inferSelect;

/**
 * Refuses a rule list this deployment is not willing to evaluate.
 *
 * At save time, and only at save time. A pattern that reaches the database has
 * already been through this, so the inspection path can compile without paying
 * the probe budget on every message — and, more importantly, cannot be handed a
 * pattern that was never vetted. `GuardrailPatternError` carries which refusal
 * it was so the screen can say "nested quantifier" rather than "invalid".
 */
function assertRulesAreSafe(rules: readonly GuardrailRule[]): void {
  for (const rule of rules) {
    if (rule.type === "REGEX") assertPatternIsSafe(rule.pattern);
  }
}

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
    // Cast rather than re-parsed, the convention every jsonb column here
    // follows: the write path validated the shape and the column refuses
    // anything that is not an array.
    rules: policy.rules as GuardrailRule[],
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
    assertRulesAreSafe(input.rules);
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
    if (input.rules) assertRulesAreSafe(input.rules);
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
        || (changes.blockCredentialPatterns !== undefined && changes.blockCredentialPatterns !== current.blockCredentialPatterns)
        /*
         * Rules are enforceable settings, so a rule edit is as material as
         * changing the input ceiling and has to demand a new version the same
         * way. Leaving this out is the one omission that would make the model's
         * central promise false -- "the rules a run enforced are attributable
         * to a named version" -- for exactly the part an operator edits most.
         *
         * Compared through the canonical serialization the signed VM2 bodies
         * already use, so key order cannot make an unchanged list look edited.
         */
        || (changes.rules !== undefined && canonicalize(changes.rules) !== canonicalize(current.rules));
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
          ...(changes.rules === undefined ? {} : { rules: changes.rules }),
          status: materialChange ? "DRAFT" : current.status,
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

        const activated = await transaction
          .update(guardrailPolicy)
          .set({
            status: "ACTIVE",
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
