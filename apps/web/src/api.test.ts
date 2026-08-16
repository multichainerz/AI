import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OrcaSynapseApiError,
  changeLocalAdministratorPassword,
  changeLocalPersonPassword,
  createInstallationKeyRecoverySession,
  createLocalAdministratorSession,
  createLocalPersonSession,
  recoverLocalAdministrator,
  approveReleaseTarget,
  clearReleaseTarget,
  getPlatformUpdate,
  getConnections,
  getConnectionMonitoring,
  getEnterpriseSession,
  getChatConversations,
  cancelChatRun,
  getToolRuntime,
  recordProductionReadinessApproval,
  updateProductionReadinessControl,
  rollbackConfiguration,
  streamChatEvents,
  updateToolRuntime,
  updateConnectionMonitoring,
  getModelDeployments,
  changeModelDeploymentState,
  getGuardrailPolicies,
  changeGuardrailPolicyState,
  getPromptTemplates,
  changePromptTemplateState,
  testConnection,
  discoverInferenceServer,
} from "./api.js";

afterEach(() => vi.restoreAllMocks());

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("OrcaSynapse browser API", () => {
  it("uses local credentials for routine administrator login", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      id: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
      subject: "local-admin:6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
      role: "PLATFORM_ADMIN",
      scopes: ["connections:read"],
      createdAt: "2026-07-30T00:00:00.000Z",
      idleExpiresAt: "2026-07-30T00:15:00.000Z",
      absoluteExpiresAt: "2026-07-30T08:00:00.000Z",
      authenticationMethod: "LOCAL_PASSWORD",
      passwordChangeRequired: false,
    }, 201));

    await createLocalAdministratorSession("admin", "temporary-password");

    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/v1/admin/session/local");
    expect(options).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(new Headers(options?.headers).has("x-orcasynapse-installation-key")).toBe(false);
    expect(JSON.parse(String(options?.body))).toEqual({ username: "admin", password: "temporary-password" });
  });

  it("signs a locally created person in through the enterprise session cookie", async () => {
    const session = {
      id: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
      identityMode: "ENTERPRISE" as const,
      user: {
        id: "fb8c1e58-10d6-4ac7-aafe-e259763a6f63",
        displayName: "Ayu Rahman",
        email: "ayu@orcasynapse.example",
      },
      scopes: ["chat:use", "agents:use"] as ["chat:use", "agents:use"],
      createdAt: "2026-07-30T00:00:00.000Z",
      idleExpiresAt: "2026-07-30T08:00:00.000Z",
      absoluteExpiresAt: "2026-07-30T12:00:00.000Z",
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ displayName: "Ayu Rahman" }))
      .mockResolvedValueOnce(jsonResponse(session));

    await expect(createLocalPersonSession("ayu", "a-long-enough-password")).resolves.toEqual(session);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/auth/local/login",
      "/api/v1/session",
    ]);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      username: "ayu",
      password: "a-long-enough-password",
    });
  });

  it("replaces a locally created person's temporary password through the enterprise session", async () => {
    const session = {
      id: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
      identityMode: "ENTERPRISE" as const,
      user: {
        id: "fb8c1e58-10d6-4ac7-aafe-e259763a6f63",
        displayName: "Ayu Rahman",
        email: "ayu@orcasynapse.example",
      },
      scopes: ["chat:use", "agents:use"] as ["chat:use", "agents:use"],
      createdAt: "2026-07-30T00:00:00.000Z",
      idleExpiresAt: "2026-07-30T08:00:00.000Z",
      absoluteExpiresAt: "2026-07-30T12:00:00.000Z",
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(session));

    await expect(changeLocalPersonPassword("temporary-password", "a-much-stronger-password"))
      .resolves.toEqual(session);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/auth/local/password",
      expect.objectContaining({ method: "PUT", credentials: "same-origin" }),
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      currentPassword: "temporary-password",
      newPassword: "a-much-stronger-password",
    });
  });

  it("keeps Installation Key use and password maintenance on recovery-specific endpoints", async () => {
    const session = {
      id: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
      subject: "installation-key-administrator",
      role: "PLATFORM_ADMIN",
      scopes: ["sessions:manage"],
      createdAt: "2026-07-30T00:00:00.000Z",
      idleExpiresAt: "2026-07-30T00:15:00.000Z",
      absoluteExpiresAt: "2026-07-30T08:00:00.000Z",
      authenticationMethod: "INSTALLATION_KEY_RECOVERY",
      passwordChangeRequired: true,
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(session, 201))
      .mockResolvedValueOnce(jsonResponse({ ...session, authenticationMethod: "LOCAL_PASSWORD", passwordChangeRequired: false }))
      .mockResolvedValueOnce(jsonResponse({ ...session, authenticationMethod: "LOCAL_PASSWORD", passwordChangeRequired: false }));

    await createInstallationKeyRecoverySession("a-secure-installation-key-with-more-than-32-characters");
    await recoverLocalAdministrator("admin", "replacement-password");
    await changeLocalAdministratorPassword("replacement-password", "another-secure-password");

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/admin/session/installation-key",
      "/api/v1/admin/session/recovery",
      "/api/v1/admin/session/password",
    ]);
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

  it("does not declare JSON for a bodyless connection diagnostic", async () => {
    const connectionId = "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      connectionId,
      status: "HEALTHY",
      message: "Connection succeeded.",
      checkedAt: "2026-07-30T00:00:00.000Z",
      latencyMs: 12,
      details: {},
    }));

    await testConnection(connectionId);

    const [, options] = fetchMock.mock.calls[0]!;
    expect(options).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(options?.body).toBeUndefined();
    expect(new Headers(options?.headers).has("content-type")).toBe(false);
  });

  it("submits transient inference discovery without persisting the supplied credential", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      status: "READY",
      message: "Discovered one available model and a compatible model API.",
      normalizedBaseUrl: "http://gpu.internal:8000",
      backend: "VLLM",
      backendConfidence: "HIGH",
      backendEvidence: ["vLLM 0.9.2 responded at /version."],
      models: [{ id: "hermes-primary" }],
      recommended: {
        baseUrl: "http://gpu.internal:8000",
        inferenceBackend: "VLLM",
        healthPath: "/health",
        modelsPath: "/v1/models",
        chatPath: "/v1/chat/completions",
        modelAlias: "hermes-primary",
      },
      probes: [{
        key: "models-openai",
        label: "OpenAI model discovery",
        path: "/v1/models",
        status: "PASSED",
        httpStatus: 200,
        latencyMs: 8,
        message: "OpenAI model discovery responded successfully.",
      }],
    }));

    await discoverInferenceServer({
      baseUrl: "http://gpu.internal:8000/v1",
      apiKey: "temporary-key",
      timeoutMs: 8000,
    });

    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/v1/admin/connections/inference/discover");
    expect(options).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(JSON.parse(String(options?.body))).toMatchObject({ apiKey: "temporary-key" });
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

  it("reads the release check from the administrator route and approves only a tag", async () => {
    /*
     * Not `/api/v1/platform/update`. That route needs no session, so it never
     * carries the approved target — the record names the administrator who
     * approved it. The approval body carries a tag and the revision the
     * operator was shown; the commit is resolved server-side.
     */
    const target = {
      desiredVersion: "v5.3.0",
      desiredCommit: "3f6a1c9d20b74e5a8c1d0f2b7e4a9c6d5b8e0134",
      approvedBy: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
      approvedBySubject: "platform-admin",
      approvedAt: "2026-08-15T00:00:00.000Z",
      revision: 1,
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({
        currentVersion: "v5.2.2",
        latestVersion: "v5.3.0",
        updateAvailable: true,
        releaseUrl: "https://github.com/multichainerz/AI/tree/v5.3.0",
        updateCommand: "curl installer | sudo ORCASYNAPSE_REF=v5.3.0 bash",
        automaticUpdateSupported: false,
        automaticUpdateReason: "The dashboard has no host control.",
        checkedAt: "2026-08-15T00:00:00.000Z",
        target: null,
      }))
      .mockResolvedValueOnce(jsonResponse(target))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await getPlatformUpdate();
    await approveReleaseTarget({ desiredVersion: "v5.3.0", expectedRevision: 0 });
    await clearReleaseTarget();

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/admin/updates");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/v1/admin/updates/target");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      body: JSON.stringify({ desiredVersion: "v5.3.0", expectedRevision: 0 }),
    });
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ method: "DELETE", credentials: "same-origin" });
  });

  it("reads model routes and sends an evidence-bound activation decision", async () => {
    const model = {
      id: "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d",
      slug: "laguna-hermes",
      displayName: "Laguna Hermes",
      modelAlias: "hermes-agent",
      workload: "AGENT",
      status: "ACTIVE",
      connection: { id: "5277951c-7d22-4cec-8d46-fad3afba37dd", displayName: "Inference Primary", kind: "INFERENCE", environment: "PRODUCTION", enabled: true, status: "HEALTHY" },
      version: "2.1-nvfp4",
      license: null,
      contextWindowTokens: 131072,
      maxOutputTokens: 8192,
      maxConcurrentRequests: 2,
      isDefault: true,
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
      maxInputCharacters: 12000,
      maxOutputCharacters: 200000,
      blockControlCharacters: true,
      blockCredentialPatterns: true,
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
      slug: "orcasynapse-chat-system",
      displayName: "OrcaSynapse chat system",
      description: "Approved employee chat behavior.",
      purpose: "CHAT_SYSTEM",
      version: "1.0.0",
      status: "ACTIVE",
      content: "You are the approved OrcaSynapse assistant. State uncertainty and protect private data.",
      contentChecksum: "a".repeat(64),
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
        email: "pilot@orcasynapse.example",
      },
      scopes: ["chat:use", "agents:use"],
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

  it("stops Chat through the explicit durable-run cancellation route", async () => {
    const conversationId = "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      id: conversationId,
      title: "Pilot chat",
      modelAlias: "hermes-model",
      profileId: "f2f68d20-f921-44ba-981c-56b043e1b9ac",
      profileName: "Hermes Analyst",
      status: "ACTIVE",
      messageCount: 0,
      lastMessagePreview: null,
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
      lastMessageAt: null,
      messages: [],
    }));

    await cancelChatRun(conversationId);

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/chat/conversations/${conversationId}/cancel`,
      expect.objectContaining({ method: "POST", credentials: "same-origin" }),
    );
  });

  it("sends the optimistic active-revision guard when restoring configuration", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({
      connection: {
        id: "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d",
        slug: "vllm-primary",
        displayName: "vLLM Primary",
        kind: "INFERENCE",
        environment: "PRODUCTION",
        baseUrl: "https://vllm.orcasynapse.internal",
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
      expect.objectContaining<Partial<OrcaSynapseApiError>>({
        name: "OrcaSynapseApiError",
        status: 502,
        message: "OrcaSynapse API returned 502 Bad Gateway",
      }),
    );
  });

  it("parses typed chat events from a split SSE stream", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: started\ndata: {"type":"started","conversationId":"8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d",'));
        controller.enqueue(encoder.encode('"messageId":"6cf6ce1b-a8c6-49d7-b6aa-019d35888acb","runId":"814f06ec-7e6f-47f4-93e9-a0c7c0d3acfd","cursor":null}\n\nid: 1\nevent: delta\ndata: {"type":"delta","conversationId":"8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d","messageId":"6cf6ce1b-a8c6-49d7-b6aa-019d35888acb","cursor":"1","delta":"Hi"}\n\n'));
        controller.close();
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));
    const events: string[] = [];

    await streamChatEvents(
      "8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d",
      "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
      null,
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

  it("sends concurrency-safe readiness evidence and external approval records", async () => {
    const control = {
      key: "security-threat-model",
      title: "Threat model and security review",
      domain: "SECURITY",
      description: "OrcaSynapse Security reviews the intended pilot scope.",
      status: "VERIFIED",
      owner: "OrcaSynapse Security",
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
      authority: "OrcaSynapse Security Review Board",
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
      owner: "OrcaSynapse Security",
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
