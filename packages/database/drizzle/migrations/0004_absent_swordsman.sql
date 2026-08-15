CREATE TABLE "PlatformReleaseTarget" (
	"id" varchar(32) PRIMARY KEY DEFAULT 'global' NOT NULL,
	"desiredVersion" varchar(64),
	"desiredCommit" varchar(40),
	"approvedBy" uuid,
	"approvedBySubject" varchar(320),
	"approvedAt" timestamp (6) with time zone,
	"revision" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (6) with time zone NOT NULL,
	CONSTRAINT "PlatformReleaseTarget_approval_check" CHECK ((("desiredVersion" IS NULL) AND ("desiredCommit" IS NULL) AND ("approvedAt" IS NULL) AND ("approvedBySubject" IS NULL)) OR ((length(btrim(("desiredVersion")::text)) > 0) AND (("desiredCommit")::text ~ '^[0-9a-f]{40}$'::text) AND ("approvedAt" IS NOT NULL) AND (length(btrim(("approvedBySubject")::text)) > 0)))
);
