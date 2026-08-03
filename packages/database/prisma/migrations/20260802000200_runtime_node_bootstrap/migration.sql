ALTER TABLE "HermesNodeEnrollment"
ADD COLUMN "hermesImage" TEXT;

-- Invitations issued before this migration remain valid through their
-- downloaded JSON bundle. New invitations can also be resolved directly by
-- the VM2 installer without placing the one-time token in a URL.
