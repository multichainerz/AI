CREATE TYPE "public"."DivisionStatus" AS ENUM('ACTIVE', 'SUSPENDED');--> statement-breakpoint
CREATE TABLE "Division" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(64) NOT NULL,
	"displayName" varchar(120) NOT NULL,
	"description" varchar(500) DEFAULT '' NOT NULL,
	"status" "DivisionStatus" DEFAULT 'ACTIVE' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"createdBy" uuid,
	"updatedBy" uuid,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (6) with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "AgentProfile" ADD COLUMN "divisionId" uuid;--> statement-breakpoint
ALTER TABLE "EnterpriseUser" ADD COLUMN "divisionId" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "Division_slug_key" ON "Division" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "Division_status_displayName_idx" ON "Division" USING btree ("status","displayName");--> statement-breakpoint
ALTER TABLE "AgentProfile" ADD CONSTRAINT "AgentProfile_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "public"."Division"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "EnterpriseUser" ADD CONSTRAINT "EnterpriseUser_divisionId_fkey" FOREIGN KEY ("divisionId") REFERENCES "public"."Division"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "AgentProfile_divisionId_idx" ON "AgentProfile" USING btree ("divisionId");