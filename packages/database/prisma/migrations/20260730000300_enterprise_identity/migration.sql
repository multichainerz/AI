CREATE TABLE "EnterpriseUser" (
  "id" UUID NOT NULL,
  "issuer" VARCHAR(512) NOT NULL,
  "subject" VARCHAR(255) NOT NULL,
  "email" VARCHAR(320),
  "displayName" VARCHAR(200) NOT NULL,
  "groups" TEXT[],
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "lastLoginAt" TIMESTAMPTZ(6) NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "EnterpriseUser_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EnterpriseUserSession" (
  "id" UUID NOT NULL,
  "tokenHash" BYTEA NOT NULL,
  "userId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMPTZ(6) NOT NULL,
  "idleExpiresAt" TIMESTAMPTZ(6) NOT NULL,
  "absoluteExpiresAt" TIMESTAMPTZ(6) NOT NULL,
  "revokedAt" TIMESTAMPTZ(6),
  "sourceIp" INET,
  "userAgentHash" VARCHAR(64),
  CONSTRAINT "EnterpriseUserSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OidcAuthorizationRequest" (
  "id" UUID NOT NULL,
  "serviceConnectionId" UUID NOT NULL,
  "stateHash" BYTEA NOT NULL,
  "nonce" VARCHAR(86) NOT NULL,
  "returnTo" VARCHAR(500) NOT NULL,
  "issuer" VARCHAR(512) NOT NULL,
  "tokenEndpoint" VARCHAR(2048) NOT NULL,
  "jwksUri" VARCHAR(2048) NOT NULL,
  "clientId" VARCHAR(256) NOT NULL,
  "redirectUri" VARCHAR(2048) NOT NULL,
  "codeVerifierEncryptedValue" BYTEA NOT NULL,
  "codeVerifierValueNonce" BYTEA NOT NULL,
  "codeVerifierValueAuthTag" BYTEA NOT NULL,
  "codeVerifierWrappedDataKey" BYTEA NOT NULL,
  "codeVerifierKeyNonce" BYTEA NOT NULL,
  "codeVerifierKeyAuthTag" BYTEA NOT NULL,
  "encryptionVersion" INTEGER NOT NULL DEFAULT 1,
  "masterKeyVersion" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMPTZ(6) NOT NULL,
  "consumedAt" TIMESTAMPTZ(6),
  CONSTRAINT "OidcAuthorizationRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EnterpriseUser_issuer_subject_key" ON "EnterpriseUser"("issuer", "subject");
CREATE INDEX "EnterpriseUser_email_idx" ON "EnterpriseUser"("email");
CREATE INDEX "EnterpriseUser_enabled_lastLoginAt_idx" ON "EnterpriseUser"("enabled", "lastLoginAt");
CREATE UNIQUE INDEX "EnterpriseUserSession_tokenHash_key" ON "EnterpriseUserSession"("tokenHash");
CREATE INDEX "EnterpriseUserSession_userId_createdAt_idx" ON "EnterpriseUserSession"("userId", "createdAt");
CREATE INDEX "EnterpriseUserSession_revokedAt_idleExpiresAt_idx" ON "EnterpriseUserSession"("revokedAt", "idleExpiresAt");
CREATE INDEX "EnterpriseUserSession_absoluteExpiresAt_idx" ON "EnterpriseUserSession"("absoluteExpiresAt");
CREATE UNIQUE INDEX "OidcAuthorizationRequest_stateHash_key" ON "OidcAuthorizationRequest"("stateHash");
CREATE INDEX "OidcAuthorizationRequest_expiresAt_consumedAt_idx" ON "OidcAuthorizationRequest"("expiresAt", "consumedAt");
CREATE INDEX "OidcAuthorizationRequest_serviceConnectionId_createdAt_idx" ON "OidcAuthorizationRequest"("serviceConnectionId", "createdAt");

ALTER TABLE "EnterpriseUserSession"
  ADD CONSTRAINT "EnterpriseUserSession_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "EnterpriseUser"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OidcAuthorizationRequest"
  ADD CONSTRAINT "OidcAuthorizationRequest_serviceConnectionId_fkey"
  FOREIGN KEY ("serviceConnectionId") REFERENCES "ServiceConnection"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
