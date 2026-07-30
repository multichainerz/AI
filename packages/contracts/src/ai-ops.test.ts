import { describe, expect, it } from "vitest";
import {
  completeEvaluationRunSchema,
  createEvaluationRunSchema,
  operationalIncidentSchema,
  promoteEvaluationRunSchema,
  recordProductionReadinessApprovalSchema,
  updateProductionReadinessControlSchema,
} from "./ai-ops.js";

describe("AI operations contracts", () => {
  it("requires unique, explicit evaluation categories", () => {
    const base = {
      name: "Laguna release evidence",
      targetType: "MODEL",
      targetReference: "laguna-s",
      targetVersion: "2.1-nfvp4",
      minimumPassRate: 0.95,
    };
    expect(createEvaluationRunSchema.safeParse({ ...base, requiredCategories: ["CHAT", "SAFETY"] }).success).toBe(true);
    expect(createEvaluationRunSchema.safeParse({ ...base, requiredCategories: ["CHAT", "CHAT"] }).success).toBe(false);
  });

  it("rejects impossible or duplicate evaluation result counts", () => {
    const result = { category: "CHAT", totalCases: 10, passedCases: 11, criticalFailures: 0, evidenceRefs: ["evidence://evals/chat-1"] };
    expect(completeEvaluationRunSchema.safeParse({ results: [result] }).success).toBe(false);
    expect(completeEvaluationRunSchema.safeParse({ results: [
      { ...result, passedCases: 9 },
      { ...result, passedCases: 8 },
    ] }).success).toBe(false);
  });

  it("requires a meaningful promotion rationale", () => {
    expect(promoteEvaluationRunSchema.safeParse({ reason: "Approved for the controlled pilot." }).success).toBe(true);
    expect(promoteEvaluationRunSchema.safeParse({ reason: "  " }).success).toBe(false);
    expect(promoteEvaluationRunSchema.parse({ reason: "  Evidence reviewed.  " }).reason).toBe("Evidence reviewed.");
  });

  it("keeps incident lifecycle timestamps explicit", () => {
    const parsed = operationalIncidentSchema.safeParse({
      id: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
      title: "OCR unavailable",
      severity: "CRITICAL",
      status: "OPEN",
      component: "connection:ocr",
      summary: "The last credential-aware check could not reach OCR.",
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
    const base = { owner: "MPM Security", evidenceRefs: ["evidence/security-review.pdf"], note: "Review completed.", expectedRevision: 2 };
    expect(updateProductionReadinessControlSchema.safeParse({ ...base, status: "VERIFIED" }).success).toBe(true);
    expect(updateProductionReadinessControlSchema.safeParse({ ...base, status: "VERIFIED", evidenceRefs: [] }).success).toBe(false);
    expect(updateProductionReadinessControlSchema.safeParse({ ...base, status: "IN_PROGRESS", owner: null, note: null }).success).toBe(false);
  });

  it("distinguishes the external approving authority from the AIHub recorder", () => {
    expect(recordProductionReadinessApprovalSchema.safeParse({
      role: "SECURITY",
      decision: "APPROVED",
      authority: "MPM Security Review Board",
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
