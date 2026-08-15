import {
  architectureDecisionSchema,
  auditEventListSchema,
  auditForwardingStateSchema,
  connectionTestResultSchema,
  connectionMonitoringControlSchema,
  inferenceDiscoveryResultSchema,
  administratorSessionSchema,
  configurationRevisionListSchema,
  platformMetaSchema,
  platformReleaseTargetSchema,
  platformUpdateSchema,
  serviceConnectionListSchema,
  serviceConnectionSummarySchema,
  rollbackConfigurationResultSchema,
  chatConversationListSchema,
  chatConversationSchema,
  chatConversationSummarySchema,
  chatMessageSubmissionSchema,
  chatStreamEventSchema,
  agentRunApprovalSchema,
  chatFeedbackSchema,
  chatMetricsSchema,
  enterpriseSessionSchema,
  oidcStatusSchema,
  type AdministratorSession,
  type AuditEventList,
  type AuditEventQuery,
  type AuditForwardingState,
  type ArchitectureDecision,
  type CompleteOnboarding,
  type UpdateArchitectureDecision,
  type CreateServiceConnection,
  type ConnectionTestResult,
  type ConnectionMonitoringControl,
  type InferenceDiscoveryRequest,
  type InferenceDiscoveryResult,
  type UpdateConnectionMonitoringControl,
  type ConfigurationRevisionList,
  type ApproveReleaseTarget,
  type PlatformMeta,
  type PlatformReleaseTarget,
  type PlatformUpdate,
  type ServiceConnectionList,
  type ServiceConnectionSummary,
  type RollbackConfigurationResult,
  type ChatConversation,
  type ChatConversationList,
  type ChatConversationSummary,
  type ChatStreamEvent,
  type ChatFeedback,
  type ChatFeedbackRating,
  type ChatMetrics,
  type ChatMessageSubmission,
  type AgentRunApproval,
  type DecideAgentRunApproval,
  type ForkChatConversation,
  type EnterpriseSession,
  type OidcStatus,
  type CreateChatConversation,
  type UpdateChatConversation,
  type UpdateServiceConnection,
  agentProfileListSchema,
  agentProfileSchema,
  agentRunListSchema,
  agentRunEventListSchema,
  agentRunSchema,
  agentRuntimeControlSchema,
  agentMetricsSchema,
  type AgentProfile,
  type AgentProfileList,
  type AgentRun,
  type AgentRunList,
  type AgentRunEventList,
  type AgentRuntimeControl,
  type AgentMetrics,
  type CreateAgentProfile,
  type UpdateAgentProfile,
  governedToolListSchema,
  toolGrantListSchema,
  toolGrantSchema,
  gatewayCredentialListSchema,
  issuedGatewayCredentialSchema,
  toolApprovalListSchema,
  toolsetAdmissionListSchema,
  toolsetAdmissionSchema,
  toolCallListSchema,
  toolRuntimeControlSchema,
  toolMetricsSchema,
  type GovernedToolList,
  type ToolGrant,
  type ToolGrantList,
  type GatewayCredentialList,
  type IssuedGatewayCredential,
  type ToolApprovalList,
  type ToolsetAdmission,
  type ToolsetAdmissionList,
  type ToolCallList,
  type ToolRuntimeControl,
  type ToolMetrics,
  type UpsertToolGrant,
  type ToolStatus,
  type UpdateToolRuntimeControl,
  aiOpsOverviewSchema,
  operationalIncidentListSchema,
  operationalIncidentSchema,
  productionReadinessSchema,
  productionReadinessControlSchema,
  productionReadinessApprovalSchema,
  type AiOpsOverview,
  type OperationalIncident,
  type OperationalIncidentList,
  type CreateOperationalIncident,
  type IncidentDecision,
  type ProductionReadiness,
  type ProductionReadinessControl,
  type ProductionReadinessApproval,
  type UpdateProductionReadinessControl,
  type RecordProductionReadinessApproval,
  modelDeploymentListSchema,
  modelDeploymentSchema,
  type ModelDeployment,
  type ModelDeploymentList,
  type CreateModelDeployment,
  type UpdateModelDeployment,
  type ChangeModelDeploymentState,
  guardrailPolicyListSchema,
  guardrailPolicySchema,
  type GuardrailPolicy,
  type GuardrailPolicyList,
  type CreateGuardrailPolicy,
  type UpdateGuardrailPolicy,
  type ChangeGuardrailPolicyState,
  promptTemplateListSchema,
  hermesRuntimeCatalogueSchema,
  promptTemplateSchema,
  type PromptTemplate,
  type PromptTemplateList,
  type HermesRuntimeCatalogue,
  type CreatePromptTemplate,
  type UpdatePromptTemplate,
  type ChangePromptTemplateState,
  onboardingSnapshotSchema,
  recoveryKitExportSchema,
  type OnboardingSnapshot,
  type RunOnboardingValidation,
  type ExportRecoveryKit,
  type RecoveryKitExport,
  type VerifyRecoveryKit,
  hermesNodeInvitationSchema,
  hermesRuntimeNodeListSchema,
  hermesRuntimeNodeSchema,
  type CreateHermesNodeInvitation,
  type HermesNodeInvitation,
  type HermesRuntimeNode,
  type HermesRuntimeNodeList,
  type MutateHermesRuntimeNode,
  type RemoveHermesRuntimeNode,
  hermesCorpusEntryListSchema,
  hermesCorpusMutationListSchema,
  hermesCorpusMutationSchema,
  hermesCorpusOverviewSchema,
  hermesCorpusRevisionListSchema,
  type CreateHermesCorpusMutation,
  type DecideHermesCorpusMutation,
  type HermesCorpusEntry,
  type HermesCorpusMutation,
  type HermesCorpusOverview,
  type HermesCorpusRevision,
} from "@orcasynapse/contracts";

export class OrcaSynapseApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "OrcaSynapseApiError";
  }
}

async function parsedResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  let body: unknown = {};
  if (text.length > 0) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      if (response.ok) {
        throw new OrcaSynapseApiError(response.status, "OrcaSynapse returned an invalid response.");
      }
    }
  }
  if (!response.ok) {
    const message =
      body &&
      typeof body === "object" &&
      "message" in body &&
      typeof body.message === "string"
        ? body.message
        : undefined;
    throw new OrcaSynapseApiError(
      response.status,
      message ?? `OrcaSynapse API returned ${response.status} ${response.statusText}`.trim(),
    );
  }
  return body;
}

function adminHeaders(): HeadersInit {
  return {
    "content-type": "application/json",
  };
}

export async function createLocalAdministratorSession(username: string, password: string): Promise<AdministratorSession> {
  const response = await fetch("/api/v1/admin/session/local", {
    method: "POST",
    headers: adminHeaders(),
    credentials: "same-origin",
    body: JSON.stringify({ username, password }),
  });
  return administratorSessionSchema.parse(await parsedResponse(response));
}

export async function createInstallationKeyRecoverySession(installationKey: string): Promise<AdministratorSession> {
  const response = await fetch("/api/v1/admin/session/installation-key", {
    method: "POST",
    headers: adminHeaders(),
    credentials: "same-origin",
    body: JSON.stringify({ installationKey }),
  });
  return administratorSessionSchema.parse(await parsedResponse(response));
}

export async function changeLocalAdministratorPassword(
  currentPassword: string,
  newPassword: string,
): Promise<AdministratorSession> {
  const response = await fetch("/api/v1/admin/session/password", {
    method: "PUT",
    headers: adminHeaders(),
    credentials: "same-origin",
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  return administratorSessionSchema.parse(await parsedResponse(response));
}

export async function recoverLocalAdministrator(username: string, newPassword: string): Promise<AdministratorSession> {
  const response = await fetch("/api/v1/admin/session/recovery", {
    method: "PUT",
    headers: adminHeaders(),
    credentials: "same-origin",
    body: JSON.stringify({ username, newPassword }),
  });
  return administratorSessionSchema.parse(await parsedResponse(response));
}

export async function getAdministratorSession(): Promise<AdministratorSession> {
  const response = await fetch("/api/v1/admin/session", { credentials: "same-origin" });
  return administratorSessionSchema.parse(await parsedResponse(response));
}

export async function revokeAdministratorSession(): Promise<void> {
  const response = await fetch("/api/v1/admin/session", {
    method: "DELETE",
    credentials: "same-origin",
  });
  if (!response.ok) await parsedResponse(response);
}

export async function getOidcStatus(): Promise<OidcStatus> {
  const response = await fetch("/api/v1/auth/oidc/status", {
    credentials: "same-origin",
  });
  return oidcStatusSchema.parse(await parsedResponse(response));
}

export async function getEnterpriseSession(): Promise<EnterpriseSession> {
  const response = await fetch("/api/v1/session", { credentials: "same-origin" });
  return enterpriseSessionSchema.parse(await parsedResponse(response));
}

export async function revokeEnterpriseSession(): Promise<void> {
  const response = await fetch("/api/v1/session", {
    method: "DELETE",
    credentials: "same-origin",
  });
  if (!response.ok) await parsedResponse(response);
}

export async function getPlatformMeta(signal?: AbortSignal): Promise<PlatformMeta> {
  const response = await fetch("/api/v1/platform", signal ? { signal } : {});
  return platformMetaSchema.parse(await parsedResponse(response));
}

/**
 * The release check and the approved target, from the administrator route.
 *
 * Not the unauthenticated `/api/v1/platform/update`: the response names the
 * administrator who approved the target, which is not public. Both answer the
 * same release question; only this one carries the record.
 */
export async function getPlatformUpdate(): Promise<PlatformUpdate> {
  const response = await fetch("/api/v1/admin/updates", {
    credentials: "same-origin",
    cache: "no-store",
  });
  return platformUpdateSchema.parse(await parsedResponse(response));
}

export async function approveReleaseTarget(input: ApproveReleaseTarget): Promise<PlatformReleaseTarget> {
  const response = await fetch("/api/v1/admin/updates/target", {
    method: "POST",
    headers: adminHeaders(),
    credentials: "same-origin",
    body: JSON.stringify(input),
  });
  return platformReleaseTargetSchema.parse(await parsedResponse(response));
}

export async function clearReleaseTarget(): Promise<void> {
  const response = await fetch("/api/v1/admin/updates/target", {
    method: "DELETE",
    credentials: "same-origin",
  });
  if (!response.ok) await parsedResponse(response);
}

export async function getConnections(): Promise<ServiceConnectionList> {
  const response = await fetch("/api/v1/admin/connections", {
    credentials: "same-origin",
  });
  return serviceConnectionListSchema.parse(await parsedResponse(response));
}

export async function getConnectionMonitoring(): Promise<ConnectionMonitoringControl> {
  const response = await fetch("/api/v1/admin/connections/monitoring", {
    credentials: "same-origin",
  });
  return connectionMonitoringControlSchema.parse(await parsedResponse(response));
}

export async function updateConnectionMonitoring(
  input: UpdateConnectionMonitoringControl,
): Promise<ConnectionMonitoringControl> {
  const response = await fetch("/api/v1/admin/connections/monitoring", {
    method: "PATCH",
    headers: adminHeaders(),
    credentials: "same-origin",
    body: JSON.stringify(input),
  });
  return connectionMonitoringControlSchema.parse(await parsedResponse(response));
}

export async function createConnection(
  input: CreateServiceConnection,
): Promise<ServiceConnectionSummary> {
  const response = await fetch("/api/v1/admin/connections", {
    method: "POST",
    headers: adminHeaders(),
    credentials: "same-origin",
    body: JSON.stringify(input),
  });
  return serviceConnectionSummarySchema.parse(await parsedResponse(response));
}

export async function updateConnection(
  id: string,
  input: UpdateServiceConnection,
): Promise<ServiceConnectionSummary> {
  const response = await fetch(`/api/v1/admin/connections/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: adminHeaders(),
    credentials: "same-origin",
    body: JSON.stringify(input),
  });
  return serviceConnectionSummarySchema.parse(await parsedResponse(response));
}

export async function testConnection(
  id: string,
): Promise<ConnectionTestResult> {
  const response = await fetch(`/api/v1/admin/connections/${encodeURIComponent(id)}/test`, {
    method: "POST",
    credentials: "same-origin",
  });
  return connectionTestResultSchema.parse(await parsedResponse(response));
}

export async function discoverInferenceServer(
  input: InferenceDiscoveryRequest,
): Promise<InferenceDiscoveryResult> {
  const response = await fetch("/api/v1/admin/connections/inference/discover", {
    method: "POST",
    headers: adminHeaders(),
    credentials: "same-origin",
    body: JSON.stringify(input),
  });
  return inferenceDiscoveryResultSchema.parse(await parsedResponse(response));
}

export async function getConfigurationRevisions(
  id: string,
): Promise<ConfigurationRevisionList> {
  const response = await fetch(
    `/api/v1/admin/connections/${encodeURIComponent(id)}/revisions`,
    { credentials: "same-origin" },
  );
  return configurationRevisionListSchema.parse(await parsedResponse(response));
}

export async function rollbackConfiguration(
  id: string,
  targetRevision: number,
  expectedActiveRevision: number,
): Promise<RollbackConfigurationResult> {
  const response = await fetch(
    `/api/v1/admin/connections/${encodeURIComponent(id)}/revisions/${targetRevision}/rollback`,
    {
      method: "POST",
      headers: adminHeaders(),
      credentials: "same-origin",
      body: JSON.stringify({ expectedActiveRevision }),
    },
  );
  return rollbackConfigurationResultSchema.parse(await parsedResponse(response));
}

export async function getChatConversations(): Promise<ChatConversationList> {
  const response = await fetch("/api/v1/chat/conversations", {
    credentials: "same-origin",
  });
  return chatConversationListSchema.parse(await parsedResponse(response));
}

export async function createChatConversation(
  input: CreateChatConversation = {},
): Promise<ChatConversationSummary> {
  const response = await fetch("/api/v1/chat/conversations", {
    method: "POST",
    headers: adminHeaders(),
    credentials: "same-origin",
    body: JSON.stringify(input),
  });
  return chatConversationSummarySchema.parse(await parsedResponse(response));
}

export async function getChatConversation(id: string): Promise<ChatConversation> {
  const response = await fetch(
    `/api/v1/chat/conversations/${encodeURIComponent(id)}`,
    { credentials: "same-origin" },
  );
  return chatConversationSchema.parse(await parsedResponse(response));
}

export async function updateChatConversation(
  id: string,
  input: UpdateChatConversation,
): Promise<ChatConversationSummary> {
  const response = await fetch(
    `/api/v1/chat/conversations/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: adminHeaders(),
      credentials: "same-origin",
      body: JSON.stringify(input),
    },
  );
  return chatConversationSummarySchema.parse(await parsedResponse(response));
}

export async function cancelChatRun(conversationId: string): Promise<ChatConversation> {
  const response = await fetch(
    `/api/v1/chat/conversations/${encodeURIComponent(conversationId)}/cancel`,
    { method: "POST", headers: adminHeaders(), credentials: "same-origin" },
  );
  return chatConversationSchema.parse(await parsedResponse(response));
}

export async function submitChatMessage(
  conversationId: string,
  content: string,
): Promise<ChatMessageSubmission> {
  const response = await fetch(
    `/api/v1/chat/conversations/${encodeURIComponent(conversationId)}/messages`,
    {
      method: "POST",
      headers: adminHeaders(),
      credentials: "same-origin",
      body: JSON.stringify({ content }),
    },
  );
  return chatMessageSubmissionSchema.parse(await parsedResponse(response));
}

export async function streamChatEvents(
  conversationId: string,
  messageId: string,
  cursor: string | null,
  onEvent: (event: ChatStreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  const response = await fetch(
    `/api/v1/chat/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/events${query}`,
    { credentials: "same-origin", signal },
  );
  if (!response.ok) await parsedResponse(response);
  if (!response.body) {
    throw new OrcaSynapseApiError(response.status, "OrcaSynapse returned no chat response stream.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let streamError: string | null = null;
  const consumeFrame = (frame: string) => {
    // The SSE `event:` line is not read: every frame carries its own `type`,
    // and trusting one over the other is how the two could ever disagree.
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return;
    /*
     * A frame this build cannot read is skipped, not fatal.
     *
     * Version skew reaches here as a matter of course: a rolling deploy with a
     * tab left open sends frame types, or `state.status` values, that this
     * bundle was not compiled with. (`activity` is deliberately an open string,
     * so new *runtime* event types were already safe; new *frame* types were
     * not.) Throwing abandoned the reader mid-request and lost every frame
     * after it, while the run carried on with nobody reading it — and the
     * reconnect above opened a second request without closing the first.
     *
     * The cursor is not advanced for a skipped frame, so the server resends
     * from the last frame this client actually understood, and the refetch once
     * the stream ends reconciles the transcript either way.
     */
    let event: ChatStreamEvent;
    try {
      event = chatStreamEventSchema.parse(JSON.parse(data) as unknown);
    } catch (cause) {
      // Skipped, not swallowed. Nothing else in the client can report that this
      // tab is behind the control plane it is talking to.
      console.warn("OrcaSynapse skipped an unreadable chat stream frame", data.slice(0, 500), cause);
      return;
    }
    if (event.type === "stream_error") {
      // Held rather than dispatched: the run may still be going, and the
      // reducer has no state to change for a transport that dropped.
      streamError = event.error;
      return;
    }
    onEvent(event);
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";
      for (const frame of frames) consumeFrame(frame);
      if (done) break;
    }
    if (buffer.trim()) consumeFrame(buffer);
  } finally {
    /*
     * The reader is the only handle on an open request. Leaving the loop any
     * other way than through `done` — a throwing consumer, a read that rejects
     * — used to leave the connection established: the server's
     * `request.raw.once("close")` never fired, its `subscribe()` kept polling,
     * and the view's reconnect opened another alongside it. Browsers allow
     * roughly six per origin, so a handful of rounds stalled the application.
     *
     * Cancelling a stream that already finished is a no-op, and cancelling one
     * that already errored rejects; neither is worth reporting over whatever
     * sent us here.
     */
    await reader.cancel().catch(() => undefined);
  }
  if (streamError) throw new OrcaSynapseApiError(502, streamError);
}

export async function forkChatConversation(
  conversationId: string,
  input: ForkChatConversation = {},
): Promise<ChatConversationSummary> {
  const response = await fetch(`/api/v1/chat/conversations/${encodeURIComponent(conversationId)}/fork`, {
    method: "POST",
    headers: adminHeaders(),
    credentials: "same-origin",
    body: JSON.stringify(input),
  });
  return chatConversationSummarySchema.parse(await parsedResponse(response));
}

export async function deleteChatConversation(conversationId: string): Promise<void> {
  const response = await fetch(`/api/v1/chat/conversations/${encodeURIComponent(conversationId)}`, {
    method: "DELETE",
    credentials: "same-origin",
  });
  if (!response.ok) await parsedResponse(response);
}

export async function decideChatApproval(
  approvalId: string,
  input: DecideAgentRunApproval,
): Promise<AgentRunApproval> {
  const response = await fetch(`/api/v1/chat/approvals/${encodeURIComponent(approvalId)}/decision`, {
    method: "POST",
    headers: adminHeaders(),
    credentials: "same-origin",
    body: JSON.stringify(input),
  });
  return agentRunApprovalSchema.parse(await parsedResponse(response));
}

export async function setChatFeedback(
  messageId: string,
  rating: ChatFeedbackRating,
): Promise<ChatFeedback> {
  const response = await fetch(
    `/api/v1/chat/messages/${encodeURIComponent(messageId)}/feedback`,
    {
      method: "PUT",
      headers: adminHeaders(),
      credentials: "same-origin",
      body: JSON.stringify({ rating }),
    },
  );
  return chatFeedbackSchema.parse(await parsedResponse(response));
}

export async function getChatMetrics(): Promise<ChatMetrics> {
  const response = await fetch("/api/v1/admin/chat/metrics", {
    credentials: "same-origin",
  });
  return chatMetricsSchema.parse(await parsedResponse(response));
}

export async function getAgentProfiles(administrator: boolean): Promise<AgentProfileList> {
  const path = administrator ? "/api/v1/admin/agents/profiles" : "/api/v1/agents/profiles";
  const response = await fetch(path, { credentials: "same-origin" });
  return agentProfileListSchema.parse(await parsedResponse(response));
}

export async function createAgentProfile(input: CreateAgentProfile): Promise<AgentProfile> {
  const response = await fetch("/api/v1/admin/agents/profiles", {
    method: "POST", headers: adminHeaders(), credentials: "same-origin", body: JSON.stringify(input),
  });
  return agentProfileSchema.parse(await parsedResponse(response));
}

export async function updateAgentProfile(id: string, input: UpdateAgentProfile): Promise<AgentProfile> {
  const response = await fetch(`/api/v1/admin/agents/profiles/${encodeURIComponent(id)}`, {
    method: "PATCH", headers: adminHeaders(), credentials: "same-origin", body: JSON.stringify(input),
  });
  return agentProfileSchema.parse(await parsedResponse(response));
}

export async function setAgentProfileState(id: string, action: "standby" | "activate" | "suspend"): Promise<AgentProfile> {
  const response = await fetch(`/api/v1/admin/agents/profiles/${encodeURIComponent(id)}/${action}`, {
    method: "POST", credentials: "same-origin",
  });
  return agentProfileSchema.parse(await parsedResponse(response));
}

export async function getAgentRuns(administrator: boolean): Promise<AgentRunList> {
  const path = administrator ? "/api/v1/admin/agents/runs" : "/api/v1/agents/runs";
  const response = await fetch(path, { credentials: "same-origin" });
  return agentRunListSchema.parse(await parsedResponse(response));
}

export async function getAgentRunEvents(runId: string, administrator: boolean): Promise<AgentRunEventList> {
  const prefix = administrator ? "/api/v1/admin/agents" : "/api/v1/agents";
  const response = await fetch(`${prefix}/runs/${encodeURIComponent(runId)}/events`, { credentials: "same-origin" });
  return agentRunEventListSchema.parse(await parsedResponse(response));
}

export async function cancelAgentRun(runId: string, administrator: boolean): Promise<AgentRun> {
  const prefix = administrator ? "/api/v1/admin/agents" : "/api/v1/agents";
  const response = await fetch(`${prefix}/runs/${encodeURIComponent(runId)}/cancel`, {
    method: "POST", credentials: "same-origin",
  });
  return agentRunSchema.parse(await parsedResponse(response));
}

export async function getAgentRuntime(): Promise<AgentRuntimeControl> {
  const response = await fetch("/api/v1/admin/agents/runtime", { credentials: "same-origin" });
  return agentRuntimeControlSchema.parse(await parsedResponse(response));
}

export async function updateAgentRuntime(enabled: boolean, reason: string): Promise<AgentRuntimeControl> {
  const response = await fetch("/api/v1/admin/agents/runtime", {
    method: "PATCH", headers: adminHeaders(), credentials: "same-origin", body: JSON.stringify({ enabled, reason }),
  });
  return agentRuntimeControlSchema.parse(await parsedResponse(response));
}

export async function getAgentMetrics(): Promise<AgentMetrics> {
  const response = await fetch("/api/v1/admin/agents/metrics", { credentials: "same-origin" });
  return agentMetricsSchema.parse(await parsedResponse(response));
}

export async function getModelDeployments(): Promise<ModelDeploymentList> {
  const response = await fetch("/api/v1/admin/models", { credentials: "same-origin" });
  return modelDeploymentListSchema.parse(await parsedResponse(response));
}

export async function createModelDeployment(input: CreateModelDeployment): Promise<ModelDeployment> {
  const response = await fetch("/api/v1/admin/models", {
    method: "POST", headers: adminHeaders(), credentials: "same-origin", body: JSON.stringify(input),
  });
  return modelDeploymentSchema.parse(await parsedResponse(response));
}

export async function updateModelDeployment(id: string, input: UpdateModelDeployment): Promise<ModelDeployment> {
  const response = await fetch(`/api/v1/admin/models/${encodeURIComponent(id)}`, {
    method: "PATCH", headers: adminHeaders(), credentials: "same-origin", body: JSON.stringify(input),
  });
  return modelDeploymentSchema.parse(await parsedResponse(response));
}

export async function changeModelDeploymentState(
  id: string,
  action: "activate" | "suspend",
  input: ChangeModelDeploymentState,
): Promise<ModelDeployment> {
  const response = await fetch(`/api/v1/admin/models/${encodeURIComponent(id)}/${action}`, {
    method: "POST", headers: adminHeaders(), credentials: "same-origin", body: JSON.stringify(input),
  });
  return modelDeploymentSchema.parse(await parsedResponse(response));
}

export async function getGuardrailPolicies(): Promise<GuardrailPolicyList> {
  const response = await fetch("/api/v1/admin/guardrails", { credentials: "same-origin" });
  return guardrailPolicyListSchema.parse(await parsedResponse(response));
}

export async function createGuardrailPolicy(input: CreateGuardrailPolicy): Promise<GuardrailPolicy> {
  const response = await fetch("/api/v1/admin/guardrails", {
    method: "POST", headers: adminHeaders(), credentials: "same-origin", body: JSON.stringify(input),
  });
  return guardrailPolicySchema.parse(await parsedResponse(response));
}

export async function updateGuardrailPolicy(id: string, input: UpdateGuardrailPolicy): Promise<GuardrailPolicy> {
  const response = await fetch(`/api/v1/admin/guardrails/${encodeURIComponent(id)}`, {
    method: "PATCH", headers: adminHeaders(), credentials: "same-origin", body: JSON.stringify(input),
  });
  return guardrailPolicySchema.parse(await parsedResponse(response));
}

export async function changeGuardrailPolicyState(
  id: string,
  action: "activate" | "suspend",
  input: ChangeGuardrailPolicyState,
): Promise<GuardrailPolicy> {
  const response = await fetch(`/api/v1/admin/guardrails/${encodeURIComponent(id)}/${action}`, {
    method: "POST", headers: adminHeaders(), credentials: "same-origin", body: JSON.stringify(input),
  });
  return guardrailPolicySchema.parse(await parsedResponse(response));
}

export async function getPromptTemplates(): Promise<PromptTemplateList> {
  const response = await fetch("/api/v1/admin/prompts", { credentials: "same-origin" });
  return promptTemplateListSchema.parse(await parsedResponse(response));
}

export async function createPromptTemplate(input: CreatePromptTemplate): Promise<PromptTemplate> {
  const response = await fetch("/api/v1/admin/prompts", {
    method: "POST", headers: adminHeaders(), credentials: "same-origin", body: JSON.stringify(input),
  });
  return promptTemplateSchema.parse(await parsedResponse(response));
}

export async function updatePromptTemplate(id: string, input: UpdatePromptTemplate): Promise<PromptTemplate> {
  const response = await fetch(`/api/v1/admin/prompts/${encodeURIComponent(id)}`, {
    method: "PATCH", headers: adminHeaders(), credentials: "same-origin", body: JSON.stringify(input),
  });
  return promptTemplateSchema.parse(await parsedResponse(response));
}

export async function changePromptTemplateState(
  id: string,
  action: "activate" | "suspend",
  input: ChangePromptTemplateState,
): Promise<PromptTemplate> {
  const response = await fetch(`/api/v1/admin/prompts/${encodeURIComponent(id)}/${action}`, {
    method: "POST", headers: adminHeaders(), credentials: "same-origin", body: JSON.stringify(input),
  });
  return promptTemplateSchema.parse(await parsedResponse(response));
}

export async function getGovernedTools(): Promise<GovernedToolList> {
  const response = await fetch("/api/v1/admin/tooling/tools", { credentials: "same-origin" });
  return governedToolListSchema.parse(await parsedResponse(response));
}

export async function setGovernedToolStatus(toolId: string, status: ToolStatus): Promise<void> {
  const response = await fetch(`/api/v1/admin/tooling/tools/${encodeURIComponent(toolId)}`, {
    method: "PATCH", headers: adminHeaders(), credentials: "same-origin", body: JSON.stringify({ status }),
  });
  if (!response.ok) await parsedResponse(response);
}

export async function getToolGrants(): Promise<ToolGrantList> {
  const response = await fetch("/api/v1/admin/tooling/grants", { credentials: "same-origin" });
  return toolGrantListSchema.parse(await parsedResponse(response));
}

export async function upsertToolGrant(input: UpsertToolGrant): Promise<ToolGrant> {
  const response = await fetch("/api/v1/admin/tooling/grants", {
    method: "PUT", headers: adminHeaders(), credentials: "same-origin", body: JSON.stringify(input),
  });
  return toolGrantSchema.parse(await parsedResponse(response));
}

export async function getGatewayCredentials(): Promise<GatewayCredentialList> {
  const response = await fetch("/api/v1/admin/tooling/credentials", { credentials: "same-origin" });
  return gatewayCredentialListSchema.parse(await parsedResponse(response));
}

export async function issueGatewayCredential(name: string): Promise<IssuedGatewayCredential> {
  const response = await fetch("/api/v1/admin/tooling/credentials", {
    method: "POST", headers: adminHeaders(), credentials: "same-origin", body: JSON.stringify({ name }),
  });
  return issuedGatewayCredentialSchema.parse(await parsedResponse(response));
}

export async function revokeGatewayCredential(id: string): Promise<void> {
  const response = await fetch(`/api/v1/admin/tooling/credentials/${encodeURIComponent(id)}`, {
    method: "DELETE", credentials: "same-origin",
  });
  if (!response.ok) await parsedResponse(response);
}

/** Consequential tool calls waiting on a human. Polled, so never cached. */
export async function getPendingToolApprovals(): Promise<ToolApprovalList> {
  const response = await fetch("/api/v1/admin/tooling/approvals", { credentials: "same-origin" });
  return toolApprovalListSchema.parse(await parsedResponse(response));
}

export async function decideToolApproval(
  approvalId: string,
  decision: "APPROVE" | "REJECT",
  reason: string,
): Promise<void> {
  const response = await fetch(
    `/api/v1/admin/tooling/approvals/${encodeURIComponent(approvalId)}/decision`,
    {
      method: "POST",
      headers: adminHeaders(),
      credentials: "same-origin",
      body: JSON.stringify({ decision, reason }),
    },
  );
  if (!response.ok) await parsedResponse(response);
}

export async function getToolCalls(): Promise<ToolCallList> {
  const response = await fetch("/api/v1/admin/tooling/calls", { credentials: "same-origin" });
  return toolCallListSchema.parse(await parsedResponse(response));
}

export async function getToolRuntime(): Promise<ToolRuntimeControl> {
  const response = await fetch("/api/v1/admin/tooling/runtime", { credentials: "same-origin" });
  return toolRuntimeControlSchema.parse(await parsedResponse(response));
}

export async function updateToolRuntime(input: UpdateToolRuntimeControl): Promise<ToolRuntimeControl> {
  const response = await fetch("/api/v1/admin/tooling/runtime", {
    method: "PATCH", headers: adminHeaders(), credentials: "same-origin", body: JSON.stringify(input),
  });
  return toolRuntimeControlSchema.parse(await parsedResponse(response));
}

export async function getToolMetrics(): Promise<ToolMetrics> {
  const response = await fetch("/api/v1/admin/tooling/metrics", { credentials: "same-origin" });
  return toolMetricsSchema.parse(await parsedResponse(response));
}

export async function getAiOpsOverview(): Promise<AiOpsOverview> {
  const response = await fetch("/api/v1/admin/operations/overview", { credentials: "same-origin" });
  return aiOpsOverviewSchema.parse(await parsedResponse(response));
}

export async function getOperationalIncidents(): Promise<OperationalIncidentList> {
  const response = await fetch("/api/v1/admin/operations/incidents", { credentials: "same-origin" });
  return operationalIncidentListSchema.parse(await parsedResponse(response));
}

export async function createOperationalIncident(input: CreateOperationalIncident): Promise<OperationalIncident> {
  const response = await fetch("/api/v1/admin/operations/incidents", {
    method: "POST", headers: adminHeaders(), credentials: "same-origin", body: JSON.stringify(input),
  });
  return operationalIncidentSchema.parse(await parsedResponse(response));
}

export async function decideOperationalIncident(
  id: string,
  action: "acknowledge" | "resolve",
  input: IncidentDecision,
): Promise<OperationalIncident> {
  const response = await fetch(`/api/v1/admin/operations/incidents/${encodeURIComponent(id)}/${action}`, {
    method: "POST", headers: adminHeaders(), credentials: "same-origin", body: JSON.stringify(input),
  });
  return operationalIncidentSchema.parse(await parsedResponse(response));
}

export async function getProductionReadiness(): Promise<ProductionReadiness> {
  const response = await fetch("/api/v1/admin/operations/readiness", { credentials: "same-origin" });
  return productionReadinessSchema.parse(await parsedResponse(response));
}

export async function updateProductionReadinessControl(
  key: string,
  input: UpdateProductionReadinessControl,
): Promise<ProductionReadinessControl> {
  const response = await fetch(`/api/v1/admin/operations/readiness/controls/${encodeURIComponent(key)}`, {
    method: "PATCH", headers: adminHeaders(), credentials: "same-origin", body: JSON.stringify(input),
  });
  return productionReadinessControlSchema.parse(await parsedResponse(response));
}

export async function recordProductionReadinessApproval(
  input: RecordProductionReadinessApproval,
): Promise<ProductionReadinessApproval> {
  const response = await fetch("/api/v1/admin/operations/readiness/approvals", {
    method: "POST", headers: adminHeaders(), credentials: "same-origin", body: JSON.stringify(input),
  });
  return productionReadinessApprovalSchema.parse(await parsedResponse(response));
}

export async function getAuditEvents(query: AuditEventQuery): Promise<AuditEventList> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const response = await fetch(`/api/v1/admin/audit/events?${search.toString()}`, { credentials: "same-origin" });
  return auditEventListSchema.parse(await parsedResponse(response));
}

export async function getOnboardingSnapshot(): Promise<OnboardingSnapshot> {
  const response = await fetch("/api/v1/admin/onboarding/", { credentials: "same-origin" });
  return onboardingSnapshotSchema.parse(await parsedResponse(response));
}

export async function runOnboardingValidation(input: RunOnboardingValidation = {}): Promise<OnboardingSnapshot> {
  const response = await fetch("/api/v1/admin/onboarding/validate", {
    method: "POST", headers: adminHeaders(), credentials: "same-origin", body: JSON.stringify(input),
  });
  return onboardingSnapshotSchema.parse(await parsedResponse(response));
}

export async function getAuditForwarding(): Promise<AuditForwardingState> {
  const response = await fetch("/api/v1/admin/audit/forwarding", { credentials: "same-origin" });
  return auditForwardingStateSchema.parse(await parsedResponse(response));
}

export async function updateArchitectureDecision(
  input: UpdateArchitectureDecision,
): Promise<ArchitectureDecision> {
  const response = await fetch("/api/v1/admin/onboarding/architecture", {
    method: "PATCH", headers: adminHeaders(), credentials: "same-origin", body: JSON.stringify(input),
  });
  return architectureDecisionSchema.parse(await parsedResponse(response));
}

export async function completeOnboarding(input: CompleteOnboarding): Promise<OnboardingSnapshot> {
  const response = await fetch("/api/v1/admin/onboarding/complete", {
    method: "POST", headers: adminHeaders(), credentials: "same-origin", body: JSON.stringify(input),
  });
  return onboardingSnapshotSchema.parse(await parsedResponse(response));
}

export async function exportCredentialRecoveryKit(input: ExportRecoveryKit): Promise<RecoveryKitExport> {
  const response = await fetch("/api/v1/admin/onboarding/recovery/export", {
    method: "POST", headers: adminHeaders(), credentials: "same-origin", body: JSON.stringify(input),
  });
  return recoveryKitExportSchema.parse(await parsedResponse(response));
}

export async function verifyCredentialRecoveryKit(input: VerifyRecoveryKit): Promise<OnboardingSnapshot> {
  const response = await fetch("/api/v1/admin/onboarding/recovery/verify", {
    method: "POST", headers: adminHeaders(), credentials: "same-origin", body: JSON.stringify(input),
  });
  return onboardingSnapshotSchema.parse(await parsedResponse(response));
}

export async function getHermesRuntimeNodes(): Promise<HermesRuntimeNodeList> {
  const response = await fetch("/api/v1/admin/runtime-nodes/", { credentials: "same-origin" });
  return hermesRuntimeNodeListSchema.parse(await parsedResponse(response));
}

export async function createHermesNodeInvitation(input: CreateHermesNodeInvitation): Promise<HermesNodeInvitation> {
  const response = await fetch("/api/v1/admin/runtime-nodes/invitations", {
    method: "POST", headers: adminHeaders(), credentials: "same-origin", body: JSON.stringify(input),
  });
  return hermesNodeInvitationSchema.parse(await parsedResponse(response));
}

export async function mutateHermesRuntimeNode(
  id: string,
  input: MutateHermesRuntimeNode,
): Promise<HermesRuntimeNode> {
  const response = await fetch(`/api/v1/admin/runtime-nodes/${encodeURIComponent(id)}/actions`, {
    method: "POST", headers: adminHeaders(), credentials: "same-origin", body: JSON.stringify(input),
  });
  return hermesRuntimeNodeSchema.parse(await parsedResponse(response));
}

export async function removeHermesRuntimeNode(
  id: string,
  input: RemoveHermesRuntimeNode,
): Promise<void> {
  const response = await fetch(`/api/v1/admin/runtime-nodes/${encodeURIComponent(id)}`, {
    method: "DELETE", headers: adminHeaders(), credentials: "same-origin", body: JSON.stringify(input),
  });
  await parsedResponse(response);
}

export async function getHermesCorpusOverview(): Promise<HermesCorpusOverview> {
  const response = await fetch("/api/v1/admin/corpus/overview", { credentials: "same-origin" });
  return hermesCorpusOverviewSchema.parse(await parsedResponse(response));
}

export async function getHermesCorpusEntries(input: {
  nodeId: string;
  query?: string;
  kind?: HermesCorpusEntry["kind"] | "";
  includeDeleted?: boolean;
  includeContent?: boolean;
}): Promise<{ items: HermesCorpusEntry[] }> {
  const search = new URLSearchParams({ nodeId: input.nodeId, includeContent: input.includeContent === false ? "false" : "true" });
  if (input.query) search.set("q", input.query);
  if (input.kind) search.set("kind", input.kind);
  if (input.includeDeleted) search.set("includeDeleted", "true");
  const response = await fetch(`/api/v1/admin/corpus/entries?${search.toString()}`, { credentials: "same-origin" });
  return hermesCorpusEntryListSchema.parse(await parsedResponse(response));
}

export async function getHermesCorpusRevisions(entryId: string, includeContent = true): Promise<{ items: HermesCorpusRevision[] }> {
  const response = await fetch(
    `/api/v1/admin/corpus/entries/${encodeURIComponent(entryId)}/revisions?includeContent=${includeContent ? "true" : "false"}`,
    { credentials: "same-origin" },
  );
  return hermesCorpusRevisionListSchema.parse(await parsedResponse(response));
}

export async function getHermesCorpusMutations(nodeId?: string): Promise<{ items: HermesCorpusMutation[] }> {
  const suffix = nodeId ? `?nodeId=${encodeURIComponent(nodeId)}` : "";
  const response = await fetch(`/api/v1/admin/corpus/mutations${suffix}`, { credentials: "same-origin" });
  return hermesCorpusMutationListSchema.parse(await parsedResponse(response));
}

export async function createHermesCorpusMutation(input: CreateHermesCorpusMutation): Promise<HermesCorpusMutation> {
  const response = await fetch("/api/v1/admin/corpus/mutations", {
    method: "POST", headers: adminHeaders(), credentials: "same-origin", body: JSON.stringify(input),
  });
  return hermesCorpusMutationSchema.parse(await parsedResponse(response));
}

export async function decideHermesCorpusMutation(
  mutationId: string,
  input: DecideHermesCorpusMutation,
): Promise<HermesCorpusMutation> {
  const response = await fetch(`/api/v1/admin/corpus/mutations/${encodeURIComponent(mutationId)}/decision`, {
    method: "POST", headers: adminHeaders(), credentials: "same-origin", body: JSON.stringify(input),
  });
  return hermesCorpusMutationSchema.parse(await parsedResponse(response));
}

/**
 * What agents have learned about the signed-in person.
 *
 * Scoped server-side to the caller's own subject, so this asks "what do you
 * know about me" without needing an administrator or a new enterprise scope.
 */
/** What the enrolled Hermes runtime reports it can do. Discovery only. */
/** Which runtime toolsets this installation permits. Empty means none. */
export async function getToolsetAdmissions(): Promise<ToolsetAdmissionList> {
  const response = await fetch("/api/v1/admin/tooling/toolsets", { credentials: "same-origin" });
  return toolsetAdmissionListSchema.parse(await parsedResponse(response));
}

export async function decideToolsetAdmission(
  toolsetName: string,
  admitted: boolean,
  reason: string,
): Promise<ToolsetAdmission> {
  const response = await fetch(
    `/api/v1/admin/tooling/toolsets/${encodeURIComponent(toolsetName)}`,
    {
      method: "PUT",
      headers: adminHeaders(),
      credentials: "same-origin",
      body: JSON.stringify({ admitted, reason }),
    },
  );
  return toolsetAdmissionSchema.parse(await parsedResponse(response));
}

export async function getRuntimeCatalogue(): Promise<HermesRuntimeCatalogue> {
  const response = await fetch("/api/v1/admin/agents/runtime/catalogue", { credentials: "same-origin" });
  return hermesRuntimeCatalogueSchema.parse(await parsedResponse(response));
}

/**
 * "Forget everything about X" — previewed by default.
 *
 * `dryRun` is the caller's decision because the preview and the commit are the
 * same request; the server defaults it to true, so an omitted flag previews.
 */
