import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AIHubApiError,
  createAdministratorSession,
  getConnections,
  getConnectionMonitoring,
  getEnterpriseSession,
  getChatConversations,
  getToolRuntime,
  decideToolApproval,
  completeEvaluationRun,
  promoteEvaluationRun,
  recordProductionReadinessApproval,
  updateProductionReadinessControl,
  rollbackConfiguration,
  streamChatMessage,
  updateToolRuntime,
  updateConnectionMonitoring,
  getModelDeployments,
  changeModelDeploymentState,
  getGuardrailPolicies,
  changeGuardrailPolicyState,
  getPromptTemplates,
  changePromptTemplateState,
} from "./api.js";

afterEach(() => vi.restoreAllMocks());

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("AIHub browser API", () => {
  it("exchanges the bootstrap token without reusing it as an API header", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      id: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
      subject: "bootstrap-administrator",
      role: "PLATFORM_ADMIN",
      scopes: ["connections:read"],
      createdAt: "2026-07-30T00:00:00.000Z",
      idleExpiresAt: "2026-07-30T00:15:00.000Z",
      absoluteExpiresAt: "2026-07-30T08:00:00.000Z",
    }, 201));

    await createAdministratorSession("a-secure-bootstrap-token-with-more-than-32-characters");

    const [, options] = fetchMock.mock.calls[0]!;
    expect(options).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(new Headers(options?.headers).has("x-aihub-bootstrap-token")).toBe(false);
    expect(JSON.parse(String(options?.body))).toEqual({
      token: "a-secure-bootstrap-token-with-more-than-32-characters",
    });
  });

  it("uses the server session cookie for subsequent administration requests", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ items: [] }),
    );

    await getConnections();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/admin/connections",
      { credentials: "same-origin" },
    );
  });

  it("reads and updates the dashboard-owned connection monitoring control", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({
        enabled: false,
        intervalSeconds: 300,
        reason: "Acceptance pending",
        updatedAt: "2026-07-30T00:00:00.000Z",
        updatedBy: null,
      }))
      .mockResolvedValueOnce(jsonResponse({
        enabled: true,
        intervalSeconds: 300,
        reason: "Pilot monitoring approved",
        updatedAt: "2026-07-30T00:01:00.000Z",
        updatedBy: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
      }));

    await getConnectionMonitoring();
    await updateConnectionMonitoring({
      enabled: true,
      intervalSeconds: 300,
      reason: "Pilot monitoring approved",
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/admin/connections/monitoring");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "PATCH", credentials: "same-origin" });
  });

  it("reads model routes and sends an evidence-bound activation decision", async () => {
    const model = {
      id: "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d",
      slug: "laguna-hermes",
      displayName: "Laguna Hermes",
      modelAlias: "hermes-agent",
      workload: "AGENT",
      status: "ACTIVE",
      connection: { id: "5277951c-7d22-4cec-8d46-fad3afba37dd", displayName: "LiteLLM Primary", kind: "LITELLM", environment: "PRODUCTION", enabled: true, status: "HEALTHY" },
      version: "2.1-nvfp4",
      license: null,
      contextWindowTokens: 131072,
      maxOutputTokens: 8192,
      maxConcurrentRequests: 2,
      isDefault: true,
      activationEvaluationId: "de44bc5d-0355-4c3f-872e-1af99f356d19",
      firstActivatedAt: "2026-07-30T00:00:00.000Z",
      revision: 2,
      createdBy: null,
      updatedBy: null,
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ items: [model] }))
      .mockResolvedValueOnce(jsonResponse(model));

    await getModelDeployments();
    await changeModelDeploymentState(model.id, "activate", {
      expectedRevision: 1,
      reason: "Promoted pilot evidence",
      makeDefault: true,
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/admin/models");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({ makeDefault: true, expectedRevision: 1 });
  });

  it("reads policies and sends an evidence-bound guardrail activation", async () => {
    const policy = {
      id: "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d",
      slug: "chat-safety",
      displayName: "Chat safety",
      description: "Approved chat safety controls.",
      version: "1.0.0",
      status: "ACTIVE",
      liteLLMGuardrails: ["presidio-pii"],
      maxInputCharacters: 12000,
      activationEvaluationId: "de44bc5d-0355-4c3f-872e-1af99f356d19",
      firstActivatedAt: "2026-07-30T00:00:00.000Z",
      revision: 2,
      createdBy: null,
      updatedBy: null,
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ items: [policy] }))
      .mockResolvedValueOnce(jsonResponse(policy));

    await getGuardrailPolicies();
    await changeGuardrailPolicyState(policy.id, "activate", { expectedRevision: 1, reason: "Promoted safety evidence" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/admin/guardrails");
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/v1/admin/guardrails/${policy.id}/activate`);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ expectedRevision: 1, reason: "Promoted safety evidence" });
  });

  it("reads prompts and sends an evidence-bound prompt activation", async () => {
    const prompt = {
      id: "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d",
      slug: "mpm-chat-system",
      displayName: "MPM chat system",
      description: "Approved employee chat behavior.",
      purpose: "CHAT_SYSTEM",
      version: "1.0.0",
      status: "ACTIVE",
      content: "You are the approved MPM assistant. State uncertainty and protect private data.",
      contentChecksum: "a".repeat(64),
      activationEvaluationId: "de44bc5d-0355-4c3f-872e-1af99f356d19",
      firstActivatedAt: "2026-07-30T00:00:00.000Z",
      revision: 2,
      createdBy: null,
      updatedBy: null,
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ items: [prompt] }))
      .mockResolvedValueOnce(jsonResponse(prompt));

    await getPromptTemplates();
    await changePromptTemplateState(prompt.id, "activate", { expectedRevision: 1, reason: "Promoted prompt evidence" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/admin/prompts");
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/v1/admin/prompts/${prompt.id}/activate`);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ expectedRevision: 1, reason: "Promoted prompt evidence" });
  });

  it("restores the opaque enterprise session without exposing an OIDC token", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      id: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
      identityMode: "ENTERPRISE",
      user: {
        id: "fb8c1e58-10d6-4ac7-aafe-e259763a6f63",
        displayName: "Pilot User",
        email: "pilot@mpm.example",
      },
      scopes: ["chat:use", "documents:use", "agents:use"],
      createdAt: "2026-07-30T00:00:00.000Z",
      idleExpiresAt: "2026-07-30T08:00:00.000Z",
      absoluteExpiresAt: "2026-07-30T12:00:00.000Z",
    }));

    await getEnterpriseSession();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/session",
      { credentials: "same-origin" },
    );
  });

  it("uses the shared identity-protected Chat route", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ items: [] }));
    await getChatConversations();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/chat/conversations",
      { credentials: "same-origin" },
    );
  });

  it("sends the optimistic active-revision guard when restoring configuration", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      connection: {
        id: "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d",
        slug: "litellm-primary",
        displayName: "LiteLLM Primary",
        kind: "LITELLM",
        environment: "PRODUCTION",
        baseUrl: "https://litellm.mpm.internal",
        enabled: true,
        status: "NOT_TESTED",
        configuration: {},
        activeRevision: 3,
        secretFieldNames: ["apiKey"],
        lastHealthcheckAt: null,
        lastHealthcheckMessage: null,
        updatedAt: "2026-07-30T00:00:00.000Z",
      },
      rolledBackFromRevision: 2,
      targetRevision: 1,
      createdRevision: 3,
      preservedSecretFields: ["apiKey"],
      message: "Configuration restored; active credentials were preserved.",
    }));

    await rollbackConfiguration("8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d", 1, 2);

    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/revisions/1/rollback");
    expect(options).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(JSON.parse(String(options?.body))).toEqual({ expectedActiveRevision: 2 });
  });

  it("turns a non-JSON gateway failure into an actionable API error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("upstream unavailable", { status: 502, statusText: "Bad Gateway" }),
    );

    await expect(getConnections()).rejects.toEqual(
      expect.objectContaining<Partial<AIHubApiError>>({
        name: "AIHubApiError",
        status: 502,
        message: "AIHub API returned 502 Bad Gateway",
      }),
    );
  });

  it("parses typed chat events from a split SSE stream", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: started\ndata: {"type":"started","conversationId":"8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d",'));
        controller.enqueue(encoder.encode('"messageId":"6cf6ce1b-a8c6-49d7-b6aa-019d35888acb"}\n\nevent: delta\ndata: {"type":"delta","conversationId":"8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d","messageId":"6cf6ce1b-a8c6-49d7-b6aa-019d35888acb","delta":"Hi"}\n\n'));
        controller.close();
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));
    const events: string[] = [];

    await streamChatMessage(
      "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d",
      "Hello",
      (event) => events.push(event.type),
      new AbortController().signal,
    );

    expect(events).toEqual(["started", "delta"]);
  });

  it("reads and updates the governed-tool kill switch through the scoped admin API", async () => {
    const runtime = {
      enabled: false,
      reason: "Live Hermes propagation is not enabled yet.",
      approvalTtlMinutes: 30,
      updatedAt: "2026-07-30T00:00:00.000Z",
      updatedBy: null,
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(runtime))
      .mockResolvedValueOnce(jsonResponse({ ...runtime, approvalTtlMinutes: 45 }));

    await getToolRuntime();
    await updateToolRuntime({
      enabled: false,
      reason: "Keep the boundary closed during interoperability testing.",
      approvalTtlMinutes: 45,
    });

    expect(fetchMock.mock.calls[0]).toEqual([
      "/api/v1/admin/tooling/runtime",
      { credentials: "same-origin" },
    ]);
    const [url, options] = fetchMock.mock.calls[1]!;
    expect(url).toBe("/api/v1/admin/tooling/runtime");
    expect(options).toMatchObject({ method: "PATCH", credentials: "same-origin" });
    expect(JSON.parse(String(options?.body))).toEqual({
      enabled: false,
      reason: "Keep the boundary closed during interoperability testing.",
      approvalTtlMinutes: 45,
    });
  });

  it("sends an explicit approval decision and operator reason", async () => {
    const approvalId = "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb";
    const callId = "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d";
    const runId = "fb8c1e58-10d6-4ac7-aafe-e259763a6f63";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      id: approvalId,
      callId,
      runId,
      profileSlug: "hermes-ops",
      toolSlug: "document_memory_resync",
      toolName: "Document memory resync",
      requestedBySubject: "pilot@mpm.example",
      arguments: { documentId: "b78784ba-9156-4d42-8066-18f30217d42d" },
      status: "REJECTED",
      expiresAt: "2026-07-30T00:30:00.000Z",
      decisionReason: "The source document is still under review.",
      decisionBy: approvalId,
      decidedAt: "2026-07-30T00:10:00.000Z",
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:10:00.000Z",
    }));

    await decideToolApproval(approvalId, "REJECT", "The source document is still under review.");

    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`/api/v1/admin/tooling/approvals/${approvalId}/decision`);
    expect(options).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(JSON.parse(String(options?.body))).toEqual({
      decision: "REJECT",
      reason: "The source document is still under review.",
    });
  });

  it("submits category evidence to the immutable completion endpoint", async () => {
    const evaluationId = "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d";
    const result = {
      category: "SAFETY" as const,
      totalCases: 20,
      passedCases: 20,
      criticalFailures: 0,
      evidenceRefs: ["evaluations/hermes-v3/safety.json"],
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      id: evaluationId,
      name: "Hermes v3",
      targetType: "AGENT",
      targetReference: "agent:hermes-analyst",
      targetVersion: "3",
      status: "PASSED",
      minimumPassRate: 0.95,
      requiredCategories: ["SAFETY"],
      results: [{ ...result, passRate: 1, status: "PASSED" }],
      totalCases: 20,
      passedCases: 20,
      criticalFailures: 0,
      passRate: 1,
      createdAt: "2026-07-30T00:00:00.000Z",
      completedAt: "2026-07-30T00:10:00.000Z",
      promotedAt: null,
      promotionReason: null,
    }));

    await completeEvaluationRun(evaluationId, { results: [result] });

    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`/api/v1/admin/operations/evaluations/${evaluationId}/complete`);
    expect(options).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(JSON.parse(String(options?.body))).toEqual({ results: [result] });
  });

  it("submits the operator rationale to the separate promotion endpoint", async () => {
    const evaluationId = "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d";
    const reason = "Approved for the controlled MPM pilot.";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      id: evaluationId,
      name: "Hermes v3",
      targetType: "AGENT",
      targetReference: "agent:hermes-analyst",
      targetVersion: "3",
      status: "PROMOTED",
      minimumPassRate: 0.95,
      requiredCategories: ["SAFETY"],
      results: [{ category: "SAFETY", totalCases: 20, passedCases: 20, criticalFailures: 0, evidenceRefs: ["evaluations/hermes-v3/safety.json"], passRate: 1, status: "PASSED" }],
      totalCases: 20,
      passedCases: 20,
      criticalFailures: 0,
      passRate: 1,
      createdAt: "2026-07-30T00:00:00.000Z",
      completedAt: "2026-07-30T00:10:00.000Z",
      promotedAt: "2026-07-30T00:12:00.000Z",
      promotionReason: reason,
    }));

    await promoteEvaluationRun(evaluationId, reason);

    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`/api/v1/admin/operations/evaluations/${evaluationId}/promote`);
    expect(options).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(JSON.parse(String(options?.body))).toEqual({ reason });
  });

  it("sends concurrency-safe readiness evidence and external approval records", async () => {
    const control = {
      key: "security-threat-model",
      title: "Threat model and security review",
      domain: "SECURITY",
      description: "MPM Security reviews the intended pilot scope.",
      status: "VERIFIED",
      owner: "MPM Security",
      evidenceRefs: ["evidence/security-review.pdf"],
      note: "Review completed.",
      lastUpdatedBy: "security-admin",
      verifiedAt: "2026-07-30T00:10:00.000Z",
      revision: 2,
      updatedAt: "2026-07-30T00:10:00.000Z",
    };
    const approval = {
      id: "c43149d0-a76d-43ee-932e-7a4d527673e8",
      role: "SECURITY",
      decision: "APPROVED",
      authority: "MPM Security Review Board",
      evidenceRef: "approval/security/2026-07-30",
      reason: "Approved for the bounded pilot scope.",
      recordedBy: "platform-admin",
      recordedAt: "2026-07-30T00:12:00.000Z",
      isCurrent: true,
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(control))
      .mockResolvedValueOnce(jsonResponse(approval, 201));
    const decision = {
      status: "VERIFIED" as const,
      owner: "MPM Security",
      evidenceRefs: ["evidence/security-review.pdf"],
      note: "Review completed.",
      expectedRevision: 1,
    };

    await updateProductionReadinessControl(control.key, decision);
    await recordProductionReadinessApproval({
      role: "SECURITY",
      decision: "APPROVED",
      authority: approval.authority,
      evidenceRef: approval.evidenceRef,
      reason: approval.reason,
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/api/v1/admin/operations/readiness/controls/${control.key}`);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual(decision);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/v1/admin/operations/readiness/approvals");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({ authority: approval.authority, decision: "APPROVED" });
  });
});
