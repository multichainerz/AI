ALTER TABLE "ServiceConnection"
  ADD COLUMN "monitoringClaimedAt" TIMESTAMPTZ(6),
  ADD COLUMN "monitoringClaimedBy" VARCHAR(200),
  ADD COLUMN "monitoringClaimToken" UUID,
  ADD CONSTRAINT "ServiceConnection_monitoringClaim_check" CHECK (
    (
      "monitoringClaimedAt" IS NULL
      AND "monitoringClaimedBy" IS NULL
      AND "monitoringClaimToken" IS NULL
    ) OR (
      "monitoringClaimedAt" IS NOT NULL
      AND "monitoringClaimedBy" IS NOT NULL
      AND "monitoringClaimToken" IS NOT NULL
    )
  );

CREATE INDEX "ServiceConnection_monitoringClaimedAt_idx"
  ON "ServiceConnection"("monitoringClaimedAt");

CREATE TABLE "ConnectionMonitoringControl" (
  "id" VARCHAR(32) NOT NULL DEFAULT 'global',
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "intervalSeconds" INTEGER NOT NULL DEFAULT 300,
  "reason" VARCHAR(500),
  "updatedBy" UUID,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "ConnectionMonitoringControl_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ConnectionMonitoringControl_intervalSeconds_check"
    CHECK ("intervalSeconds" BETWEEN 30 AND 86400)
);

INSERT INTO "ConnectionMonitoringControl" (
  "id", "enabled", "intervalSeconds", "reason", "updatedAt"
)
VALUES (
  'global', false, 300,
  'Enable scheduled checks after the target service endpoints and alert ownership are configured.',
  CURRENT_TIMESTAMP
);
