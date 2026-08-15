CREATE TABLE "PlatformUpdateAgent" (
	"id" varchar(32) PRIMARY KEY DEFAULT 'global' NOT NULL,
	"phase" varchar(32) NOT NULL,
	"detail" text NOT NULL,
	"installedVersion" varchar(64),
	"installedCommit" varchar(40),
	"currentRunId" uuid,
	"checkedAt" timestamp (6) with time zone NOT NULL,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (6) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "PlatformUpdateRun" (
	"id" uuid PRIMARY KEY NOT NULL,
	"phase" varchar(32) NOT NULL,
	"detail" text NOT NULL,
	"targetVersion" varchar(64),
	"targetCommit" varchar(40),
	"installedVersion" varchar(64),
	"installedCommit" varchar(40),
	"rollback" text,
	"log" text,
	"logTruncated" boolean DEFAULT false NOT NULL,
	"startedAt" timestamp (6) with time zone NOT NULL,
	"apiUnavailableUntil" timestamp (6) with time zone,
	"completedAt" timestamp (6) with time zone,
	"recordedAt" timestamp (6) with time zone NOT NULL,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (6) with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "PlatformUpdateRun_startedAt_idx" ON "PlatformUpdateRun" USING btree ("startedAt" DESC NULLS LAST);