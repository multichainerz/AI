import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import type { PrismaRuntimeConnectionResolver, RuntimeConnection } from "./connection-resolver.js";

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

function stringSetting(connection: RuntimeConnection, name: string, fallback: string): string {
  const value = connection.configuration[name];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function numberSetting(
  connection: RuntimeConnection,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = connection.configuration[name];
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function endpoint(connection: RuntimeConnection, path: string): URL {
  const base = new URL(connection.baseUrl);
  const url = new URL(path, `${connection.baseUrl.replace(/\/+$/, "")}/`);
  if (url.origin !== base.origin) throw new Error("Supermemory request paths must remain on the configured origin.");
  return url;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("Supermemory response is too large.");
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Supermemory response is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (joined.byteLength === 0) return null;
  try {
    return JSON.parse(new TextDecoder().decode(joined)) as unknown;
  } catch {
    throw new Error("Supermemory returned invalid JSON.");
  }
}

export const SHARED_KNOWLEDGE_CONTAINER_TAG = "orcasynapse-knowledge";

export function knowledgeScopeTag(ownerSubject: string): string {
  const digest = createHash("sha256").update(ownerSubject).digest("hex").slice(0, 24);
  return `${SHARED_KNOWLEDGE_CONTAINER_TAG}-${digest}`;
}

export function agentMemoryContainerTag(identity: string): string {
  const normalized = identity.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
  if (!normalized) throw new Error("Agent memory identity must contain a supported character.");
  return `orcasynapse-agent-${normalized}`;
}

export function knowledgeDocumentCustomId(documentId: string): string {
  return `orcasynapse_doc_${documentId.replaceAll("-", "")}`;
}

export interface SupermemoryFileUploadInput {
  documentId: string;
  ownerSubject: string;
  stream: Readable;
  fileName: string;
  mediaType: string;
  classification: string;
  maximumBytes: number;
}

export interface SupermemoryFileUploadResult {
  externalDocumentId: string;
  status: string;
  sizeBytes: number;
  sha256: string;
}

export interface SupermemoryDocumentState {
  status: string;
  type: string | null;
  customId: string | null;
}

export class SupermemoryUploadTooLargeError extends Error {
  constructor() {
    super("The document exceeds the configured upload limit.");
    this.name = "SupermemoryUploadTooLargeError";
  }
}

export interface SupermemorySearchHit {
  externalDocumentId: string;
  score: number;
  title: string | null;
  metadata: Record<string, string | number | boolean>;
  chunks: Array<{ content: string; score: number }>;
}

export class SupermemoryClient {
  constructor(
    private readonly resolver: PrismaRuntimeConnectionResolver,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async uploadFile(input: SupermemoryFileUploadInput): Promise<SupermemoryFileUploadResult> {
    const connection = await this.resolver.resolveOne("SUPERMEMORY");
    const documentsPath = stringSetting(connection, "documentsPath", "/v3/documents").replace(/\/+$/, "");
    const boundary = `orcasynapse-${randomBytes(18).toString("hex")}`;
    const safeFileName = input.fileName.replace(/[\r\n"\\]/g, "_");
    const fields = [
      ["containerTag", knowledgeScopeTag(input.ownerSubject)],
      ["customId", knowledgeDocumentCustomId(input.documentId)],
      ["taskType", "superrag"],
      ["metadata", JSON.stringify({
        orcasynapseDocumentId: input.documentId,
        fileName: input.fileName,
        classification: input.classification,
        source: "orcasynapse",
      })],
    ] as const;
    const encoder = new TextEncoder();
    const hash = createHash("sha256");
    let sizeBytes = 0;
    const body = Readable.toWeb(Readable.from((async function* () {
      for (const [name, value] of fields) {
        yield encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
      }
      yield encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeFileName}"\r\nContent-Type: ${input.mediaType}\r\n\r\n`);
      for await (const value of input.stream) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
        sizeBytes += chunk.byteLength;
        if (sizeBytes > input.maximumBytes) throw new SupermemoryUploadTooLargeError();
        hash.update(chunk);
        yield chunk;
      }
      yield encoder.encode(`\r\n--${boundary}--\r\n`);
    })())) as ReadableStream<Uint8Array>;
    const url = endpoint(connection, `${documentsPath}/file`);
    const response = await this.request(connection, url, {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" }, "uploadTimeoutMs", 300_000);
    const externalDocumentId = response && typeof response === "object" && typeof (response as { id?: unknown }).id === "string"
      ? (response as { id: string }).id
      : null;
    if (!externalDocumentId) throw new Error("Supermemory did not return a document ID.");
    const status = typeof (response as { status?: unknown }).status === "string"
      ? (response as { status: string }).status
      : "queued";
    return { externalDocumentId, status, sizeBytes, sha256: hash.digest("hex") };
  }

  async documentState(externalDocumentId: string): Promise<SupermemoryDocumentState> {
    const connection = await this.resolver.resolveOne("SUPERMEMORY");
    const documentsPath = stringSetting(connection, "documentsPath", "/v3/documents");
    const body = await this.request(
      connection,
      endpoint(connection, `${documentsPath.replace(/\/+$/, "")}/${encodeURIComponent(externalDocumentId)}`),
      { method: "GET" },
    );
    const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
    return {
      status: typeof record.status === "string" ? record.status : "unknown",
      type: typeof record.type === "string" ? record.type : null,
      customId: typeof record.customId === "string" ? record.customId : null,
    };
  }

  async delete(documentId: string, externalDocumentId?: string | null): Promise<void> {
    const connection = await this.resolver.resolveOne("SUPERMEMORY");
    const documentsPath = stringSetting(connection, "documentsPath", "/v3/documents");
    const id = externalDocumentId || knowledgeDocumentCustomId(documentId);
    const url = endpoint(connection, `${documentsPath.replace(/\/+$/, "")}/${encodeURIComponent(id)}`);
    const response = await this.rawRequest(connection, url, { method: "DELETE" });
    if (response.status === 404 || response.status === 204 || response.ok) return;
    throw new Error(`Supermemory rejected document deletion with status ${response.status}.`);
  }

  async search(ownerSubject: string, query: string): Promise<SupermemorySearchHit[]> {
    const connection = await this.resolver.resolveOne("SUPERMEMORY");
    const searchPath = stringSetting(connection, "searchPath", "/v3/search");
    const limit = Math.trunc(numberSetting(connection, "retrievalLimit", 6, 2, 20));
    const threshold = numberSetting(connection, "retrievalThreshold", 0.25, 0, 1);
    const body = await this.request(connection, endpoint(connection, searchPath), {
      method: "POST",
      body: JSON.stringify({
        q: query,
        containerTag: knowledgeScopeTag(ownerSubject),
        limit,
        chunkThreshold: threshold,
        includeFullDocs: false,
        includeSummary: true,
        onlyMatchingChunks: true,
        rerank: false,
        rewriteQuery: false,
      }),
    });
    const results = body && typeof body === "object" && Array.isArray((body as { results?: unknown }).results)
      ? (body as { results: unknown[] }).results
      : [];
    return results.flatMap((candidate): SupermemorySearchHit[] => {
      if (!candidate || typeof candidate !== "object") return [];
      const item = candidate as Record<string, unknown>;
      if (typeof item.documentId !== "string" || typeof item.score !== "number") return [];
      const metadata = item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata)
        ? Object.fromEntries(Object.entries(item.metadata).filter((entry): entry is [string, string | number | boolean] =>
          ["string", "number", "boolean"].includes(typeof entry[1])))
        : {};
      const chunks = Array.isArray(item.chunks) ? item.chunks.flatMap((chunk): Array<{ content: string; score: number }> => {
        if (!chunk || typeof chunk !== "object") return [];
        const value = chunk as Record<string, unknown>;
        return typeof value.content === "string" && typeof value.score === "number"
          ? [{ content: value.content, score: value.score }]
          : [];
      }) : [];
      return [{
        externalDocumentId: item.documentId,
        score: Math.min(1, Math.max(0, item.score)),
        title: typeof item.title === "string" ? item.title : null,
        metadata,
        chunks,
      }];
    });
  }

  private async request(
    connection: RuntimeConnection,
    url: URL,
    init: RequestInit,
    timeoutSetting = "timeoutMs",
    timeoutFallback = 8_000,
  ): Promise<unknown> {
    const timeoutMs = numberSetting(connection, timeoutSetting, timeoutFallback, 1_000, 900_000);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetcher(url, this.requestInit(connection, init, controller.signal));
      const body = await boundedJson(response);
      if (!response.ok) throw new Error(`Supermemory rejected the request with status ${response.status}.`);
      return body;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async rawRequest(connection: RuntimeConnection, url: URL, init: RequestInit): Promise<Response> {
    const timeoutMs = numberSetting(connection, "timeoutMs", 8_000, 1_000, 30_000);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetcher(url, this.requestInit(connection, init, controller.signal));
    } finally {
      clearTimeout(timeout);
    }
  }

  private requestInit(connection: RuntimeConnection, init: RequestInit, signal: AbortSignal): RequestInit {
    return {
      ...init,
      redirect: "error",
      signal,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...(connection.secrets.apiKey ? { authorization: `Bearer ${connection.secrets.apiKey}` } : {}),
        ...init.headers,
      },
    };
  }
}
