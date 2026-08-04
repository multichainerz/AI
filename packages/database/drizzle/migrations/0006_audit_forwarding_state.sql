CREATE TABLE "AuditForwardingState" (
	"id" varchar(32) PRIMARY KEY DEFAULT 'global' NOT NULL,
	"lastForwardedAt" timestamp (6) with time zone,
	"lastForwardedId" uuid,
	"lastAttemptAt" timestamp (6) with time zone,
	"lastError" varchar(500),
	"deliveredCount" integer DEFAULT 0 NOT NULL,
	"updatedAt" timestamp (6) with time zone NOT NULL
);
