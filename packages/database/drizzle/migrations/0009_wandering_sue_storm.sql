CREATE TABLE "LocalUser" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"userId" uuid NOT NULL,
	"username" varchar(64) NOT NULL,
	"passwordHash" text NOT NULL,
	"passwordChangeRequired" boolean DEFAULT true NOT NULL,
	"failedLoginCount" integer DEFAULT 0 NOT NULL,
	"lockedUntil" timestamp (6) with time zone,
	"passwordChangedAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"createdBy" uuid,
	"createdAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (6) with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "EnterpriseUser" ALTER COLUMN "lastLoginAt" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "LocalUser" ADD CONSTRAINT "LocalUser_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."EnterpriseUser"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "LocalUser_username_key" ON "LocalUser" USING btree ("username");--> statement-breakpoint
CREATE UNIQUE INDEX "LocalUser_userId_key" ON "LocalUser" USING btree ("userId");