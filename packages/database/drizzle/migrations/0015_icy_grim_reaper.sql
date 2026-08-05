CREATE TABLE "ControlPlaneSigningKey" (
	"id" varchar(32) PRIMARY KEY DEFAULT 'primary' NOT NULL,
	"publicKeyPem" text NOT NULL,
	"publicKeyFingerprint" varchar(100) NOT NULL,
	"encryptedValue" "bytea" NOT NULL,
	"valueNonce" "bytea" NOT NULL,
	"valueAuthTag" "bytea" NOT NULL,
	"wrappedDataKey" "bytea" NOT NULL,
	"keyNonce" "bytea" NOT NULL,
	"keyAuthTag" "bytea" NOT NULL,
	"encryptionVersion" integer DEFAULT 1 NOT NULL,
	"masterKeyVersion" integer DEFAULT 1 NOT NULL,
	"createdAt" timestamp (6) with time zone NOT NULL,
	"updatedAt" timestamp (6) with time zone NOT NULL
);
