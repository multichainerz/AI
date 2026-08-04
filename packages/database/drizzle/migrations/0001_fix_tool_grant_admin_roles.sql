--> Corrects AgentToolGrant.allowedAdminRoles, which the baseline created as
--> bytea[] because drizzle-kit could not introspect an enum array. PostgreSQL
--> has no cast from bytea to an enum, so the column is replaced rather than
--> altered in place; it never held a valid role and so has nothing to preserve.
--> The principal check is dropped and recreated because it depends on the column.
ALTER TABLE "AgentToolGrant" DROP CONSTRAINT "AgentToolGrant_principal_check";--> statement-breakpoint
ALTER TABLE "AgentToolGrant" DROP COLUMN "allowedAdminRoles";--> statement-breakpoint
ALTER TABLE "AgentToolGrant" ADD COLUMN "allowedAdminRoles" "public"."AdministratorRole"[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "AgentToolGrant" ALTER COLUMN "allowedAdminRoles" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "AgentToolGrant" ADD CONSTRAINT "AgentToolGrant_principal_check" CHECK ((cardinality("allowedGroups") > 0) OR (cardinality("allowedAdminRoles") > 0));
