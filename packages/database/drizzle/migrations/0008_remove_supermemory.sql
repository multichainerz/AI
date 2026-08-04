--> Hand-added data step, ahead of the generated type swap below.
--> PostgreSQL has no ALTER TYPE ... DROP VALUE, so removing 'SUPERMEMORY' means
--> recreating the type. The USING cast further down cannot map a value the new
--> enum does not contain, so any surviving row would abort this migration.
--> These rows were created solely by the removed node memory registration and
--> carry no state OrcaSynapse reads: SecretRecord and ConfigurationRevision
--> cascade, and the one restricting foreign key (ModelDeployment) can never
--> reference this kind because model routes reject it.
DELETE FROM "ServiceConnection" WHERE "kind" = 'SUPERMEMORY';--> statement-breakpoint
ALTER TABLE "ServiceConnection" ALTER COLUMN "kind" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."ServiceKind";--> statement-breakpoint
CREATE TYPE "public"."ServiceKind" AS ENUM('INFERENCE', 'HERMES', 'MCP', 'OIDC', 'SIEM', 'NOTIFICATION', 'OTHER');--> statement-breakpoint
ALTER TABLE "ServiceConnection" ALTER COLUMN "kind" SET DATA TYPE "public"."ServiceKind" USING "kind"::"public"."ServiceKind";--> statement-breakpoint
ALTER TABLE "HermesNodeEnrollment" DROP COLUMN "supermemoryVersion";