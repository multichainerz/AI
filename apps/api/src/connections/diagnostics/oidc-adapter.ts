import { healthFetch } from "./http.js";
import type {
  AdapterOutcome,
  ConnectionDiagnosticAdapter,
  ResolvedConnection,
} from "./types.js";

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
      discovery = (await response.json()) as typeof discovery;
    } catch {
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
