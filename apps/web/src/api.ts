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
  type UpdateServiceConnection,
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
