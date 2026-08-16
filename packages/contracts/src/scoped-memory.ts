import { z } from "zod";

/**
 * What a division's agents have remembered.
 *
 * Read-only from the dashboard. These rows are written by the governed
 * `remember` tool, whose division comes from the run authorization, so an
 * administrator observing them here is looking at the same store the agent
 * reads — not a mirror of one, which is what makes Agents → Memory able to be
 * complete rather than merely plausible.
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

export type ScopedMemoryEntry = z.infer<typeof scopedMemoryEntrySchema>;
export type ScopedMemoryList = z.infer<typeof scopedMemoryListSchema>;
