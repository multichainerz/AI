import { describe, expect, it } from "vitest";
import {
  operationalIncidentSchema,
  recordProductionReadinessApprovalSchema,
  updateProductionReadinessControlSchema,
} from "./ai-ops.js";

describe("AI operations contracts", () => {
  it("keeps incident lifecycle timestamps explicit", () => {
    const parsed = operationalIncidentSchema.safeParse({
      id: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
      title: "vLLM unavailable",
      severity: "CRITICAL",
      status: "OPEN",
      component: "connection:vllm",
      summary: "The last credential-aware check could not reach vLLM.",
      owner: null,
      automated: true,
      detectedAt: "2026-07-30T00:00:00.000Z",
      lastObservedAt: "2026-07-30T00:01:00.000Z",
      acknowledgedAt: null,
      resolvedAt: null,
      resolutionNote: null,
    });
    expect(parsed.success).toBe(true);
  });

  it("requires retained evidence and ownership before a readiness control is accepted", () => {
    const base = { owner: "OrcaSynapse Security", evidenceRefs: ["evidence/security-review.pdf"], note: "Review completed.", expectedRevision: 2 };
    expect(updateProductionReadinessControlSchema.safeParse({ ...base, status: "VERIFIED" }).success).toBe(true);
    expect(updateProductionReadinessControlSchema.safeParse({ ...base, status: "VERIFIED", evidenceRefs: [] }).success).toBe(false);
    expect(updateProductionReadinessControlSchema.safeParse({ ...base, status: "IN_PROGRESS", owner: null, note: null }).success).toBe(false);
  });

  it("distinguishes the external approving authority from the OrcaSynapse recorder", () => {
    expect(recordProductionReadinessApprovalSchema.safeParse({
      role: "SECURITY",
      decision: "APPROVED",
      authority: "OrcaSynapse Security Review Board",
      evidenceRef: "approvals/security/2026-07-30",
      reason: "Approved for the bounded pilot scope.",
    }).success).toBe(true);
    expect(recordProductionReadinessApprovalSchema.safeParse({
      role: "SECURITY",
      decision: "APPROVED",
      authority: "",
      evidenceRef: "",
      reason: "ok",
    }).success).toBe(false);
  });
});
