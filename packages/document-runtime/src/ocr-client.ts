import type { PrismaRuntimeConnectionResolver, RuntimeConnection } from "./connection-resolver.js";

const MAX_OCR_RESPONSE_BYTES = 10 * 1024 * 1024;

async function boundedResponseText(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_OCR_RESPONSE_BYTES) {
    throw new Error("OCR response is too large.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_OCR_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("OCR response is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const value = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    value.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(value);
}

function stringSetting(connection: RuntimeConnection, name: string, fallback: string): string {
  const value = connection.configuration[name];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function numberSetting(connection: RuntimeConnection, name: string, fallback: number): number {
  const value = connection.configuration[name];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export interface OcrPageResult {
  text: string;
  markdown: string;
  metadata: Record<string, unknown>;
}

export class UnlimitedOcrClient {
  constructor(
    private readonly resolver: PrismaRuntimeConnectionResolver,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async extract(image: Uint8Array, mediaType: string, signal?: AbortSignal): Promise<OcrPageResult> {
    const connection = await this.resolver.resolveOne("OCR");
    const model = stringSetting(connection, "modelAlias", "unlimited-ocr");
    const path = stringSetting(connection, "chatPath", "/v1/chat/completions");
    const endpoint = new URL(path, `${connection.baseUrl.replace(/\/+$/, "")}/`);
    if (endpoint.origin !== new URL(connection.baseUrl).origin) {
      throw new Error("OCR request path must remain on the configured origin.");
    }
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.min(600_000, Math.max(5_000, numberSetting(connection, "inferenceTimeoutMs", 180_000))),
    );
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await this.fetcher(endpoint, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(connection.secrets.apiKey ? { authorization: `Bearer ${connection.secrets.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [{
            role: "user",
            content: [
              { type: "text", text: "Extract all visible text faithfully. Return Markdown only; preserve headings, tables, reading order, and page structure. Do not summarize." },
              { type: "image_url", image_url: { url: `data:${mediaType};base64,${Buffer.from(image).toString("base64")}` } },
            ],
          }],
        }),
      });
      if (!response.ok) throw new Error(`OCR service rejected the page with status ${response.status}.`);
      const raw = await boundedResponseText(response);
      const body = JSON.parse(raw) as {
        id?: unknown;
        choices?: Array<{ message?: { content?: unknown } }>;
        usage?: Record<string, unknown>;
      };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.trim().length === 0) {
        throw new Error("OCR service returned no extracted content.");
      }
      return {
        text: content.replace(/[#*_`>|-]/g, " ").replace(/\s+/g, " ").trim(),
        markdown: content.trim(),
        metadata: {
          providerRequestId: typeof body.id === "string" ? body.id : null,
          model,
          usage: body.usage ?? {},
        },
      };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }
}
