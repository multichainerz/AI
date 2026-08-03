import type {
  AdminRole,
  ConfigurationRevisionList,
  CreateServiceConnection,
  RollbackConfigurationResult,
  ServiceConnectionSummary,
  UpdateServiceConnection,
} from "@orcasynapse/contracts";

export interface AdminActor {
  id: string;
  subject: string;
  role?: AdminRole;
}

export interface ConnectionManager {
  list(): Promise<ServiceConnectionSummary[]>;
  create(input: CreateServiceConnection, actor?: AdminActor): Promise<ServiceConnectionSummary>;
  update(
    id: string,
    input: UpdateServiceConnection,
    actor?: AdminActor,
  ): Promise<ServiceConnectionSummary>;
  listRevisions(id: string): Promise<ConfigurationRevisionList>;
  rollback(
    id: string,
    targetRevision: number,
    expectedActiveRevision: number,
    actor?: AdminActor,
  ): Promise<RollbackConfigurationResult>;
}

export class ConnectionNotFoundError extends Error {
  constructor(id: string) {
    super(`Service connection '${id}' was not found.`);
    this.name = "ConnectionNotFoundError";
  }
}

export class ConnectionConflictError extends Error {
  constructor(slug: string) {
    super(`A service connection with slug '${slug}' already exists.`);
    this.name = "ConnectionConflictError";
  }
}

export class InvalidConnectionConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidConnectionConfigurationError";
  }
}

export class ConnectionRevisionConflictError extends Error {
  constructor(message = "The connection changed before the rollback could be applied.") {
    super(message);
    this.name = "ConnectionRevisionConflictError";
  }
}

export class ConnectionAuthorizationError extends Error {
  constructor(message = "Only a Platform Administrator can change enterprise identity configuration.") {
    super(message);
    this.name = "ConnectionAuthorizationError";
  }
}
