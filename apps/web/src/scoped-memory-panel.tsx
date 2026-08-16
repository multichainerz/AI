import type { Division, ScopedMemoryEntry } from "@orcasynapse/contracts";
import { useEffect, useState } from "react";
import { OrcaSynapseApiError, createScopedMemory, getDivisions, getScopedMemory } from "./api.js";
import { Alert, Button, EmptyState, Field, MicroLabel, Panel, PanelHeading, Select, StatusText, Textarea } from "./ui/index.js";

/** The option value standing for "no division", since a select cannot carry null. */
const DEPLOYMENT_WIDE = "";

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
  const [divisions, setDivisions] = useState<Division[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [divisionId, setDivisionId] = useState<string>(DEPLOYMENT_WIDE);
  const [saving, setSaving] = useState(false);

  const failed = (cause: unknown, fallback: string) => {
    if (cause instanceof OrcaSynapseApiError && cause.status === 401) {
      onSessionExpired();
      return;
    }
    setError(cause instanceof Error ? cause.message : fallback);
  };

  useEffect(() => {
    void (async () => {
      try {
        const [{ items, total: counted }, divisionList] = await Promise.all([
          getScopedMemory(),
          getDivisions(false),
        ]);
        setEntries(items);
        setTotal(counted);
        setDivisions(divisionList.items);
        setError(null);
      } catch (cause) {
        failed(cause, "Division memory could not be loaded.");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await createScopedMemory({
        content: content.trim(),
        divisionId: divisionId === DEPLOYMENT_WIDE ? null : divisionId,
      });
      const { items, total: counted } = await getScopedMemory();
      setEntries(items);
      setTotal(counted);
      setContent("");
      setError(null);
    } catch (cause) {
      failed(cause, "The note could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Panel>
      <PanelHeading
        kicker="Per division"
        title="Division memory"
        description="Curated here or remembered by a run. A run is handed only its own division's notes, selected before its prompt is built."
        actions={<StatusText>{total} {total === 1 ? "entry" : "entries"}</StatusText>}
      />

      {error && <Alert tone="error">{error}</Alert>}

      {/*
        * Curating a note by hand, which is how a division has knowledge before
        * any agent has run. A fresh deployment already knows how its divisions
        * work; without this, that has to wait to be inferred from conversations
        * that have not happened yet.
        */}
      <div className="mb-4 grid gap-3 rounded border border-border p-3">
        <Field label="Division" htmlFor="memory-division"
          hint="Deployment-wide notes are read only by profiles with no division — they are not shared with every division.">
          <Select id="memory-division" value={divisionId} onChange={(event) => setDivisionId(event.target.value)}>
            <option value={DEPLOYMENT_WIDE}>Deployment-wide</option>
            {divisions.map((option) => (
              <option key={option.id} value={option.id}>{option.displayName}</option>
            ))}
          </Select>
        </Field>
        <Field label="What this division knows" htmlFor="memory-content"
          hint="A standing fact, written to be read months from now by someone who was not there.">
          <Textarea
            id="memory-content"
            rows={3}
            value={content}
            placeholder="Finance closes the books on the fifth working day."
            onChange={(event) => setContent(event.target.value)}
          />
        </Field>
        <div>
          <Button onClick={() => void save()} disabled={saving || content.trim().length < 3}>
            {saving ? "Saving…" : "Add note"}
          </Button>
        </div>
      </div>

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
