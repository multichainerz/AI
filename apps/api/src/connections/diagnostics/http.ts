import type { AdapterOutcome, ResolvedConnection } from "./types.js";

export class ResponseBodyTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`Response body exceeded ${limitBytes} bytes.`);
    this.name = "ResponseBodyTooLargeError";
  }
}

/**
 * Parse one JSON response without trusting Content-Length to be present or
 * truthful. The limit is enforced while bytes are read, so chunked responses
 * cannot be buffered without bound before validation runs.
 */
export async function boundedJsonResponse(response: Response, limitBytes: number): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > limitBytes) {
      throw new ResponseBodyTooLargeError(limitBytes);
    }
  }

  const reader = response.body?.getReader();
  if (!reader) return JSON.parse("");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limitBytes) throw new ResponseBodyTooLargeError(limitBytes);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined));
}

export function stringConfiguration(
  connection: ResolvedConnection,
  name: string,
): string | undefined {
  const value = connection.configuration[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/*
 * Cloud instance-metadata services, which are never an inference server.
 *
 * The deliberate non-rule here: RFC1918 and loopback are *not* blocked. This is
 * a self-hosted product whose inference server normally is on a private
 * network — the dashboard's own placeholder is `http://gpu-server.internal:8000`
 * and a single-box install runs vLLM on localhost — so refusing private
 * destinations would block the primary use case rather than an attack. The
 * link-local range is different: 169.254.169.254 and its siblings serve cloud
 * credentials and cannot be a legitimate target of a connection test, so it is
 * the one range where blocking costs nothing and prevents an operator-supplied
 * URL from turning a diagnostic into a credential read.
 */
const LINK_LOCAL_IPV4 = /^169\.254(?:\.\d{1,3}){2}$/;
const LINK_LOCAL_IPV6 = /^fe[89ab][0-9a-f]:/i;

function assertRoutableDestination(host: string): void {
  const bare = host.replace(/^\[|\]$/g, "");
  if (LINK_LOCAL_IPV4.test(bare) || LINK_LOCAL_IPV6.test(bare)) {
    throw new Error("Connection endpoint must not target a link-local metadata address.");
  }
}

export function endpointUrl(baseUrl: string | null, path: string): URL {
  if (!baseUrl) throw new Error("Connection endpoint URL is not configured.");
  const base = new URL(baseUrl);
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new Error("Connection endpoint must use HTTP or HTTPS.");
  }
  if (base.username || base.password) {
    throw new Error("Connection endpoint must not contain credentials.");
  }
  assertRoutableDestination(base.hostname);

  const endpoint = new URL(path, `${base.origin}/`);
  if (endpoint.origin !== base.origin) throw new Error("Health path must remain on the service origin.");
  return endpoint;
}

export function bearerHeaders(connection: ResolvedConnection): Record<string, string> {
  const apiKey = connection.secrets.apiKey ?? connection.secrets.bearerToken;
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

export async function healthFetch(
  connection: ResolvedConnection,
  path: string,
  signal: AbortSignal,
): Promise<Response> {
  return fetch(endpointUrl(connection.baseUrl, path), {
    method: "GET",
    headers: bearerHeaders(connection),
    redirect: "error",
    signal,
  });
}

export function failedHttpOutcome(service: string, response: Response): AdapterOutcome {
  if (response.status === 401 || response.status === 403) {
    return {
      status: "DEGRADED",
      message: `${service} is reachable but rejected the configured credential (${response.status}).`,
      details: { httpStatus: response.status, authentication: "rejected" },
    };
  }

  return {
    status: "DEGRADED",
    message: `${service} returned HTTP ${response.status} during validation.`,
    details: { httpStatus: response.status },
  };
}
