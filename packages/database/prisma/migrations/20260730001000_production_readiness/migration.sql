CREATE TYPE "ProductionReadinessDomain" AS ENUM ('SECURITY', 'INFRASTRUCTURE', 'RECOVERY', 'OPERATIONS', 'TRAINING', 'BUSINESS');
CREATE TYPE "ProductionReadinessControlStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'BLOCKED', 'VERIFIED', 'WAIVED');
CREATE TYPE "ProductionReadinessApprovalRole" AS ENUM ('SECURITY', 'INFRASTRUCTURE', 'PRODUCT', 'BUSINESS');
CREATE TYPE "ProductionReadinessApprovalDecision" AS ENUM ('APPROVED', 'REJECTED');

CREATE TABLE "ProductionReadinessControl" (
  "key" VARCHAR(80) NOT NULL,
  "title" VARCHAR(160) NOT NULL,
  "domain" "ProductionReadinessDomain" NOT NULL,
  "description" VARCHAR(1000) NOT NULL,
  "status" "ProductionReadinessControlStatus" NOT NULL DEFAULT 'NOT_STARTED',
  "owner" VARCHAR(160),
  "evidenceRefs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "note" VARCHAR(1000),
  "lastUpdatedBy" VARCHAR(160),
  "verifiedAt" TIMESTAMPTZ(6),
  "revision" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "ProductionReadinessControl_pkey" PRIMARY KEY ("key"),
  CONSTRAINT "ProductionReadinessControl_key_check" CHECK ("key" ~ '^[a-z][a-z0-9-]{2,79}$'),
  CONSTRAINT "ProductionReadinessControl_owner_check" CHECK (
    "status" = 'NOT_STARTED' OR ("owner" IS NOT NULL AND length(btrim("owner")) > 0)
  ),
  CONSTRAINT "ProductionReadinessControl_note_check" CHECK (
    "status" NOT IN ('BLOCKED', 'VERIFIED', 'WAIVED') OR ("note" IS NOT NULL AND length(btrim("note")) >= 3)
  ),
  CONSTRAINT "ProductionReadinessControl_evidence_check" CHECK ("status" NOT IN ('VERIFIED', 'WAIVED') OR cardinality("evidenceRefs") > 0),
  CONSTRAINT "ProductionReadinessControl_verification_check" CHECK (
    ("status" IN ('VERIFIED', 'WAIVED') AND "verifiedAt" IS NOT NULL)
    OR ("status" NOT IN ('VERIFIED', 'WAIVED') AND "verifiedAt" IS NULL)
  )
);

CREATE TABLE "ProductionReadinessApproval" (
  "id" UUID NOT NULL,
  "role" "ProductionReadinessApprovalRole" NOT NULL,
  "decision" "ProductionReadinessApprovalDecision" NOT NULL,
  "authority" VARCHAR(160) NOT NULL,
  "evidenceRef" VARCHAR(500) NOT NULL,
  "reason" VARCHAR(1000) NOT NULL,
  "recordedBy" VARCHAR(160) NOT NULL,
  "recordedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "controlRevisions" JSONB NOT NULL DEFAULT '{}',
  CONSTRAINT "ProductionReadinessApproval_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProductionReadinessApproval_content_check" CHECK (
    length(btrim("authority")) > 0 AND length(btrim("evidenceRef")) > 0
    AND length(btrim("reason")) >= 3 AND length(btrim("recordedBy")) > 0
  ),
  CONSTRAINT "ProductionReadinessApproval_snapshot_check" CHECK (jsonb_typeof("controlRevisions") = 'object')
);

CREATE INDEX "ProductionReadinessControl_domain_status_idx" ON "ProductionReadinessControl"("domain", "status");
CREATE INDEX "ProductionReadinessControl_status_updatedAt_idx" ON "ProductionReadinessControl"("status", "updatedAt");
CREATE INDEX "ProductionReadinessApproval_role_recordedAt_idx" ON "ProductionReadinessApproval"("role", "recordedAt");
CREATE INDEX "ProductionReadinessApproval_decision_recordedAt_idx" ON "ProductionReadinessApproval"("decision", "recordedAt");

INSERT INTO "ProductionReadinessControl" ("key", "title", "domain", "description", "updatedAt") VALUES
  ('security-threat-model', 'Threat model and security review', 'SECURITY', 'MPM Security reviews trust boundaries, data flows, abuse cases, and residual risks for the intended pilot scope.', CURRENT_TIMESTAMP),
  ('security-dependency-review', 'Dependency and license review', 'SECURITY', 'Production images and JavaScript dependencies are scanned, triaged, and approved under the MPM vulnerability and license policy.', CURRENT_TIMESTAMP),
  ('security-penetration-test', 'Penetration and adversarial test', 'SECURITY', 'The deployed boundary is tested for authentication, authorization, injection, data exposure, and agent or tool abuse.', CURRENT_TIMESTAMP),
  ('infrastructure-coolify-network-tls', 'Coolify, network, DNS, and TLS validation', 'INFRASTRUCTURE', 'The production topology, internal DNS, TLS termination, segmentation, ingress, egress, and persistent storage are verified.', CURRENT_TIMESTAMP),
  ('recovery-postgresql-restore', 'PostgreSQL restore exercise', 'RECOVERY', 'A representative encrypted PostgreSQL backup is restored and measured against the approved recovery objectives.', CURRENT_TIMESTAMP),
  ('recovery-seaweedfs-restore', 'SeaweedFS restore exercise', 'RECOVERY', 'Document objects and metadata are restored and reconciled against PostgreSQL without silent loss or split-brain state.', CURRENT_TIMESTAMP),
  ('recovery-vault-key-restore', 'Configuration vault and key recovery', 'RECOVERY', 'Encrypted service configuration and master-key recovery are demonstrated using the approved custody procedure.', CURRENT_TIMESTAMP),
  ('operations-monitoring-alerting-siem', 'Monitoring, alerting, and SIEM delivery', 'OPERATIONS', 'Operational, security, approval, and audit signals reach their approved owners with tested retry and escalation behavior.', CURRENT_TIMESTAMP),
  ('operations-capacity-failure-tests', 'Capacity and failure-mode tests', 'OPERATIONS', 'Load, soak, concurrency, saturation, worker loss, and dependency failure behavior are measured on the target infrastructure.', CURRENT_TIMESTAMP),
  ('training-pilot-roles', 'Administrator and pilot-role training', 'TRAINING', 'Administrators, reviewers, support staff, and pilot users complete role-appropriate operating and escalation guidance.', CURRENT_TIMESTAMP),
  ('business-pilot-measures', 'Pilot measures and acceptance results', 'BUSINESS', 'Approved success measures are captured from the limited pilot and material findings have named remediation owners.', CURRENT_TIMESTAMP),
  ('business-residual-risk', 'Residual-risk register', 'BUSINESS', 'Known residual risks, waivers, mitigations, owners, expiry dates, and approving authorities are retained.', CURRENT_TIMESTAMP);
