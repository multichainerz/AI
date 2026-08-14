import { z } from "zod";

export const platformMetaSchema = z.object({
  product: z.literal("OrcaSynapse"),
  version: z.string(),
  phase: z.string(),
  configurationMode: z.literal("dashboard"),
  bootstrapState: z.enum(["REQUIRED", "READY", "LOCKED"]),
});

export const platformUpdateSchema = z.object({
  currentVersion: z.string(),
  latestVersion: z.string(),
  updateAvailable: z.boolean(),
  releaseUrl: z.url(),
  updateCommand: z.string().min(1),
  automaticUpdateSupported: z.literal(false),
  automaticUpdateReason: z.string().min(1),
  checkedAt: z.iso.datetime(),
});

export const healthResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  service: z.string(),
  timestamp: z.iso.datetime(),
});

export type PlatformMeta = z.infer<typeof platformMetaSchema>;
export type PlatformUpdate = z.infer<typeof platformUpdateSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
