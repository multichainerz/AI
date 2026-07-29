import {
  createPrismaClient,
  hasBootstrapSecret,
  readBootstrapSecret,
  type AIHubPrismaClient,
} from "@aihub/database";
import { decodeMasterKey, EnvelopeEncryption } from "@aihub/security";
import { BootstrapTokenAuthenticator } from "./auth/bootstrap-auth.js";
import {
  PrismaAdminSessionManager,
  type AdminSessionManager,
} from "./auth/admin-session.js";
import type { ConnectionManager } from "./connections/connection-manager.js";
import { PrismaConnectionManager } from "./connections/prisma-connection-manager.js";
import { ConnectionTestService } from "./connections/diagnostics/connection-test-service.js";
import { PgBossQueueService } from "@aihub/jobs";
import type { OperationsManager } from "./operations/operations-manager.js";
import { PrismaOperationsManager } from "./operations/prisma-operations-manager.js";

export type BootstrapState = "REQUIRED" | "READY" | "LOCKED";

export interface RuntimeServices {
  bootstrapState: BootstrapState;
  sessionManager?: AdminSessionManager;
  connectionManager?: ConnectionManager;
  connectionTestService?: ConnectionTestService;
  operationsManager?: OperationsManager;
  prisma?: AIHubPrismaClient;
}

export function getBootstrapState(): BootstrapState {
  const names = ["aihub_database_url", "aihub_master_key", "aihub_bootstrap_token"] as const;
  const available = names.map((name) => hasBootstrapSecret(name));

  if (available.every((value) => !value)) return "REQUIRED";
  if (!available.every(Boolean)) return "LOCKED";

  try {
    const databaseUrl = new URL(readBootstrapSecret("aihub_database_url"));
    if (databaseUrl.protocol !== "postgresql:" && databaseUrl.protocol !== "postgres:") {
      return "LOCKED";
    }
    decodeMasterKey(readBootstrapSecret("aihub_master_key"));
    if (readBootstrapSecret("aihub_bootstrap_token").length < 32) return "LOCKED";
    return "READY";
  } catch {
    return "LOCKED";
  }
}

export function createRuntimeServices(): RuntimeServices {
  const bootstrapState = getBootstrapState();
  if (bootstrapState !== "READY") return { bootstrapState };

  try {
    const databaseUrl = readBootstrapSecret("aihub_database_url");
    const prisma = createPrismaClient(databaseUrl);
    const encryption = new EnvelopeEncryption({
      masterKey: decodeMasterKey(readBootstrapSecret("aihub_master_key")),
    });
    const authenticator = new BootstrapTokenAuthenticator(
      readBootstrapSecret("aihub_bootstrap_token"),
    );

    const connectionManager = new PrismaConnectionManager(prisma, encryption);
    const sessionManager = new PrismaAdminSessionManager(prisma, authenticator);
    const operationsManager = new PrismaOperationsManager(
      prisma,
      new PgBossQueueService(databaseUrl, "api", {
        error: (message, error) => console.error(message, error),
        warn: (message, details) => console.warn(message, details),
      }),
    );
    return {
      bootstrapState,
      prisma,
      sessionManager,
      connectionManager,
      connectionTestService: new ConnectionTestService(connectionManager),
      operationsManager,
    };
  } catch {
    return { bootstrapState: "LOCKED" };
  }
}
