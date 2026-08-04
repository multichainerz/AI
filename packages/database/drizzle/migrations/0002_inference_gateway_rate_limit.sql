CREATE TABLE "InferenceGatewayRequest" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connectionId" uuid NOT NULL,
	"occurredAt" timestamp (6) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "InferenceGatewayRequest" ADD CONSTRAINT "InferenceGatewayRequest_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "public"."ServiceConnection"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "InferenceGatewayRequest_connectionId_occurredAt_idx" ON "InferenceGatewayRequest" USING btree ("connectionId","occurredAt");