import {
  connectionTestResultSchema,
  administratorSessionSchema,
  configurationRevisionListSchema,
  jobActionResultSchema,
  jobOperationsSnapshotSchema,
  jobProbeResultSchema,
  platformMetaSchema,
  serviceConnectionListSchema,
  serviceConnectionSummarySchema,
  rollbackConfigurationResultSchema,
  chatConversationListSchema,
  chatConversationSchema,
  chatConversationSummarySchema,
  chatStreamEventSchema,
  chatFeedbackSchema,
  chatMetricsSchema,
  enterpriseSessionSchema,
  oidcStatusSchema,
  type AdministratorSession,
  type CreateServiceConnection,
  type ConnectionTestResult,
  type ConfigurationRevisionList,
  type JobActionResult,
  type JobOperationsSnapshot,
  type JobProbeResult,
  type PlatformMeta,
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
  type EnterpriseSession,
  type OidcStatus,
  type CreateChatConversation,
  type UpdateChatConversation,
  type UpdateServiceConnection,
  documentListSchema,
  documentDetailSchema,
  documentMetricsSchema,
  type DocumentList,
  type DocumentDetail,
  type DocumentMetrics,
  type DocumentClassification,
  type QuarantineDecision,
  memoryPublicationListSchema,
  memoryMetricsSchema,
  type MemoryPublicationList,
  type MemoryMetrics,
  agentProfileListSchema,
  agentProfileSchema,
  agentRunListSchema,
  agentRunSchema,
  agentRuntimeControlSchema,
  agentMetricsSchema,
  type AgentProfile,
  type AgentProfileList,
  type AgentRun,
  type AgentRunList,
  type AgentRuntimeControl,
  type AgentMetrics,
  type CreateAgentProfile,
  type UpdateAgentProfile,
  governedToolListSchema,
  toolGrantListSchema,
  toolGrantSchema,
  gatewayCredentialListSchema,
  issuedGatewayCredentialSchema,
  toolCallListSchema,
  toolApprovalListSchema,
  toolApprovalSchema,
  toolRuntimeControlSchema,
  toolMetricsSchema,
  type GovernedToolList,
  type ToolGrant,
  type ToolGrantList,
  type GatewayCredentialList,
  type IssuedGatewayCredential,
  type ToolCallList,
  type ToolApproval,
  type ToolApprovalList,
  type ToolRuntimeControl,
  type ToolMetrics,
  type UpsertToolGrant,
  type ToolStatus,
  type UpdateToolRuntimeControl,
  aiOpsOverviewSchema,
  operationalIncidentListSchema,
  operationalIncidentSchema,
  evaluationRunListSchema,
  evaluationRunSchema,
  productionReadinessSchema,
  productionReadinessControlSchema,
  productionReadinessApprovalSchema,
  type AiOpsOverview,
  type OperationalIncident,
  type OperationalIncidentList,
  type CreateOperationalIncident,
  type IncidentDecision,
  type EvaluationRun,
  type EvaluationRunList,
  type CreateEvaluationRun,
  type CompleteEvaluationRun,
  type ProductionReadiness,
  type ProductionReadinessControl,
  type ProductionReadinessApproval,
  type UpdateProductionReadinessControl,
  type RecordProductionReadinessApproval,
} from "@aihub/contracts";

export class AIHubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AIHubApiError";
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
        throw new AIHubApiError(response.status, "AIHub returned an invalid response.");
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
    throw new AIHubApiError(
      response.status,
      message ?? `AIHub API returned ${response.status} ${response.statusText}`.trim(),
    );
  }
  return body;
}

function adminHeaders(): HeadersInit {
  return {
    "content-type": "application/json",
  };
}

export async function createAdministratorSession(token: string): Promise<AdministratorSession> {
  const response = await fetch("/api/v1/admin/session/bootstrap", {
    method: "POST",
    headers: adminHeaders(),
    credentials: "same-origin",
    body: JSON.stringify({ token }),
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

export async function getConnections(): Promise<ServiceConnectionList> {
  const response = await fetch("/api/v1/admin/connections", {
    credentials: "same-origin",
  });
  return serviceConnectionListSchema.parse(await parsedResponse(response));
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
    headers: adminHeaders(),
    credentials: "same-origin",
  });
  return connectionTestResultSchema.parse(await parsedResponse(response));
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

export async function getJobOperations(): Promise<JobOperationsSnapshot> {
  const response = await fetch("/api/v1/admin/operations/jobs", {
    credentials: "same-origin",
  });
  return jobOperationsSnapshotSchema.parse(await parsedResponse(response));
}

export async function sendSystemProbe(): Promise<JobProbeResult> {
  const response = await fetch("/api/v1/admin/operations/jobs/probe", {
    method: "POST",
    headers: adminHeaders(),
    credentials: "same-origin",
  });
  return jobProbeResultSchema.parse(await parsedResponse(response));
}

export async function redriveDeadLetters(
  limit = 100,
): Promise<JobActionResult> {
  const response = await fetch("/api/v1/admin/operations/jobs/dead-letter/redrive", {
    method: "POST",
    headers: adminHeaders(),
    credentials: "same-origin",
    body: JSON.stringify({ limit }),
  });
  return jobActionResultSchema.parse(await parsedResponse(response));
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

export async function streamChatMessage(
  conversationId: string,
  content: string,
  onEvent: (event: ChatStreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(
    `/api/v1/chat/conversations/${encodeURIComponent(conversationId)}/messages`,
    {
      method: "POST",
      headers: adminHeaders(),
      credentials: "same-origin",
      signal,
      body: JSON.stringify({ content }),
    },
  );
  if (!response.ok) {
    await parsedResponse(response);
    return;
  }
  if (!response.body) {
    throw new AIHubApiError(response.status, "AIHub returned no chat response stream.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const consumeFrame = (frame: string) => {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return;
    onEvent(chatStreamEventSchema.parse(JSON.parse(data) as unknown));
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";
    for (const frame of frames) consumeFrame(frame);
    if (done) break;
  }
  if (buffer.trim()) consumeFrame(buffer);
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

export async function getDocuments(): Promise<DocumentList> {
  const response = await fetch("/api/v1/documents", { credentials: "same-origin" });
  return documentListSchema.parse(await parsedResponse(response));
}

export async function getDocument(id: string): Promise<DocumentDetail> {
  const response = await fetch(`/api/v1/documents/${encodeURIComponent(id)}`, {
    credentials: "same-origin",
  });
  return documentDetailSchema.parse(await parsedResponse(response));
}

export async function uploadDocument(
  file: File,
  classification: DocumentClassification,
  retentionDays: number,
): Promise<DocumentDetail> {
  const body = new FormData();
  body.append("file", file, file.name);
  const query = new URLSearchParams({ classification, retentionDays: String(retentionDays) });
  const response = await fetch(`/api/v1/documents?${query}`, {
    method: "POST",
    credentials: "same-origin",
    body,
  });
  return documentDetailSchema.parse(await parsedResponse(response));
}

export async function decideDocumentQuarantine(
  id: string,
  decision: QuarantineDecision,
): Promise<DocumentDetail> {
  const response = await fetch(
    `/api/v1/documents/${encodeURIComponent(id)}/quarantine-decision`,
    {
      method: "POST",
      headers: adminHeaders(),
      credentials: "same-origin",
      body: JSON.stringify(decision),
    },
  );
  return documentDetailSchema.parse(await parsedResponse(response));
}

export async function reprocessDocument(id: string): Promise<DocumentDetail> {
  const response = await fetch(`/api/v1/documents/${encodeURIComponent(id)}/reprocess`, {
    method: "POST",
    headers: adminHeaders(),
    credentials: "same-origin",
  });
  return documentDetailSchema.parse(await parsedResponse(response));
}

export async function deleteDocument(
  id: string,
  force = false,
  reason?: string,
): Promise<void> {
  const query = new URLSearchParams({
    ...(force ? { force: "true" } : {}),
    ...(reason ? { reason } : {}),
  });
  const response = await fetch(
    `/api/v1/documents/${encodeURIComponent(id)}${query.size ? `?${query}` : ""}`,
    { method: "DELETE", credentials: "same-origin" },
  );
  if (!response.ok) await parsedResponse(response);
}

export async function getDocumentMetrics(): Promise<DocumentMetrics> {
  const response = await fetch("/api/v1/documents/metrics", { credentials: "same-origin" });
  return documentMetricsSchema.parse(await parsedResponse(response));
}

export async function getMemoryPublications(): Promise<MemoryPublicationList> {
  const response = await fetch("/api/v1/admin/memory/publications", { credentials: "same-origin" });
  return memoryPublicationListSchema.parse(await parsedResponse(response));
}

export async function getMemoryMetrics(): Promise<MemoryMetrics> {
  const response = await fetch("/api/v1/admin/memory/metrics", { credentials: "same-origin" });
  return memoryMetricsSchema.parse(await parsedResponse(response));
}

export async function reindexMemoryDocument(documentId: string): Promise<JobActionResult> {
  const response = await fetch(
    `/api/v1/admin/memory/documents/${encodeURIComponent(documentId)}/reindex`,
    { method: "POST", headers: adminHeaders(), credentials: "same-origin" },
  );
  return jobActionResultSchema.parse(await parsedResponse(response));
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

export async function setAgentProfileState(id: string, action: "activate" | "suspend"): Promise<AgentProfile> {
  const response = await fetch(`/api/v1/admin/agents/profiles/${encodeURIComponent(id)}/${action}`, {
    method: "POST", headers: adminHeaders(), credentials: "same-origin",
  });
  return agentProfileSchema.parse(await parsedResponse(response));
}

export async function getAgentRuns(administrator: boolean): Promise<AgentRunList> {
  const path = administrator ? "/api/v1/admin/agents/runs" : "/api/v1/agents/runs";
  const response = await fetch(path, { credentials: "same-origin" });
  return agentRunListSchema.parse(await parsedResponse(response));
}

export async function submitAgentRun(profileId: string, input: string): Promise<AgentRun> {
  const response = await fetch("/api/v1/agents/runs", {
    method: "POST", headers: adminHeaders(), credentials: "same-origin", body: JSON.stringify({ profileId, input }),
  });
  return agentRunSchema.parse(await parsedResponse(response));
}

export async function cancelAgentRun(runId: string, administrator: boolean): Promise<AgentRun> {
  const prefix = administrator ? "/api/v1/admin/agents" : "/api/v1/agents";
  const response = await fetch(`${prefix}/runs/${encodeURIComponent(runId)}/cancel`, {
    method: "POST", headers: adminHeaders(), credentials: "same-origin",
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
    method: "DELETE", headers: adminHeaders(), credentials: "same-origin",
  });
  if (!response.ok) await parsedResponse(response);
}

export async function getToolCalls(): Promise<ToolCallList> {
  const response = await fetch("/api/v1/admin/tooling/calls", { credentials: "same-origin" });
  return toolCallListSchema.parse(await parsedResponse(response));
}

export async function getToolApprovals(): Promise<ToolApprovalList> {
  const response = await fetch("/api/v1/admin/tooling/approvals", { credentials: "same-origin" });
  return toolApprovalListSchema.parse(await parsedResponse(response));
}

export async function decideToolApproval(id: string, decision: "APPROVE" | "REJECT", reason: string): Promise<ToolApproval> {
  const response = await fetch(`/api/v1/admin/tooling/approvals/${encodeURIComponent(id)}/decision`, {
    method: "POST", headers: adminHeaders(), credentials: "same-origin", body: JSON.stringify({ decision, reason }),
  });
  return toolApprovalSchema.parse(await parsedResponse(response));
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

export async function getEvaluationRuns(): Promise<EvaluationRunList> {
  const response = await fetch("/api/v1/admin/operations/evaluations", { credentials: "same-origin" });
  return evaluationRunListSchema.parse(await parsedResponse(response));
}

export async function createEvaluationRun(input: CreateEvaluationRun): Promise<EvaluationRun> {
  const response = await fetch("/api/v1/admin/operations/evaluations", {
    method: "POST", headers: adminHeaders(), credentials: "same-origin", body: JSON.stringify(input),
  });
  return evaluationRunSchema.parse(await parsedResponse(response));
}

export async function completeEvaluationRun(id: string, input: CompleteEvaluationRun): Promise<EvaluationRun> {
  const response = await fetch(`/api/v1/admin/operations/evaluations/${encodeURIComponent(id)}/complete`, {
    method: "POST", headers: adminHeaders(), credentials: "same-origin", body: JSON.stringify(input),
  });
  return evaluationRunSchema.parse(await parsedResponse(response));
}

export async function promoteEvaluationRun(id: string, reason: string): Promise<EvaluationRun> {
  const response = await fetch(`/api/v1/admin/operations/evaluations/${encodeURIComponent(id)}/promote`, {
    method: "POST", headers: adminHeaders(), credentials: "same-origin",
    body: JSON.stringify({ reason }),
  });
  return evaluationRunSchema.parse(await parsedResponse(response));
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
