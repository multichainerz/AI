import { healthFetch } from "./http.js";
import type {
  AdapterOutcome,
  ConnectionDiagnosticAdapter,
  ResolvedConnection,
} from "./types.js";

const MAX_OIDC_DISCOVERY_BYTES = 1_000_000;

class OidcDiscoveryTooLargeError extends Error {}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_OIDC_DISCOVERY_BYTES) {
    throw new OidcDiscoveryTooLargeError();
  }
  if (!response.body) return JSON.parse("");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_OIDC_DISCOVERY_BYTES) throw new OidcDiscoveryTooLargeError();
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined));
}

export class OidcAdapter implements ConnectionDiagnosticAdapter {
  async test(connection: ResolvedConnection, signal: AbortSignal): Promise<AdapterOutcome> {
    const response = await healthFetch(connection, "/.well-known/openid-configuration", signal);
    if (!response.ok) {
      return {
        status: "DEGRADED",
        message: `OIDC discovery returned HTTP ${response.status}.`,
        details: { httpStatus: response.status },
      };
    }

    let discovery: {
      issuer?: unknown;
      authorization_endpoint?: unknown;
      token_endpoint?: unknown;
    };
    try {
      discovery = (await boundedJson(response)) as typeof discovery;
    } catch (error) {
      if (error instanceof OidcDiscoveryTooLargeError) {
        return {
          status: "DEGRADED",
          message: "OIDC discovery exceeded the one-megabyte safety limit.",
          details: { discoveryValid: false, responseTooLarge: true },
        };
      }
      return {
        status: "DEGRADED",
        message: "OIDC discovery is reachable but returned an invalid document.",
        details: { discoveryValid: false },
      };
    }
    if (
      typeof discovery.issuer !== "string" ||
      typeof discovery.authorization_endpoint !== "string" ||
      typeof discovery.token_endpoint !== "string"
    ) {
      return {
        status: "DEGRADED",
        message: "OIDC discovery is reachable but incomplete.",
        details: { discoveryValid: false },
      };
    }

    return {
      status: "HEALTHY",
      message: "OIDC discovery is reachable and valid.",
      details: { issuer: discovery.issuer, discoveryValid: true },
    };
  }
}
