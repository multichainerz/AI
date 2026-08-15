ALTER TABLE "GuardrailPolicy" DROP CONSTRAINT "GuardrailPolicy_activation_evidence_check";--> statement-breakpoint
ALTER TABLE "ModelDeployment" DROP CONSTRAINT "ModelDeployment_activation_evidence_check";--> statement-breakpoint
ALTER TABLE "PromptTemplate" DROP CONSTRAINT "PromptTemplate_activation_evidence_check";--> statement-breakpoint
ALTER TABLE "GuardrailPolicy" DROP CONSTRAINT "GuardrailPolicy_activationEvaluationId_fkey";
--> statement-breakpoint
ALTER TABLE "ModelDeployment" DROP CONSTRAINT "ModelDeployment_activationEvaluationId_fkey";
--> statement-breakpoint
ALTER TABLE "PromptTemplate" DROP CONSTRAINT "PromptTemplate_activationEvaluationId_fkey";
--> statement-breakpoint
DROP INDEX "GuardrailPolicy_activationEvaluationId_idx";--> statement-breakpoint
DROP INDEX "ModelDeployment_activationEvaluationId_idx";--> statement-breakpoint
DROP INDEX "PromptTemplate_activationEvaluationId_idx";--> statement-breakpoint
ALTER TABLE "GuardrailPolicy" DROP COLUMN "activationEvaluationId";--> statement-breakpoint
ALTER TABLE "ModelDeployment" DROP COLUMN "activationEvaluationId";--> statement-breakpoint
ALTER TABLE "PromptTemplate" DROP COLUMN "activationEvaluationId";--> statement-breakpoint
ALTER TABLE "GuardrailPolicy" ADD CONSTRAINT "GuardrailPolicy_activation_check" CHECK ((status <> 'ACTIVE'::"GuardrailPolicyStatus") OR ("firstActivatedAt" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "ModelDeployment" ADD CONSTRAINT "ModelDeployment_activation_check" CHECK ((status <> 'ACTIVE'::"ModelDeploymentStatus") OR ("firstActivatedAt" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "PromptTemplate" ADD CONSTRAINT "PromptTemplate_activation_check" CHECK ((status <> 'ACTIVE'::"PromptTemplateStatus") OR ("firstActivatedAt" IS NOT NULL));