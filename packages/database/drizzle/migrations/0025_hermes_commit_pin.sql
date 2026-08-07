--
-- The Hermes runtime is pinned to a git commit, not a container image.
--
-- VM2 installs Hermes natively through its own installer, which takes
-- `--commit`. A commit SHA is a cryptographic digest of the tree, so the
-- artifact guarantee is unchanged; only its form is.
--
-- Dropped and re-added rather than renamed. Every existing value is an OCI
-- reference for a runtime this release no longer installs, so carrying one
-- forward under the new name would put a container image in a column whose
-- contract says commit SHA -- and the production gate reads that column. An
-- outstanding invitation issued before this release resolves to the "predates
-- direct VM2 bootstrap" refusal the manager already has, which asks the
-- operator to issue a new one. That is the correct outcome: a claim for the
-- old runtime should not enrol a node onto the new one.
--
ALTER TABLE "HermesNodeEnrollment" DROP COLUMN IF EXISTS "hermesImage";--> statement-breakpoint
ALTER TABLE "HermesNodeEnrollment" ADD COLUMN "hermesCommit" text;
