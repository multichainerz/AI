CREATE TABLE "RuntimeToolsetAdmission" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"toolsetName" varchar(120) NOT NULL,
	"admitted" boolean DEFAULT false NOT NULL,
	"reason" varchar(500) NOT NULL,
	"admittedBy" uuid,
	"createdAt" timestamp (6) with time zone NOT NULL,
	"updatedAt" timestamp (6) with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "RuntimeToolsetAdmission_toolsetName_key" ON "RuntimeToolsetAdmission" USING btree ("toolsetName");