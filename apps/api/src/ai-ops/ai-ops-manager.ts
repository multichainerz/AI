import type {
  AiOpsOverview,
  CompleteEvaluationRun,
  CreateEvaluationRun,
  CreateOperationalIncident,
  EvaluationRun,
  EvaluationRunList,
  IncidentDecision,
  OperationalIncident,
  OperationalIncidentList,
  PromoteEvaluationRun,
  ProductionReadiness,
  ProductionReadinessApproval,
  RecordProductionReadinessApproval,
  UpdateProductionReadinessControl,
  ProductionReadinessControl,
} from "@aihub/contracts";
import type { AdminPrincipal } from "../auth/admin-session.js";

export interface AiOpsManager {
  overview(): Promise<AiOpsOverview>;
  listIncidents(): Promise<OperationalIncidentList>;
  createIncident(principal: AdminPrincipal, input: CreateOperationalIncident): Promise<OperationalIncident>;
  acknowledgeIncident(principal: AdminPrincipal, incidentId: string, input: IncidentDecision): Promise<OperationalIncident>;
  resolveIncident(principal: AdminPrincipal, incidentId: string, input: IncidentDecision): Promise<OperationalIncident>;
  listEvaluations(): Promise<EvaluationRunList>;
  createEvaluation(principal: AdminPrincipal, input: CreateEvaluationRun): Promise<EvaluationRun>;
  completeEvaluation(principal: AdminPrincipal, evaluationId: string, input: CompleteEvaluationRun): Promise<EvaluationRun>;
  promoteEvaluation(principal: AdminPrincipal, evaluationId: string, input: PromoteEvaluationRun): Promise<EvaluationRun>;
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
