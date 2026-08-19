import { randomUUID } from "node:crypto";
import {
  agentProfile,
  agentProfileVersion,
  agentRun,
  agentRunEvent,
  auditEvent,
  createTestDatabase,
  division,
  type TestDatabase,
} from "@orcasynapse/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DrizzleUsageManager } from "./drizzle-usage-manager.js";

let context: TestDatabase;

beforeAll(async () => { context = await createTestDatabase(); }, 120_000);
afterAll(async () => { await context?.drop(); }, 120_000);
beforeEach(async () => { await context.reset(); });

function manager() {
  return new DrizzleUsageManager(context.database);
}

function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * 60_000);
}

async function seedDivision(displayName: string): Promise<string> {
  const [row] = await context.database.insert(division).values({
    slug: `div-${randomUUID().slice(0, 8)}`,
    displayName,
  }).returning({ id: division.id });
  return row!.id;
}

async function seedProfile(options: { slug?: string; divisionId?: string | null } = {}) {
  const [profile] = await context.database.insert(agentProfile).values({
    slug: options.slug ?? `profile-${randomUUID().slice(0, 8)}`,
    status: "ACTIVE",
    activeVersion: 1,
    ...(options.divisionId ? { divisionId: options.divisionId } : {}),
  }).returning({ id: agentProfile.id });
  const [version] = await context.database.insert(agentProfileVersion).values({
    profileId: profile!.id,
    version: 1,
    displayName: "Analyst v1",
    purpose: "Answer internal policy questions with approved evidence.",
    maxConcurrentRuns: 1,
    instructions: "Answer with approved evidence.",
    soulMd: "You are a careful internal analyst.",
    modelAlias: "hermes-agent",
    maxTurns: 1,
    timeoutSeconds: 60,
    safeMode: true,
  }).returning({ id: agentProfileVersion.id });
  return { profileId: profile!.id, versionId: version!.id };
}

interface RunSeed {
  profileId: string;
  versionId: string;
  status?: "COMPLETED" | "FAILED" | "CANCELLED" | "TIMED_OUT" | "DENIED";
  completedAt?: Date | null;
  startedAt?: Date | null;
  firstTokenAt?: Date | null;
  modelAlias?: string | null;
  ownerSubject?: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  costUsd?: string | null;
}

async function seedRun(seed: RunSeed): Promise<string> {
  const completedAt = seed.completedAt === undefined ? minutesAgo(30) : seed.completedAt;
  const startedAt = seed.startedAt === undefined
    ? (completedAt ? new Date(completedAt.getTime() - 2_000) : null)
    : seed.startedAt;
  const [run] = await context.database.insert(agentRun).values({
    profileId: seed.profileId,
    profileVersionId: seed.versionId,
    profileVersion: 1,
    ownerSubject: seed.ownerSubject ?? "user:pilot",
    requestedBy: randomUUID(),
    sessionId: randomUUID(),
    input: "Summarize the policy.",
    status: seed.status ?? "COMPLETED",
    outputCharacterLimit: 200_000,
    queuedAt: startedAt ?? minutesAgo(31),
    startedAt,
    completedAt,
    firstTokenAt: seed.firstTokenAt === undefined
      ? (startedAt ? new Date(startedAt.getTime() + 500) : null)
      : seed.firstTokenAt,
    modelAlias: seed.modelAlias === undefined ? "hermes-agent" : seed.modelAlias,
    inputTokens: seed.inputTokens === undefined ? 100 : seed.inputTokens,
    outputTokens: seed.outputTokens === undefined ? 200 : seed.outputTokens,
    totalTokens: seed.totalTokens === undefined ? 300 : seed.totalTokens,
  }).returning({ id: agentRun.id });

  if (seed.costUsd !== undefined && seed.costUsd !== null) {
    await context.database.insert(agentRunEvent).values({
      runId: run!.id,
      type: "RUN_COMPLETED",
      costUsd: seed.costUsd,
      occurredAt: completedAt ?? new Date(),
    });
  }
  return run!.id;
}

describe("DrizzleUsageManager", () => {
  it("sums only the runs that finished inside the window", async () => {
    const { profileId, versionId } = await seedProfile();
    await seedRun({ profileId, versionId });
    // Two days old: inside 7d and 30d, outside 24h.
    await seedRun({ profileId, versionId, completedAt: minutesAgo(60 * 48) });
    // Never finished, so it has no tokens to attribute and must not be counted
    // by any window -- the predicate is on completedAt for exactly this reason.
    await seedRun({ profileId, versionId, status: "COMPLETED", completedAt: null, startedAt: minutesAgo(5) });

    expect((await manager().report({ window: "24h", includeUsers: false })).totals.runs).toBe(1);
    expect((await manager().report({ window: "7d", includeUsers: false })).totals.runs).toBe(2);
    expect((await manager().report({ window: "30d", includeUsers: false })).totals.runs).toBe(2);
  });

  it("reports an unmeasured run as unreported rather than as zero", async () => {
    /*
     * The whole honesty rule, at the aggregate. `reportedUsage()` in the Hermes
     * client writes nulls when a provider returns no usage, and summing those
     * into a measured zero would tell an operator the window was free.
     */
    const { profileId, versionId } = await seedProfile();
    await seedRun({ profileId, versionId, inputTokens: 100, outputTokens: 200, totalTokens: 300 });
    await seedRun({ profileId, versionId, inputTokens: null, outputTokens: null, totalTokens: null });

    const { totals } = await manager().report({ window: "24h", includeUsers: false });

    expect(totals.runs).toBe(2);
    expect(totals.totalTokens).toBe(300);
    expect(totals.tokensReported).toBe(1);
    expect(totals.tokensUnreported).toBe(1);
  });

  it("returns a null cost when no route priced itself, and a sum when one did", async () => {
    const { profileId, versionId } = await seedProfile();
    await seedRun({ profileId, versionId });

    expect((await manager().report({ window: "24h", includeUsers: false })).totals.costUsd).toBeNull();

    await seedRun({ profileId, versionId, costUsd: "0.01500000" });
    const priced = await manager().report({ window: "24h", includeUsers: false });

    expect(priced.totals.costUsd).toBeCloseTo(0.015, 6);
    expect(priced.totals.costReportedRuns).toBe(1);
    expect(priced.totals.costUnreportedRuns).toBe(1);
  });

  it("counts a cancelled run without calling it a failure", async () => {
    const { profileId, versionId } = await seedProfile();
    await seedRun({ profileId, versionId, status: "COMPLETED" });
    await seedRun({ profileId, versionId, status: "CANCELLED" });
    await seedRun({ profileId, versionId, status: "FAILED" });
    await seedRun({ profileId, versionId, status: "TIMED_OUT" });
    await seedRun({ profileId, versionId, status: "DENIED" });

    const { totals } = await manager().report({ window: "24h", includeUsers: false });

    expect(totals.runs).toBe(5);
    expect(totals.cancelled).toBe(1);
    // Somebody pressed stop; the deployment did what it was told.
    expect(totals.failed).toBe(3);
    expect(totals.failureRate).toBeCloseTo(3 / 5, 6);
  });

  it("gives a deployment-wide run its own division row rather than a gap", async () => {
    /*
     * A null division is a scope, not the absence of one -- the same rule
     * `divisionMemory()` and `ScopedMemoryEntry` are both built on. Reading it
     * as "unfiltered" here would fold every division's usage into one row.
     */
    const divisionId = await seedDivision("Legal");
    const scoped = await seedProfile({ divisionId });
    const wide = await seedProfile();
    await seedRun({ profileId: scoped.profileId, versionId: scoped.versionId });
    await seedRun({ profileId: wide.profileId, versionId: wide.versionId });

    const { byDivision } = await manager().report({ window: "24h", includeUsers: false });

    expect(byDivision.rows).toHaveLength(2);
    expect(byDivision.rows.map(({ label }) => label).sort()).toEqual(["Deployment-wide", "Legal"]);
    expect(byDivision.rows.find(({ label }) => label === "Deployment-wide")?.key).toBeNull();
    expect(byDivision.rows.find(({ label }) => label === "Legal")?.key).toBe(divisionId);
  });

  it("breaks usage down by model, agent and person", async () => {
    const first = await seedProfile({ slug: "analyst" });
    const second = await seedProfile({ slug: "researcher" });
    await seedRun({ profileId: first.profileId, versionId: first.versionId, modelAlias: "fast", ownerSubject: "user:ana" });
    await seedRun({ profileId: second.profileId, versionId: second.versionId, modelAlias: "slow", ownerSubject: "user:ben" });
    await seedRun({ profileId: second.profileId, versionId: second.versionId, modelAlias: "slow", ownerSubject: "user:ben" });

    const report = await manager().report({ window: "24h", includeUsers: true });

    expect(report.byModel.rows.map(({ label, runs }) => [label, runs])).toEqual([["slow", 2], ["fast", 1]]);
    expect(report.byProfile.rows.map(({ label, runs }) => [label, runs])).toEqual([["researcher", 2], ["analyst", 1]]);
    expect(report.byUser?.rows.map(({ label, runs }) => [label, runs])).toEqual([["user:ben", 2], ["user:ana", 1]]);
  });

  it("omits the per-person breakdown entirely when the caller may not see it", async () => {
    const { profileId, versionId } = await seedProfile();
    await seedRun({ profileId, versionId });

    // Null rather than an empty breakdown: "you may not see this" and "nobody
    // used it" must not render the same.
    expect((await manager().report({ window: "24h", includeUsers: false })).byUser).toBeNull();
    expect((await manager().report({ window: "24h", includeUsers: true })).byUser).not.toBeNull();
  });

  it("folds everything past the twentieth row into one rather than dropping it", async () => {
    const { profileId, versionId } = await seedProfile();
    // Twenty-five distinct models, each with a token count that orders them
    // deterministically, so the cap lands where the assertion expects.
    for (let index = 0; index < 25; index += 1) {
      await seedRun({
        profileId,
        versionId,
        modelAlias: `model-${String(index).padStart(2, "0")}`,
        inputTokens: 1_000 - index,
        outputTokens: 0,
        totalTokens: 1_000 - index,
      });
    }

    const { byModel, totals } = await manager().report({ window: "24h", includeUsers: false });

    expect(byModel.rows).toHaveLength(20);
    expect(byModel.truncated).toBe(true);
    expect(byModel.other?.runs).toBe(5);
    // The remainder is summed, not discarded, so the table still reconciles
    // with the window's own total.
    const shown = byModel.rows.reduce((sum, row) => sum + row.totalTokens, 0);
    expect(shown + (byModel.other?.totalTokens ?? 0)).toBe(totals.totalTokens);
  });

  it("reports no remainder when everything fits", async () => {
    const { profileId, versionId } = await seedProfile();
    await seedRun({ profileId, versionId });

    const { byModel } = await manager().report({ window: "24h", includeUsers: false });

    expect(byModel.truncated).toBe(false);
    expect(byModel.other).toBeNull();
  });

  it("buckets the trend hourly for short windows and daily for the long one", async () => {
    const { profileId, versionId } = await seedProfile();
    await seedRun({ profileId, versionId, completedAt: minutesAgo(30) });
    await seedRun({ profileId, versionId, completedAt: minutesAgo(200) });

    const short = await manager().report({ window: "24h", includeUsers: false });
    expect(short.bucket).toBe("hour");
    /*
     * The whole window, quiet hours included. `GROUP BY` alone returned two
     * points here, and a chart drawn from those two showed a pair of
     * full-width bars with no time axis between them. A trailing 24 hours
     * touches 25 distinct UTC hours.
     */
    expect(short.series).toHaveLength(25);
    expect(short.series.reduce((sum, point) => sum + point.runs, 0)).toBe(2);
    expect(short.series.filter((point) => point.runs > 0)).toHaveLength(2);
    // A padded hour is a measured zero with nothing priced — not an invention
    // of cost or latency the runtime never reported.
    expect(short.series.find((point) => point.runs === 0)?.costUsd).toBeNull();
    // Every boundary is a real instant, truncated in UTC. A bare `timestamp`
    // would come back parsed as local time and shift the whole chart.
    for (const point of short.series) {
      expect(new Date(point.at).getTime()).not.toBeNaN();
      expect(new Date(point.at).getUTCMinutes()).toBe(0);
    }
    // And in order, one hour apart, so the axis is the axis.
    for (let index = 1; index < short.series.length; index += 1) {
      const step = new Date(short.series[index]!.at).getTime() - new Date(short.series[index - 1]!.at).getTime();
      expect(step).toBe(3_600_000);
    }

    const long = await manager().report({ window: "30d", includeUsers: false });
    expect(long.bucket).toBe("day");
    expect(long.series).toHaveLength(31);
    for (const point of long.series) {
      expect(new Date(point.at).getUTCHours()).toBe(0);
    }
  });

  it("counts accepted and refused gateway requests from the audit trail", async () => {
    const connectionId = randomUUID();
    const gatewayEvent = (action: string, metadata: Record<string, unknown>, occurredAt: Date) => ({
      actorType: "SERVICE" as const,
      actorId: connectionId,
      action,
      resourceType: "ServiceConnection",
      resourceId: connectionId,
      outcome: action.endsWith("rejected") ? "FAILURE" : "SUCCESS",
      metadata,
      occurredAt,
    });
    await context.database.insert(auditEvent).values([
      gatewayEvent("inference.gateway_requested", { modelAlias: "hermes-agent" }, minutesAgo(10)),
      gatewayEvent("inference.gateway_requested", { modelAlias: "hermes-agent" }, minutesAgo(20)),
      gatewayEvent("inference.gateway_rejected", { reason: "POLICY", violation: "CREDENTIAL_PATTERN" }, minutesAgo(15)),
      gatewayEvent("inference.gateway_rejected", { reason: "RATE_LIMIT" }, minutesAgo(16)),
      // Outside the 24h window, and an unrelated action inside it.
      gatewayEvent("inference.gateway_requested", { modelAlias: "hermes-agent" }, minutesAgo(60 * 48)),
      gatewayEvent("agent.run_completed", {}, minutesAgo(5)),
    ]);

    const { gateway } = await manager().report({ window: "24h", includeUsers: false });

    expect(gateway).toEqual({
      requests: 2,
      rejected: 2,
      rejectedByPolicy: 1,
      rejectedByRateLimit: 1,
    });
  });

  it("answers an empty deployment without inventing zeros for what was never measured", async () => {
    const report = await manager().report({ window: "24h", includeUsers: true });

    expect(report.totals.runs).toBe(0);
    expect(report.totals.failureRate).toBe(0);
    expect(report.totals.costUsd).toBeNull();
    expect(report.totals.averageLatencyMs).toBeNull();
    expect(report.totals.p95LatencyMs).toBeNull();
    expect(report.series).toEqual([]);
    expect(report.byModel).toEqual({ rows: [], truncated: false, other: null });
    expect(report.byUser).toEqual({ rows: [], truncated: false, other: null });
  });
});
