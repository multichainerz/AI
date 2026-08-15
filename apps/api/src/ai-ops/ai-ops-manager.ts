import type {
  AiOpsOverview,
  CreateOperationalIncident,
  IncidentDecision,
  OperationalIncident,
  OperationalIncidentList,
  ProductionReadiness,
  ProductionReadinessApproval,
  RecordProductionReadinessApproval,
  UpdateProductionReadinessControl,
  ProductionReadinessControl,
} from "@orcasynapse/contracts";
import type { AdminPrincipal } from "../auth/admin-session.js";

export interface AiOpsManager {
  overview(): Promise<AiOpsOverview>;
  listIncidents(): Promise<OperationalIncidentList>;
  createIncident(principal: AdminPrincipal, input: CreateOperationalIncident): Promise<OperationalIncident>;
  acknowledgeIncident(principal: AdminPrincipal, incidentId: string, input: IncidentDecision): Promise<OperationalIncident>;
  resolveIncident(principal: AdminPrincipal, incidentId: string, input: IncidentDecision): Promise<OperationalIncident>;
  productionReadiness(): Promise<ProductionReadiness>;
  updateReadinessControl(principal: AdminPrincipal, controlKey: string, input: UpdateProductionReadinessControl): Promise<ProductionReadinessControl>;
  recordReadinessApproval(principal: AdminPrincipal, input: RecordProductionReadinessApproval): Promise<ProductionReadinessApproval>;
}

export class AiOpsNotFoundError extends Error {
  constructor(message = "The AI operations record does not exist.") {
    super(message);
    this.name = "AiOpsNotFoundError";
  }
}

export class AiOpsConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiOpsConflictError";
  }
}
