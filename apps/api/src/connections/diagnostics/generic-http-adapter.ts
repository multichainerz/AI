import { failedHttpOutcome, healthFetch, stringConfiguration } from "./http.js";
import type {
  AdapterOutcome,
  ConnectionDiagnosticAdapter,
  ResolvedConnection,
} from "./types.js";

export class GenericHttpAdapter implements ConnectionDiagnosticAdapter {
  constructor(
    private readonly serviceName: string,
    private readonly defaultHealthPath = "/health",
  ) {}

  async test(connection: ResolvedConnection, signal: AbortSignal): Promise<AdapterOutcome> {
    const path = stringConfiguration(connection, "healthPath") ?? this.defaultHealthPath;
    const response = await healthFetch(connection, path, signal);
    if (!response.ok) return failedHttpOutcome(this.serviceName, response);

    return {
      status: "HEALTHY",
      message: `${this.serviceName} is reachable.`,
      details: { httpStatus: response.status, healthPath: path },
    };
  }
}
