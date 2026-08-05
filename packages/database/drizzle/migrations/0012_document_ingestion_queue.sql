ALTER TABLE "Document" ADD COLUMN "pendingText" text;--> statement-breakpoint
ALTER TABLE "Document" ADD COLUMN "ingestionAttempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "Document" ADD COLUMN "ingestionLeaseOwner" uuid;--> statement-breakpoint
ALTER TABLE "Document" ADD COLUMN "ingestionLeaseExpiresAt" timestamp (6) with time zone;--> statement-breakpoint
CREATE INDEX "Document_ingestionLease_idx" ON "Document" USING btree ("status","ingestionLeaseExpiresAt");