import { hermesNodeHeartbeatSchema, hermesRuntimeNodeSchema } from "@orcasynapse/contracts";
import { describe, expect, it } from "vitest";

/*
 * The compatibility boundary for reporting a node's systemd units.
 *
 * `hermesNodeHeartbeatSchema` is `.strict()`, which is what makes the field's
 * optionality load-bearing rather than a style choice: a node sending `units` to
 * a control plane that does not know the key is refused on every beat, goes
 * stale, and is marked OFFLINE. That is why the field is accepted a release
 * before any node is taught to send it, and these cases pin both halves.
 */

const UNIT = { name: "orcasynapse-hermes-corpus.timer", active: true, enabled: true };

const heartbeat = (over: Record<string, unknown> = {}) => ({
  observedAt: "2026-08-15T20:00:00.000Z",
  status: "ONLINE",
  hermesVersion: "c015663b215c0e14de4295346b0727db602cbb1d",
  capabilities: ["gateway-api"],
  ...over,
});

describe("a heartbeat carrying systemd unit state", () => {
  it("accepts a node that reports no units at all", () => {
    const parsed = hermesNodeHeartbeatSchema.safeParse(heartbeat());

    expect(parsed.success).toBe(true);
    // Absent, not defaulted to []. An empty array would claim the node has no
    // units, which is a different statement from having never said.
    expect(parsed.success && parsed.data.units).toBeUndefined();
  });

  it("accepts a node that reports them", () => {
    const parsed = hermesNodeHeartbeatSchema.safeParse(heartbeat({ units: [UNIT] }));

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.units).toEqual([UNIT]);
  });

  it("refuses a unit missing either of the two questions it answers", () => {
    // `active` and `enabled` need different remedies, so neither may be
    // inferred from the other's absence.
    expect(hermesNodeHeartbeatSchema.safeParse(
      heartbeat({ units: [{ name: "a.timer", active: true }] }),
    ).success).toBe(false);
    expect(hermesNodeHeartbeatSchema.safeParse(
      heartbeat({ units: [{ name: "a.timer", enabled: true }] }),
    ).success).toBe(false);
  });

  it("refuses an unbounded list", () => {
    const many = Array.from({ length: 17 }, (_, index) => ({ ...UNIT, name: `u${index}.timer` }));

    expect(hermesNodeHeartbeatSchema.safeParse(heartbeat({ units: many })).success).toBe(false);
  });

  /*
   * The rule this whole two-release split exists for. If the schema ever stops
   * being strict, the ordering requirement quietly disappears and so does the
   * reason to keep the client change in a later release -- so the strictness is
   * asserted directly rather than assumed from the field being optional.
   */
  it("still refuses a key it does not know, which is why VM1 must be upgraded first", () => {
    expect(hermesNodeHeartbeatSchema.safeParse(heartbeat({ somethingNewer: true })).success).toBe(false);
  });
});

describe("a node summary carrying systemd unit state", () => {
  const node = {
    id: "6b1f0a2c-3d4e-4f5a-8b6c-7d8e9f0a1b2c",
    slug: "vm2",
    displayName: "Agentic System",
    baseUrl: "http://127.0.0.1:8642",
    expectedHostname: null,
    hostname: null,
    status: "ONLINE",
    identityFingerprint: null,
    hermesVersion: null,
    expectedHermesCommit: null,
    installerVersion: null,
    capabilities: [],
    units: null,
    serviceConnectionId: null,
    serviceConnectionStatus: null,
    lastSeenAt: null,
    enrolledAt: null,
    revokedAt: null,
    revision: 0,
    createdAt: "2026-08-15T20:00:00.000Z",
    updatedAt: "2026-08-15T20:00:00.000Z",
  };

  it("requires the field to be present, so a summary cannot silently omit it", () => {
    const { units, ...withoutUnits } = node;

    expect(hermesRuntimeNodeSchema.safeParse(node).success).toBe(true);
    expect(hermesRuntimeNodeSchema.safeParse(withoutUnits).success).toBe(false);
  });

  it("distinguishes never reported from reported and empty", () => {
    // Nullable rather than optional on the way out: the dashboard renders these
    // two differently, so the contract has to be able to say both.
    expect(hermesRuntimeNodeSchema.safeParse({ ...node, units: null }).success).toBe(true);
    expect(hermesRuntimeNodeSchema.safeParse({ ...node, units: [] }).success).toBe(true);
  });
});
