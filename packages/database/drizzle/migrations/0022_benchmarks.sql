CREATE TYPE "public"."BenchmarkKind" AS ENUM('CHAT_QUALITY', 'RETRIEVAL', 'MEMORY');--> statement-breakpoint
CREATE TYPE "public"."BenchmarkRunStatus" AS ENUM('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "BenchmarkSuite" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(64) NOT NULL,
	"displayName" varchar(160) NOT NULL,
	"description" varchar(1000) NOT NULL,
	"kind" "public"."BenchmarkKind" NOT NULL,
	"cases" jsonb NOT NULL,
	"passThreshold" double precision DEFAULT 0.9 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"createdBy" uuid,
	"updatedBy" uuid,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (6) with time zone NOT NULL,
	CONSTRAINT "BenchmarkSuite_bounds_check" CHECK (("passThreshold" >= 0) AND ("passThreshold" <= 1) AND (revision > 0) AND (jsonb_array_length(cases) > 0))
);--> statement-breakpoint
CREATE UNIQUE INDEX "BenchmarkSuite_slug_key" ON "BenchmarkSuite" USING btree ("slug");--> statement-breakpoint
CREATE TABLE "BenchmarkRun" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"suiteId" uuid NOT NULL,
	"suiteSlug" varchar(64) NOT NULL,
	"suiteRevision" integer NOT NULL,
	"kind" "public"."BenchmarkKind" NOT NULL,
	"status" "public"."BenchmarkRunStatus" DEFAULT 'QUEUED' NOT NULL,
	"agentProfileId" uuid,
	"agentProfileSlug" varchar(64),
	"agentProfileVersion" integer,
	"modelAlias" varchar(120),
	"totalCases" integer DEFAULT 0 NOT NULL,
	"passedCases" integer DEFAULT 0 NOT NULL,
	"passRate" double precision,
	"medianLatencyMs" integer,
	"results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"failureMessage" varchar(1000),
	"evaluationRunId" uuid,
	"requestedBy" uuid,
	"queuedAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"startedAt" timestamp (6) with time zone,
	"completedAt" timestamp (6) with time zone,
	CONSTRAINT "BenchmarkRun_counts_check" CHECK (("passedCases" >= 0) AND ("passedCases" <= "totalCases") AND ("passRate" IS NULL OR ("passRate" >= 0 AND "passRate" <= 1))),
	CONSTRAINT "BenchmarkRun_progress_check" CHECK ((status NOT IN ('QUEUED', 'RUNNING')) OR ("passRate" IS NULL)),
	CONSTRAINT "BenchmarkRun_completion_check" CHECK ((status <> 'COMPLETED') OR ("completedAt" IS NOT NULL))
);--> statement-breakpoint
ALTER TABLE "BenchmarkRun" ADD CONSTRAINT "BenchmarkRun_suiteId_fkey" FOREIGN KEY ("suiteId") REFERENCES "public"."BenchmarkSuite"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "BenchmarkRun_suite_idx" ON "BenchmarkRun" USING btree ("suiteId","queuedAt" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "BenchmarkRun_pending_idx" ON "BenchmarkRun" USING btree ("queuedAt") WHERE status = 'QUEUED';
