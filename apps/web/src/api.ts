import {
  chatArtifactListSchema,
  chatArtifactSchema,
  type ChatArtifact,
  type ChatArtifactList,
  type UploadChatArtifact,
  auditEventListSchema,
  usageReportSchema,
  type UsageReport,
  type UsageWindow,
  connectionTestResultSchema,
  connectionMonitoringControlSchema,
  inferenceCatalogueResultSchema,
  inferenceDiscoveryResultSchema,
  administratorSessionSchema,
  configurationRevisionListSchema,
  platformMetaSchema,
  platformReleaseTargetSchema,
  platformUpdateActivitySchema,
  platformUpdateSchema,
  serviceConnectionListSchema,
  serviceConnectionSummarySchema,
  rollbackConfigurationResultSchema,
  chatConversationListSchema,
  chatConversationSchema,
  chatConversationSummarySchema,
  chatMessageSubmissionSchema,
  chatStreamEventSchema,
  chatScheduleSchema,
  chatScheduleListSchema,
  agentRunApprovalSchema,
  chatMetricsSchema,
  enterpriseSessionSchema,
  type AdministratorSession,
  type AuditEventList,
  type AuditEventQuery,
  type CreateServiceConnection,
  type ConnectionTestResult,
  type ConnectionMonitoringControl,
  type InferenceCatalogueRequest,
  type InferenceCatalogueResult,
  type InferenceDiscoveryRequest,
  type InferenceDiscoveryResult,
  type UpdateConnectionMonitoringControl,
  type ConfigurationRevisionList,
  type ApproveReleaseTarget,
  type PlatformMeta,
  type PlatformReleaseTarget,
  type PlatformUpdate,
  type PlatformUpdateActivity,
  type ServiceConnectionList,
  type ServiceConnectionSummary,
  type RollbackConfigurationResult,
  type ChatConversation,
  type ChatConversationList,
  type ChatConversationSummary,
  type ChatStreamEvent,
  type ChatMetrics,
  type ChatMessageSubmission,
  type AgentRunApproval,
  type DecideAgentRunApproval,
  type ForkChatConversation,
  type EnterpriseSession,
  type CreateChatConversation,
  type UpdateChatConversation,
  type ChatSchedule,
  type ChatScheduleList,
  type CreateChatSchedule,
  type UpdateChatSchedule,
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
  toolsetAdmissionListSchema,
  toolsetAdmissionSchema,
  toolRuntimeControlSchema,
  toolMetricsSchema,
  type GovernedToolList,
  type ToolsetAdmission,
  type ToolsetAdmissionList,
  type ToolRuntimeControl,
  type ToolMetrics,
  type UpdateToolRuntimeControl,
  aiOpsOverviewSchema,
  operationalIncidentListSchema,
  operationalIncidentSchema,
  productionReadinessControlSchema,
  productionReadinessApprovalSchema,
  type AiOpsOverview,
  type OperationalIncident,
  type OperationalIncidentList,
  type CreateOperationalIncident,
  type IncidentDecision,
  type ProductionReadinessControl,
  type ProductionReadinessApproval,
  type UpdateProductionReadinessControl,
  type RecordProductionReadinessApproval,
  modelDeploymentListSchema,
  modelDeploymentSchema,
  modelObservationListSchema,
  modelRefreshResultSchema,
  type ModelDeployment,
  type ModelDeploymentList,
  type ModelObservationList,
  type ModelRefreshResult,
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
  hermesRuntimeCatalogueSchema,
  type HermesRuntimeCatalogue,
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
  divisionListSchema,
  divisionSchema,
  type CreateDivision,
  type Division,
  type DivisionList,
  type UpdateDivision,
  skillSetListSchema,
  skillSetSchema,
  toolSetListSchema,
  toolSetSchema,
  type CreateSkillSet,
  type CreateToolSet,
  type SkillSet,
  type SkillSetList,
  type ToolSet,
  type ToolSetList,
  type UpdateSkillSet,
  type UpdateToolSet,
  personListSchema,
  personSchema,
  type CreatePerson,
  type Person,
  type PersonList,
  type UpdatePerson,
  scopedMemoryEntrySchema,
  scopedMemoryListSchema,
  type CreateScopedMemory,
  type ScopedMemoryEntry,
  type ScopedMemoryList,
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

/**
 * Sign in a person created under Settings → Access.
 *
 * The login route only returns a display name; the cookie it sets is what
 * `GET /api/v1/session` reads. Two calls, one identity.
 */
export async function createLocalPersonSession(username: string, password: string): Promise<EnterpriseSession> {
  const response = await fetch("/api/v1/auth/local/login", {
    method: "POST",
    headers: adminHeaders(),
    credentials: "same-origin",
    body: JSON.stringify({ username, password }),
  });
  await parsedResponse(response);
  return getEnterpriseSession();
}

export async function changeLocalPersonPassword(
  currentPassword: string,
  newPassword: string,
): Promise<EnterpriseSession> {
  const response = await fetch("/api/v1/auth/local/password", {
    method: "PUT",
    headers: adminHeaders(),
    credentials: "same-origin",
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  return enterpriseSessionSchema.parse(await parsedResponse(response));
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

/**
 * What the VM1 update agent has been doing, including the installer log.
 *
 * Apart from `getPlatformUpdate` because that one reaches GitHub and this reads
 * two local rows. An operator watching an upgrade land polls this while the
 * deployment is least able to make an outbound request, and a combined call
 * would make the local answer depend on the remote one.
 */
export async function getPlatformUpdateActivity(): Promise<PlatformUpdateActivity> {
  const response = await fetch("/api/v1/admin/updates/activity", {
    credentials: "same-origin",
    cache: "no-store",
  });
  return platformUpdateActivitySchema.parse(await parsedResponse(response));
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

export async function loadInferenceCatalogue(
  input: InferenceCatalogueRequest,
): Promise<InferenceCatalogueResult> {
  const response = await fetch("/api/v1/admin/connections/inference/catalogue", {
    method: "POST",
    headers: adminHeaders(),
    credentials: "same-origin",
    body: JSON.stringify(input),
  });
  return inferenceCatalogueResultSchema.parse(await parsedResponse(response));
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

export async function getChatArtifacts(filter: { conversationId?: string } = {}): Promise<ChatArtifactList> {
  const query = filter.conversationId ? `?conversationId=${encodeURIComponent(filter.conversationId)}` : "";
  const response = await fetch(`/api/v1/chat/artifacts${query}`, {
    credentials: "same-origin",
  });
  return chatArtifactListSchema.parse(await parsedResponse(response));
}

/**
 * The download is a navigation, not a fetch: the route answers with
 * Content-Disposition attachment and forced octet-stream, so handing the URL
 * to an anchor is what makes the browser save instead of render.
 */
export function chatArtifactContentUrl(artifactId: string): string {
  return `/api/v1/chat/artifacts/${encodeURIComponent(artifactId)}/content`;
}

/** A person's file from the composer, stored inline and labelled UPLOADED. */
export async function uploadChatArtifact(input: UploadChatArtifact): Promise<ChatArtifact> {
  const response = await fetch("/api/v1/chat/artifacts/uploads", {
    method: "POST",
    headers: adminHeaders(),
    credentials: "same-origin",
    body: JSON.stringify(input),
  });
  return chatArtifactSchema.parse(await parsedResponse(response));
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

export async function getChatSchedules(conversationId: string): Promise<ChatScheduleList> {
  const response = await fetch(
    `/api/v1/chat/conversations/${encodeURIComponent(conversationId)}/schedules`,
    { credentials: "same-origin" },
  );
  return chatScheduleListSchema.parse(await parsedResponse(response));
}

export async function createChatSchedule(
  conversationId: string,
  input: CreateChatSchedule,
): Promise<ChatSchedule> {
  const response = await fetch(
    `/api/v1/chat/conversations/${encodeURIComponent(conversationId)}/schedules`,
    {
      method: "POST",
      headers: adminHeaders(),
      credentials: "same-origin",
      body: JSON.stringify(input),
    },
  );
  return chatScheduleSchema.parse(await parsedResponse(response));
}

export async function updateChatSchedule(
  scheduleId: string,
  input: UpdateChatSchedule,
): Promise<ChatSchedule> {
  const response = await fetch(`/api/v1/chat/schedules/${encodeURIComponent(scheduleId)}`, {
    method: "PATCH",
    headers: adminHeaders(),
    credentials: "same-origin",
    body: JSON.stringify(input),
  });
  return chatScheduleSchema.parse(await parsedResponse(response));
}

export async function deleteChatSchedule(scheduleId: string): Promise<void> {
  const response = await fetch(`/api/v1/chat/schedules/${encodeURIComponent(scheduleId)}`, {
    method: "DELETE",
    credentials: "same-origin",
  });
  if (!response.ok) await parsedResponse(response);
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

export async function updateAgentRuntime(
  enabled: boolean,
  reason: string,
  memoryExtractionEnabled?: boolean,
): Promise<AgentRuntimeControl> {
  const response = await fetch("/api/v1/admin/agents/runtime", {
    method: "PATCH", headers: adminHeaders(), credentials: "same-origin",
    // Omitted when undefined, so starting or stopping execution never silently
    // changes whether the deployment reads its own conversations.
    body: JSON.stringify({ enabled, reason, ...(memoryExtractionEnabled === undefined ? {} : { memoryExtractionEnabled }) }),
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

export async function getModelObservations(connectionId: string): Promise<ModelObservationList> {
  const response = await fetch(
    `/api/v1/admin/models/observations?connectionId=${encodeURIComponent(connectionId)}`,
    { credentials: "same-origin" },
  );
  return modelObservationListSchema.parse(await parsedResponse(response));
}

export async function refreshConnectionModels(connectionId: string): Promise<ModelRefreshResult> {
  const response = await fetch(
    `/api/v1/admin/connections/${encodeURIComponent(connectionId)}/models/refresh`,
    { method: "POST", credentials: "same-origin" },
  );
  return modelRefreshResultSchema.parse(await parsedResponse(response));
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

export async function getGovernedTools(): Promise<GovernedToolList> {
  const response = await fetch("/api/v1/admin/tooling/tools", { credentials: "same-origin" });
  return governedToolListSchema.parse(await parsedResponse(response));
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


/**
 * What the governed inference path consumed over one window.
 *
 * `byUser` comes back null rather than empty when the session lacks
 * `audit:read`; the view draws a refusal in that panel rather than an empty
 * table, because "you may not see this" and "nobody used it" are different
 * answers.
 */
export async function getGatewayUsage(window: UsageWindow): Promise<UsageReport> {
  const search = new URLSearchParams({ window });
  const response = await fetch(`/api/v1/admin/gateway/usage?${search.toString()}`, {
    credentials: "same-origin",
  });
  return usageReportSchema.parse(await parsedResponse(response));
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

/*
 * Divisions.
 *
 * A division bounds which agent profiles a user may see and run. Reads sit
 * behind `agents:read` and writes behind `agents:manage`: no new scope, because
 * a division decides which profiles a user reaches, which is the decision the
 * Agents screens already make.
 */
export async function getDivisions(includeSuspended = true): Promise<DivisionList> {
  const response = await fetch(`/api/v1/admin/divisions?includeSuspended=${includeSuspended ? "true" : "false"}`, {
    credentials: "same-origin",
  });
  return divisionListSchema.parse(await parsedResponse(response));
}

export async function createDivision(input: CreateDivision): Promise<Division> {
  const response = await fetch("/api/v1/admin/divisions", {
    method: "POST",
    headers: adminHeaders(),
    credentials: "same-origin",
    body: JSON.stringify(input),
  });
  return divisionSchema.parse(await parsedResponse(response));
}

export async function updateDivision(id: string, input: UpdateDivision): Promise<Division> {
  const response = await fetch(`/api/v1/admin/divisions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: adminHeaders(),
    credentials: "same-origin",
    body: JSON.stringify(input),
  });
  return divisionSchema.parse(await parsedResponse(response));
}

export async function deleteDivision(id: string): Promise<void> {
  const response = await fetch(`/api/v1/admin/divisions/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "same-origin",
  });
  if (!response.ok) await parsedResponse(response);
}

export async function assignProfileDivision(
  profileId: string,
  divisionId: string | null,
  expectedRevision: number,
): Promise<void> {
  const response = await fetch(`/api/v1/admin/divisions/profiles/${encodeURIComponent(profileId)}`, {
    method: "PUT",
    headers: adminHeaders(),
    credentials: "same-origin",
    body: JSON.stringify({ divisionId, expectedRevision }),
  });
  if (!response.ok) await parsedResponse(response);
}

export async function getToolSets(): Promise<ToolSetList> {
  const response = await fetch("/api/v1/admin/configuration/tool-sets", { credentials: "same-origin" });
  return toolSetListSchema.parse(await parsedResponse(response));
}

export async function getSkillSets(): Promise<SkillSetList> {
  const response = await fetch("/api/v1/admin/configuration/skill-sets", { credentials: "same-origin" });
  return skillSetListSchema.parse(await parsedResponse(response));
}

export async function createToolSet(input: CreateToolSet): Promise<ToolSet> {
  const response = await fetch("/api/v1/admin/configuration/tool-sets", {
    method: "POST", headers: adminHeaders(), credentials: "same-origin", body: JSON.stringify(input),
  });
  return toolSetSchema.parse(await parsedResponse(response));
}

export async function updateToolSet(id: string, input: UpdateToolSet): Promise<ToolSet> {
  const response = await fetch(`/api/v1/admin/configuration/tool-sets/${encodeURIComponent(id)}`, {
    method: "PATCH", headers: adminHeaders(), credentials: "same-origin", body: JSON.stringify(input),
  });
  return toolSetSchema.parse(await parsedResponse(response));
}

export async function deleteToolSet(id: string): Promise<void> {
  const response = await fetch(`/api/v1/admin/configuration/tool-sets/${encodeURIComponent(id)}`, {
    method: "DELETE", credentials: "same-origin",
  });
  if (!response.ok) await parsedResponse(response);
}

export async function createSkillSet(input: CreateSkillSet): Promise<SkillSet> {
  const response = await fetch("/api/v1/admin/configuration/skill-sets", {
    method: "POST", headers: adminHeaders(), credentials: "same-origin", body: JSON.stringify(input),
  });
  return skillSetSchema.parse(await parsedResponse(response));
}

export async function updateSkillSet(id: string, input: UpdateSkillSet): Promise<SkillSet> {
  const response = await fetch(`/api/v1/admin/configuration/skill-sets/${encodeURIComponent(id)}`, {
    method: "PATCH", headers: adminHeaders(), credentials: "same-origin", body: JSON.stringify(input),
  });
  return skillSetSchema.parse(await parsedResponse(response));
}

export async function deleteSkillSet(id: string): Promise<void> {
  const response = await fetch(`/api/v1/admin/configuration/skill-sets/${encodeURIComponent(id)}`, {
    method: "DELETE", credentials: "same-origin",
  });
  if (!response.ok) await parsedResponse(response);
}

export async function getPeople(): Promise<PersonList> {
  const response = await fetch("/api/v1/admin/people", { credentials: "same-origin" });
  return personListSchema.parse(await parsedResponse(response));
}

export async function createPerson(input: CreatePerson): Promise<Person> {
  const response = await fetch("/api/v1/admin/people", {
    method: "POST", headers: adminHeaders(), credentials: "same-origin", body: JSON.stringify(input),
  });
  return personSchema.parse(await parsedResponse(response));
}

export async function updatePerson(id: string, input: UpdatePerson): Promise<Person> {
  const response = await fetch(`/api/v1/admin/people/${encodeURIComponent(id)}`, {
    method: "PATCH", headers: adminHeaders(), credentials: "same-origin", body: JSON.stringify(input),
  });
  return personSchema.parse(await parsedResponse(response));
}

export async function resetPersonPassword(id: string, password: string): Promise<void> {
  const response = await fetch(`/api/v1/admin/people/${encodeURIComponent(id)}/password`, {
    method: "POST", headers: adminHeaders(), credentials: "same-origin", body: JSON.stringify({ password }),
  });
  if (!response.ok) await parsedResponse(response);
}

export async function getScopedMemory(): Promise<ScopedMemoryList> {
  const response = await fetch("/api/v1/admin/tooling/scoped-memory", { credentials: "same-origin" });
  return scopedMemoryListSchema.parse(await parsedResponse(response));
}

export async function deleteScopedMemory(entryId: string): Promise<void> {
  const response = await fetch(`/api/v1/admin/tooling/scoped-memory/${entryId}`, {
    method: "DELETE", headers: adminHeaders(), credentials: "same-origin",
  });
  if (!response.ok) await parsedResponse(response);
}

export async function createScopedMemory(input: CreateScopedMemory): Promise<ScopedMemoryEntry> {
  const response = await fetch("/api/v1/admin/tooling/scoped-memory", {
    method: "POST", headers: adminHeaders(), credentials: "same-origin", body: JSON.stringify(input),
  });
  return scopedMemoryEntrySchema.parse(await parsedResponse(response));
}
