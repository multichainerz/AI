import { randomUUID } from "node:crypto";
import {
  agentProfile,
  auditEvent,
  chatConversation,
  chatSchedule,
  createTestDatabase,
  operationalIncident,
  productionReadinessApproval,
  productionReadinessApprovalRole,
  productionReadinessControl,
  type TestDatabase,
} from "@orcasynapse/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminPrincipal } from "../auth/admin-session.js";
import { DrizzleAiOpsManager } from "./drizzle-ai-ops-manager.js";
import { AiOpsConflictError, AiOpsNotFoundError } from "./ai-ops-manager.js";
import type { AiOpsDependencies } from "./drizzle-ai-ops-manager.js";

let context: TestDatabase;

beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); }, 120_000);
beforeEach(async () => { await context.reset(); });

const principal = { id: randomUUID(), subject: "local-admin:operator" } as AdminPrincipal;

/**
 * The sign-offs a deployment cannot go to production without, in the order the
 * blockers name them.
 *
 * Written out here rather than read back from the manager, because the two
 * readiness cases below used to derive their expectation from the very list
 * they were meant to pin: they counted the blockers the code produced and
 * compared that to `summary.requiredApprovals`, which *is*
 * `READINESS_APPROVAL_ROLES.length`, then looped over exactly the roles the
 * code had just named and approved each one. Both reduced to `n === n`.
 * Reducing the constant to `["SECURITY"]` -- deleting the infrastructure,
 * product and business sign-offs from the production go-live gate -- left the
 * whole API suite green.
 *
 * `READINESS_APPROVAL_ROLES` is module-private, so there is nothing to import;
 * an independent pin is a literal one, and that is the point. The database
 * enum below is a second, separately-authored copy of the same set, so a change
 * to either without the other is also caught.
 */
const GOVERNANCE_SIGN_OFFS = ["SECURITY", "INFRASTRUCTURE", "PRODUCT", "BUSINESS"] as const;

/** Every collaborator is a separate, already-converted manager. */
function dependencies(overrides: Partial<AiOpsDependencies> = {}): AiOpsDependencies {
  return {
    connections: { list: vi.fn(async () => []) },
    connectionMonitoring: { getControl: vi.fn(async () => null) },
    models: { list: vi.fn(async () => ({ items: [] })) },
    runtime: { snapshot: vi.fn(async () => ({ status: "ONLINE", statusReasons: [], capturedAt: new Date().toISOString() })) },
    chat: { metrics: vi.fn(async () => null) },
    agents: { metrics: vi.fn(async () => null) },
    tools: { metrics: vi.fn(async () => null) },
    ...overrides,
  } as unknown as AiOpsDependencies;
}

function manager(overrides: Partial<AiOpsDependencies> = {}) {
  return new DrizzleAiOpsManager(context.database, dependencies(overrides));
}

async function seedControl(key: string, overrides: Record<string, unknown> = {}) {
  const [control] = await context.database
    .insert(productionReadinessControl)
    .values({
      key, domain: "SECURITY", title: `Control ${key}`,
      description: "Prove the control holds.", status: "NOT_STARTED",
      ...overrides,
    })
    .returning();
  return control!;
}

describe("DrizzleAiOpsManager overview", () => {
  it("reports the control plane as healthy when every collaborator answers", async () => {
    const overview = await manager().overview();

    // Nothing is configured yet, so the required-service placeholders keep the
    // plane out of HEALTHY without raising an incident.
    expect(overview.status).toBe("DEGRADED");
    expect(overview.components.map(({ id }) => id)).toEqual(
      expect.arrayContaining(["postgresql", "hermes-run-reconciler", "service:inference", "service:hermes"]),
    );
    // The two *service* placeholders specifically. Counting every
    // NOT_CONFIGURED component coupled this to any unrelated component that is
    // legitimately unconfigured on a fresh deployment.
    expect(overview.components.filter(({ id, status }) => id.startsWith("service:") && status === "NOT_CONFIGURED")).toHaveLength(2);
    expect(overview.incidents).toMatchObject({ open: 0, critical: 0, items: [] });
  });

  it("opens an automated incident for a degraded component and resolves it when it recovers", async () => {
    const degraded = manager({
      runtime: { snapshot: vi.fn(async () => ({ status: "DEGRADED", statusReasons: ["Reconciler is behind."], capturedAt: new Date().toISOString() })) } as never,
    });

    const first = await degraded.overview();
    expect(first.status).toBe("DEGRADED");
    expect(first.incidents.open).toBe(1);
    expect(first.incidents.items[0]).toMatchObject({
      severity: "WARNING", component: "hermes-run-reconciler", automated: true,
    });

    // Re-running while still degraded refreshes the same row, never duplicates it.
    await degraded.overview();
    expect(await context.database.select().from(operationalIncident)).toHaveLength(1);

    const recovered = await manager().overview();
    expect(recovered.incidents.open).toBe(0);
    const [stored] = await context.database.select().from(operationalIncident);
    expect(stored).toMatchObject({ status: "RESOLVED", activeFingerprint: null });
  });

  it("raises a critical incident when a collaborator cannot be read", async () => {
    const broken = manager({
      runtime: { snapshot: vi.fn(async () => { throw new Error("unreachable"); }) } as never,
    });

    const overview = await broken.overview();

    expect(overview.status).toBe("CRITICAL");
    expect(overview.incidents.critical).toBe(1);
  });
});

describe("DrizzleAiOpsManager scheduled turns", () => {
  /*
   * The one failure in this product that is silent by construction: a schedule
   * that stops itself is legible on its own conversation and to nobody who does
   * not open it. These pin that it reaches the surface an operator reads.
   */
  async function seedSchedule(overrides: Record<string, unknown> = {}) {
    const [profile] = await context.database
      .insert(agentProfile)
      .values({ slug: `agent-${randomUUID().slice(0, 8)}`, status: "ACTIVE", currentVersion: 1, activeVersion: 1 })
      .returning({ id: agentProfile.id });
    const [conversation] = await context.database
      .insert(chatConversation)
      .values({
        ownerSubject: "local-admin:operator", title: "Morning report",
        modelAlias: "hermes-agent", profileId: profile!.id, profileName: "Support agent",
      })
      .returning({ id: chatConversation.id });
    await context.database.insert(chatSchedule).values({
      conversationId: conversation!.id,
      prompt: "Summarise overnight incidents.",
      intervalSeconds: 86_400,
      nextRunAt: new Date(),
      createdBySubject: "local-admin:operator",
      createdByMode: "ADMINISTRATOR_PREVIEW",
      ...overrides,
    });
  }

  function component(overview: Awaited<ReturnType<ReturnType<typeof manager>["overview"]>>) {
    return overview.components.find(({ id }) => id === "scheduled-turns")!;
  }

  it("says nothing is scheduled rather than claiming schedules are healthy", async () => {
    expect(component(await manager().overview())).toMatchObject({
      status: "NOT_CONFIGURED",
      summary: expect.stringContaining("No conversation is scheduled"),
    });
  });

  it("reports armed schedules as healthy", async () => {
    await seedSchedule();

    expect(component(await manager().overview())).toMatchObject({ status: "HEALTHY" });
  });

  it("degrades and opens an incident when a schedule stops itself", async () => {
    await seedSchedule({ enabled: false, lastOutcome: "DISABLED", lastDetail: "Blocked by rule." });

    const overview = await manager().overview();

    expect(component(overview)).toMatchObject({
      status: "DEGRADED",
      summary: expect.stringContaining("1 of 1 scheduled turn has stopped"),
    });
    expect(overview.incidents.items.some(({ component: id }) => id === "scheduled-turns")).toBe(true);
  });

  it("stays healthy for a schedule an operator paused on purpose", async () => {
    /*
     * `enabled = false` alone is not the signal. Raising an incident for a
     * deliberate pause would train an operator to ignore this component, which
     * costs more than the case it was meant to catch.
     */
    await seedSchedule({ enabled: false, lastOutcome: "OK" });

    const overview = await manager().overview();

    expect(component(overview)).toMatchObject({ status: "HEALTHY" });
    expect(overview.incidents.items.some(({ component: id }) => id === "scheduled-turns")).toBe(false);
  });

  it("counts the stopped ones against the total", async () => {
    await seedSchedule();
    await seedSchedule({ enabled: false, lastOutcome: "DISABLED", lastDetail: "Creator disabled." });

    expect(component(await manager().overview()).summary).toContain("1 of 2");
  });
});

describe("DrizzleAiOpsManager incidents", () => {
  it("records a manual incident and walks it through acknowledgement and resolution", async () => {
    const created = await manager().createIncident(principal, {
      title: "Inference latency spike", severity: "WARNING",
      component: "inference-server", summary: "p99 above target.",
    } as never);

    expect(created).toMatchObject({ status: "OPEN", automated: false });

    const acknowledged = await manager().acknowledgeIncident(principal, created.id, { note: "Investigating" } as never);
    expect(acknowledged).toMatchObject({ status: "ACKNOWLEDGED", owner: principal.subject });

    const resolved = await manager().resolveIncident(principal, created.id, { note: "Scaled up" } as never);
    expect(resolved).toMatchObject({ status: "RESOLVED", resolutionNote: "Scaled up" });

    const actions = (await context.database.select().from(auditEvent)).map(({ action }) => action);
    expect(actions).toEqual(expect.arrayContaining([
      "operations.incident_created", "operations.incident_acknowledged", "operations.incident_resolved",
    ]));
  });

  it("refuses a decision the incident is no longer eligible for", async () => {
    const created = await manager().createIncident(principal, {
      title: "x", severity: "WARNING", component: "c", summary: "s",
    } as never);
    await manager().resolveIncident(principal, created.id, { note: "done" } as never);

    await expect(manager().acknowledgeIncident(principal, created.id, { note: "late" } as never))
      .rejects.toBeInstanceOf(AiOpsConflictError);
    await expect(manager().resolveIncident(principal, randomUUID(), { note: "x" } as never))
      .rejects.toBeInstanceOf(AiOpsNotFoundError);
  });
});

describe("DrizzleAiOpsManager production readiness", () => {
  it("names every governance sign-off the deployment is missing", async () => {
    const readiness = await manager().productionReadiness();

    expect(readiness.status).toBe("NOT_READY");
    expect(readiness.summary).toMatchObject({
      totalControls: 0,
      verifiedControls: 0,
      approvedRoles: 0,
      requiredApprovals: GOVERNANCE_SIGN_OFFS.length,
    });
    // The whole list, spelled out and in order. Counting these against
    // `summary.requiredApprovals` compared the constant with itself.
    expect(readiness.blockers).toEqual(GOVERNANCE_SIGN_OFFS.map((role) => `${role} approval not recorded`));
  });

  it("requires the same four roles the schema enumerates", () => {
    // Two independently-authored copies of one governance decision: the
    // manager's required-approval list and the column type any approval has to
    // fit. A role added to one and not the other is either an approval that can
    // never be recorded or a sign-off that is never required.
    expect([...productionReadinessApprovalRole.enumValues].sort()).toEqual([...GOVERNANCE_SIGN_OFFS].sort());
  });

  it("guards a control update with its revision", async () => {
    const control = await seedControl("backup-restore");

    const updated = await manager().updateReadinessControl(principal, control.key, {
      status: "VERIFIED", owner: "Security", evidenceRefs: ["runbook-12"],
      note: "Restore rehearsed.", expectedRevision: control.revision,
    } as never);

    expect(updated).toMatchObject({ status: "VERIFIED", owner: "Security", revision: control.revision + 1 });
    expect(updated.verifiedAt).not.toBeNull();
    await expect(manager().updateReadinessControl(principal, control.key, {
      status: "BLOCKED", owner: "Security", evidenceRefs: [], note: "x", expectedRevision: control.revision,
    } as never)).rejects.toBeInstanceOf(AiOpsConflictError);
    await expect(manager().updateReadinessControl(principal, "not-a-control", {
      status: "VERIFIED", owner: "x", evidenceRefs: [], note: "x", expectedRevision: 0,
    } as never)).rejects.toBeInstanceOf(AiOpsNotFoundError);
  });

  it("refuses an approval until every control is verified or waived", async () => {
    const control = await seedControl("backup-restore");

    await expect(manager().recordReadinessApproval(principal, {
      role: "SECURITY", decision: "APPROVED", authority: "CISO", evidenceRef: "memo-1", reason: "Controls verified.",
    } as never)).rejects.toThrow(/verified or formally waived/);

    await manager().updateReadinessControl(principal, control.key, {
      status: "WAIVED", owner: "Security", evidenceRefs: ["risk-memo-1"], note: "Accepted risk.",
      expectedRevision: control.revision,
    } as never);

    await expect(manager().recordReadinessApproval(principal, {
      role: "SECURITY", decision: "APPROVED", authority: "CISO", evidenceRef: "memo-1", reason: "Controls verified.",
    } as never)).resolves.toMatchObject({ role: "SECURITY", decision: "APPROVED", isCurrent: true });
  });

  it("stales an approval once the evidence it was given against changes", async () => {
    const control = await seedControl("backup-restore");
    await manager().updateReadinessControl(principal, control.key, {
      status: "VERIFIED", owner: "Security", evidenceRefs: ["runbook-9"], note: "Done.",
      expectedRevision: control.revision,
    } as never);
    await manager().recordReadinessApproval(principal, {
      role: "SECURITY", decision: "APPROVED", authority: "CISO", evidenceRef: "memo-1", reason: "Controls verified.",
    } as never);
    expect((await manager().productionReadiness()).approvals[0]).toMatchObject({ isCurrent: true });

    // Re-verifying bumps the revision the approval captured.
    await manager().updateReadinessControl(principal, control.key, {
      status: "VERIFIED", owner: "Security", evidenceRefs: ["new-evidence"], note: "Re-verified.",
      expectedRevision: control.revision + 1,
    } as never);

    const readiness = await manager().productionReadiness();
    expect(readiness.approvals[0]).toMatchObject({ isCurrent: false });
    expect(readiness.blockers).toEqual(expect.arrayContaining([
      expect.stringContaining("stale after readiness evidence changed"),
    ]));
    expect(readiness.status).toBe("NOT_READY");
  });

  it("keeps only the newest decision per role", async () => {
    const control = await seedControl("backup-restore");
    await manager().updateReadinessControl(principal, control.key, {
      status: "VERIFIED", owner: "Security", evidenceRefs: ["runbook-9"], note: "Done.",
      expectedRevision: control.revision,
    } as never);
    await manager().recordReadinessApproval(principal, {
      role: "SECURITY", decision: "REJECTED", authority: "CISO", evidenceRef: "memo-1", reason: "Evidence incomplete.",
    } as never);
    await manager().recordReadinessApproval(principal, {
      role: "SECURITY", decision: "APPROVED", authority: "CISO", evidenceRef: "memo-2", reason: "Re-approved.",
    } as never);

    const readiness = await manager().productionReadiness();
    const security = readiness.approvals.filter(({ role }) => role === "SECURITY");
    expect(security).toHaveLength(1);
    expect(security[0]).toMatchObject({ decision: "APPROVED", evidenceRef: "memo-2" });
    // Both decisions remain on record even though only the newest counts.
    expect(await context.database.select().from(productionReadinessApproval)).toHaveLength(2);
  });

  it("reaches READY only when every control and every named role is satisfied", async () => {
    const control = await seedControl("backup-restore");
    await manager().updateReadinessControl(principal, control.key, {
      status: "VERIFIED", owner: "Security", evidenceRefs: ["runbook-9"], note: "Done.",
      expectedRevision: control.revision,
    } as never);

    const approve = (role: string) => manager().recordReadinessApproval(principal, {
      role, decision: "APPROVED", authority: "Authority", evidenceRef: `memo-${role}`, reason: "Signed off.",
    } as never);

    /*
     * Every sign-off but the last, so the case proves each one is load-bearing
     * rather than that the code agrees with itself. The old version read the
     * roles out of the blockers the manager had just produced and approved
     * exactly those, so a required-approval list cut from four roles to one
     * still ended READY with nothing to report.
     */
    const last = GOVERNANCE_SIGN_OFFS.at(-1)!;
    for (const role of GOVERNANCE_SIGN_OFFS.slice(0, -1)) await approve(role);

    const partial = await manager().productionReadiness();
    expect(partial.status).toBe("NOT_READY");
    expect(partial.blockers).toEqual([`${last} approval not recorded`]);
    expect(partial.summary).toMatchObject({
      requiredApprovals: GOVERNANCE_SIGN_OFFS.length,
      approvedRoles: GOVERNANCE_SIGN_OFFS.length - 1,
    });

    await approve(last);

    const readiness = await manager().productionReadiness();
    expect(readiness.status).toBe("READY");
    expect(readiness.blockers).toEqual([]);
    expect(readiness.summary).toMatchObject({
      requiredApprovals: GOVERNANCE_SIGN_OFFS.length,
      approvedRoles: GOVERNANCE_SIGN_OFFS.length,
    });
  });
});

