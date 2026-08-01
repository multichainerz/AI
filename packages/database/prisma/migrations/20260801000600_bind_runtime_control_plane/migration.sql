-- Old, unconsumed bundles did not bind the AIHub origin server-side. Revoke
-- them so only newly issued invitations can mint a runtime gateway credential.
UPDATE "HermesNodeEnrollment"
SET "status" = 'REVOKED',
    "revokedAt" = CURRENT_TIMESTAMP
WHERE "status" = 'ISSUED';

ALTER TABLE "HermesNodeEnrollment"
  ADD COLUMN "controlPlaneUrl" TEXT;
