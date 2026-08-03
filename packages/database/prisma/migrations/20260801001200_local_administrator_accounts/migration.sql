CREATE TYPE "AdministratorAuthenticationMethod" AS ENUM (
  'LOCAL_PASSWORD',
  'INSTALLATION_KEY_RECOVERY',
  'OIDC'
);

ALTER TABLE "AdministratorSession"
ADD COLUMN "authenticationMethod" "AdministratorAuthenticationMethod" NOT NULL DEFAULT 'LOCAL_PASSWORD',
ADD COLUMN "passwordChangeRequired" BOOLEAN NOT NULL DEFAULT false;

UPDATE "AdministratorSession"
SET "authenticationMethod" = 'INSTALLATION_KEY_RECOVERY',
    "passwordChangeRequired" = true
WHERE "subject" = 'installation-key-administrator';

UPDATE "AdministratorSession"
SET "authenticationMethod" = 'OIDC'
WHERE "subject" LIKE 'oidc:%';

CREATE TABLE "LocalAdministrator" (
  "id" UUID NOT NULL,
  "username" VARCHAR(64) NOT NULL,
  "displayName" VARCHAR(120) NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "role" "AdministratorRole" NOT NULL DEFAULT 'PLATFORM_ADMIN',
  "passwordChangeRequired" BOOLEAN NOT NULL DEFAULT true,
  "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
  "lockedUntil" TIMESTAMPTZ(6),
  "lastLoginAt" TIMESTAMPTZ(6),
  "passwordChangedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "disabledAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "LocalAdministrator_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LocalAdministrator_username_key"
ON "LocalAdministrator"("username");

CREATE INDEX "LocalAdministrator_disabledAt_lockedUntil_idx"
ON "LocalAdministrator"("disabledAt", "lockedUntil");

UPDATE "OnboardingStep"
SET "description" = 'Confirm the local administrator account, installed release, and host identity.'
WHERE "key" = 'activate-installation';
