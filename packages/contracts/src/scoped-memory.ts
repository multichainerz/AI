import { z } from "zod";

/**
 * What a division knows.
 *
 * An administrator observing these is looking at the same store a run reads —
 * not a mirror of one, which is what makes Agents → Memory able to be complete
 * rather than merely plausible.
 *
 * Two things write here. An administrator curates an entry directly, which is
 * how a fresh deployment gets a division's standing facts before any agent has
 * run; and the governed `remember` tool writes what a run learned, taking its
 * division from the run authorization. Reading is not symmetrical with either:
 * a run is handed only its own division's rows, selected on the control plane
 * before the prompt is built.
 */
export const scopedMemoryEntrySchema = z.object({
  id: z.uuid(),
  content: z.string(),
  /** Null means a deployment-wide run wrote it, which is its own scope. */
  divisionId: z.uuid().nullable(),
  divisionName: z.string().nullable(),
  runId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});

export const scopedMemoryListSchema = z.object({
  items: z.array(scopedMemoryEntrySchema),
  /** Total rows, so a truncated list can say so rather than imply completeness. */
  total: z.number().int().nonnegative(),
});

/**
 * A note an administrator writes for one division, or for the deployment.
 *
 * `divisionId` is required rather than optional, and null must be said out
 * loud. Omitting it would make "deployment-wide" the accidental default of a
 * dropdown nobody touched, and a deployment-wide note is the one every division
 * does *not* see — the widest-looking choice is the one with the narrowest
 * readership, so it should never be reached by not choosing.
 */
export const createScopedMemorySchema = z.object({
  content: z.string().trim().min(3).max(4_000),
  divisionId: z.uuid().nullable(),
}).strict();

export type ScopedMemoryEntry = z.infer<typeof scopedMemoryEntrySchema>;
export type ScopedMemoryList = z.infer<typeof scopedMemoryListSchema>;
export type CreateScopedMemory = z.infer<typeof createScopedMemorySchema>;
