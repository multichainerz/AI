import { z } from "zod";

export const platformMetaSchema = z.object({
  product: z.literal("OrcaSynapse"),
  version: z.string(),
  phase: z.string(),
  configurationMode: z.literal("dashboard"),
  bootstrapState: z.enum(["REQUIRED", "READY", "LOCKED"]),
});

export const healthResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  service: z.string(),
  timestamp: z.iso.datetime(),
});

export type PlatformMeta = z.infer<typeof platformMetaSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
