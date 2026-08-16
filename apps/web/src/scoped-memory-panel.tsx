import type { ScopedMemoryEntry } from "@orcasynapse/contracts";
import { useEffect, useState } from "react";
import { OrcaSynapseApiError, getScopedMemory } from "./api.js";
import { Alert, EmptyState, MicroLabel, Panel, PanelHeading, StatusText } from "./ui/index.js";

/**
 * What agents have remembered through the governed memory tools.
 *
 * Sits beside the file-backed `MEMORY.md` / `USER.md` mirror rather than
 * replacing it, because the two are different things: those files are Hermes'
 * own memory, shared by every division on a node; these rows are per division
 * and are read back only by a run in the same one.
 *
 * The distinction is stated on screen. An administrator looking at one and
 * assuming the other is how somebody concludes memory is isolated when it is
 * only partly so.
 */
export function ScopedMemoryPanel({ onSessionExpired }: { onSessionExpired: () => void }) {
  const [entries, setEntries] = useState<ScopedMemoryEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const { items, total: counted } = await getScopedMemory();
        setEntries(items);
        setTotal(counted);
        setError(null);
      } catch (cause) {
        if (cause instanceof OrcaSynapseApiError && cause.status === 401) {
          onSessionExpired();
          return;
        }
        setError(cause instanceof Error ? cause.message : "Division memory could not be loaded.");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Panel>
      <PanelHeading
        kicker="Per division"
        title="Division memory"
        description="Written by agents through the governed memory tools. A run reads back only what its own division wrote."
        actions={<StatusText>{total} {total === 1 ? "entry" : "entries"}</StatusText>}
      />

      {error && <Alert tone="error">{error}</Alert>}

      {entries.length === 0 ? (
        <EmptyState title="Nothing remembered yet">
          This is separate from the Hermes memory above. Those files belong to the node and are
          shared by every division; these entries belong to one division each.
        </EmptyState>
      ) : (
        <div className="grid gap-2">
          {entries.map((entry) => (
            <article key={entry.id} className="rounded border border-border p-3">
              <div className="mb-1.5 flex items-center justify-between gap-3">
                {/*
                  * "Deployment-wide" rather than "none": a null division is the
                  * scope of a run against a deployment-wide profile, and those
                  * entries are read back only by other such runs. Labelling it
                  * as absent would suggest every division can see it.
                  */}
                <MicroLabel>{entry.divisionName ?? "Deployment-wide"}</MicroLabel>
                <MicroLabel>{new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(entry.createdAt))}</MicroLabel>
              </div>
              <p className="m-0 whitespace-pre-wrap text-body text-text">{entry.content}</p>
            </article>
          ))}
          {total > entries.length && (
            <MicroLabel className="block">
              Showing the {entries.length} most recent of {total}.
            </MicroLabel>
          )}
        </div>
      )}
    </Panel>
  );
}
