ALTER TABLE "AgentProfileVersion"
ADD COLUMN "soulMd" TEXT NOT NULL DEFAULT '',
ADD COLUMN "skills" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN "distributionDigest" VARCHAR(64);

ALTER TABLE "AgentRun"
ADD COLUMN "profileDistributionDigest" VARCHAR(64);
