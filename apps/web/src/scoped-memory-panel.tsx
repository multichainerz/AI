import type { Division, ScopedMemoryEntry } from "@orcasynapse/contracts";
import { useEffect, useState } from "react";
import { OrcaSynapseApiError, createScopedMemory, deleteScopedMemory, getDivisions, getScopedMemory } from "./api.js";
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
export function ScopedMemoryPanel({ canWrite, canDelete, onSessionExpired }: {
  /**
   * `corpus:write`, which `POST /tooling/scoped-memory` requires.
   *
   * Taken as a prop rather than read from the session here, so this panel and
   * the skill-set panel it sits beside in `corpus-view.tsx` are gated from one
   * place on the same two facts. Without it every reading role was offered Add
   * note and Remove and got a 403 from each: an AUDITOR holds
   * `corpus:content:read`, so the notes load and read perfectly, and neither of
   * the two scopes the buttons need.
   */
  canWrite: boolean;
  /** `corpus:delete`, which `DELETE /tooling/scoped-memory/:entryId` requires. */
  canDelete: boolean;
  onSessionExpired: () => void;
}) {
  const [entries, setEntries] = useState<ScopedMemoryEntry[]>([]);
  const [divisions, setDivisions] = useState<Division[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /**
   * Whether the list on screen is a list at all.
   *
   * Separate from `error`, which a failed save also sets: "Nothing remembered
   * yet" is a claim about what a division knows, and a read that never landed
   * supports no claim about it either way. On the one screen an operator opens
   * to find out what an agent knows, an unearned empty state is the worst
   * available answer.
   */
  const [loadFailed, setLoadFailed] = useState(false);
  const [content, setContent] = useState("");
  const [divisionId, setDivisionId] = useState<string>(DEPLOYMENT_WIDE);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

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
        setLoadFailed(false);
      } catch (cause) {
        setLoadFailed(true);
        failed(cause, "Division memory could not be loaded.");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = async () => {
    const { items, total: counted } = await getScopedMemory();
    setEntries(items);
    setTotal(counted);
    setLoadFailed(false);
  };

  const remove = async (entryId: string) => {
    setConfirming(null);
    try {
      await deleteScopedMemory(entryId);
      await refresh();
      setError(null);
    } catch (cause) {
      failed(cause, "The note could not be removed.");
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await createScopedMemory({
        content: content.trim(),
        divisionId: divisionId === DEPLOYMENT_WIDE ? null : divisionId,
      });
      await refresh();
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
        // Withheld rather than shown as zero when the read did not land: a
        // count is the same kind of claim as the empty state below.
        actions={loadFailed ? null : <StatusText>{total} {total === 1 ? "entry" : "entries"}</StatusText>}
      />

      {error && <Alert tone="error">{error}</Alert>}

      {/*
        * Curating a note by hand, which is how a division has knowledge before
        * any agent has run. A fresh deployment already knows how its divisions
        * work; without this, that has to wait to be inferred from conversations
        * that have not happened yet.
        *
        * Behind `corpus:write`, which is what the route behind it requires.
        * Offering the form to a role that cannot save is an invitation to
        * compose a standing fact about a division and lose it to a 403.
        */}
      {canWrite && <div className="mb-4 grid gap-3 rounded border border-border p-3">
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
      </div>}

      {entries.length === 0 ? (
        /*
          * Nothing at all when the read failed. The Alert above already says
          * what happened, and the alternative -- an empty state under an error
          * -- reads as two facts where there is one, the second of which is not
          * a fact.
          */
        loadFailed ? null : (
          <EmptyState title="Nothing remembered yet">
            This is separate from the Hermes memory above. Those files belong to the node and are
            shared by every division; these entries belong to one division each.
          </EmptyState>
        )
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
                <div className="flex items-center gap-3">
                  {/*
                    * Where the note came from. A null run id means an
                    * administrator wrote it; anything else was extracted from a
                    * conversation, which is the one an operator is most likely
                    * to want to check or remove.
                    */}
                  <MicroLabel>{entry.runId === null ? "Curated" : "From a run"}</MicroLabel>
                  <MicroLabel>{new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(entry.createdAt))}</MicroLabel>
                  {/*
                    * Two-step rather than a dialog: the row being removed stays
                    * on screen and under the pointer, so what is about to go is
                    * never in doubt. Deletion is not recoverable.
                    *
                    * Behind `corpus:delete`, the scope the route requires -- a
                    * two-step confirmation that ends in a 403 is worse than no
                    * control, because the operator believes the note is gone
                    * until they read the error.
                    */}
                  {canDelete && <Button
                    variant="ghost"
                    onClick={() => (confirming === entry.id ? void remove(entry.id) : setConfirming(entry.id))}
                    onBlur={() => setConfirming((current) => (current === entry.id ? null : current))}
                  >
                    {confirming === entry.id ? "Confirm removal" : "Remove"}
                  </Button>}
                </div>
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
