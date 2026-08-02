import { describe, expect, it } from "vitest";
import {
  decideToolApprovalSchema,
  issuedGatewayCredentialSchema,
  toolMetricsSchema,
  upsertToolGrantSchema,
  updateToolRuntimeControlSchema,
} from "./tooling.js";

describe("governed tooling contracts", () => {
  it("keeps grants default-deny without an exact group or administrator role", () => {
    const base = {
      profileVersionId: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
      toolId: "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d",
      enabled: true,
      resourceScope: "OWNER_ONLY",
    } as const;
    expect(upsertToolGrantSchema.safeParse(base).success).toBe(false);
    expect(upsertToolGrantSchema.safeParse({ ...base, allowedGroups: ["OrcaSynapse-AI-Pilot"] }).success).toBe(true);
  });

  it("requires explicit review reasons and bounded runtime settings", () => {
    expect(decideToolApprovalSchema.safeParse({ decision: "APPROVE", reason: "Reviewed against the request." }).success).toBe(true);
    expect(decideToolApprovalSchema.safeParse({ decision: "REJECT", reason: "x" }).success).toBe(false);
    expect(updateToolRuntimeControlSchema.safeParse({ enabled: true, reason: "Pilot approved", approvalTtlMinutes: 15 }).success).toBe(true);
  });

  it("accepts only one-time gateway token format", () => {
    const base = {
      id: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb", name: "Hermes gateway",
      tokenPrefix: "orcasynapse_mcp_abcd", enabled: true, lastUsedAt: null, revokedAt: null,
      createdAt: "2026-07-30T00:00:00.000Z",
    };
    expect(issuedGatewayCredentialSchema.safeParse({ ...base, token: `orcasynapse_mcp_${"a".repeat(43)}` }).success).toBe(true);
    expect(issuedGatewayCredentialSchema.safeParse({ ...base, token: "secret" }).success).toBe(false);
  });

  it("keeps durable action-dispatch health visible in tooling metrics", () => {
    expect(toolMetricsSchema.parse({
      generatedAt: "2026-07-30T00:00:00.000Z",
      activeTools: 2,
      activeGrants: 1,
      pendingApprovals: 1,
      executingCalls: 1,
      openActionDispatches: 1,
      failedActionDispatches: 0,
      completedCalls: 3,
      deniedCalls: 2,
      failedCalls: 0,
    })).toMatchObject({ openActionDispatches: 1, failedActionDispatches: 0 });
  });
});
