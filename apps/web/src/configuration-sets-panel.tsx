import type { SkillSet, ToolSet } from "@orcasynapse/contracts";
import { useEffect, useState, type FormEvent } from "react";
import {
  OrcaSynapseApiError,
  createSkillSet,
  createToolSet,
  deleteSkillSet,
  deleteToolSet,
  getSkillSets,
  getToolSets,
  updateSkillSet,
  updateToolSet,
} from "./api.js";
import { slugAsTyped, slugify } from "./slug.js";
import { Alert, Button, EmptyState, Field, Input, Panel, PanelHeading, StatusText, cn } from "./ui/index.js";

/**
 * Named sets of Hermes toolsets and of Skills, on the tab that owns each.
 *
 * One component for both because they are the same shape with a different
 * payload, and two near-identical panels would drift. What differs is carried in
 * `kind` and nothing else.
 *
 * The distinction this panel exists to make legible: a **tracking** set means
 * "everything", resolved when it is read, and a **named** set lists its members.
 * They cannot be edited into one another — a tracking set has no fixed member
 * list to edit — so the seeded default is shown as a fixed row rather than as
 * something that looks editable and then refuses.
 */

interface ConfigurationSetsPanelProps {
  kind: "tools" | "skills";
  canManage: boolean;
  /** What the runtime currently reports, offered as checkboxes for a tool set. */
  availableToolsets?: string[];
  onSessionExpired: () => void;
}

type AnySet = (ToolSet | SkillSet) & { toolsetNames?: string[]; resolvedToolsetNames?: string[] | null };

function tracks(item: AnySet): boolean {
  return ("tracksAdmission" in item && item.tracksAdmission) || ("tracksRuntime" in item && item.tracksRuntime);
}

export function ConfigurationSetsPanel({
  kind, canManage, availableToolsets = [], onSessionExpired,
}: ConfigurationSetsPanelProps) {
  const [sets, setSets] = useState<AnySet[]>([]);
  const [showEditor, setShowEditor] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [slug, setSlug] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const isTools = kind === "tools";

  const load = async () => {
    try {
      const { items } = isTools ? await getToolSets() : await getSkillSets();
      setSets(items as AnySet[]);
      setError(null);
    } catch (cause) {
      if (cause instanceof OrcaSynapseApiError && cause.status === 401) {
        onSessionExpired();
        return;
      }
      setError(cause instanceof Error ? cause.message : "Sets could not be loaded.");
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  async function guard(work: () => Promise<void>) {
    setBusy(true);
    try {
      await work();
    } catch (cause) {
      if (cause instanceof OrcaSynapseApiError && cause.status === 401) {
        onSessionExpired();
        return;
      }
      setError(cause instanceof Error ? cause.message : "The change could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await guard(async () => {
      if (isTools) {
        await createToolSet({ slug, displayName, toolsetNames: chosen });
      } else {
        // A skill set names Skills by their reviewed triple, which this screen
        // does not collect: created empty and filled from the Skills list.
        await createSkillSet({ slug, displayName, skills: [] });
      }
      setMessage(`${displayName} is ready. Point a profile at it from Agents → Profiles.`);
      setDisplayName(""); setSlug(""); setChosen([]); setShowEditor(false);
      setError(null);
      await load();
    });
  };

  const retire = async (item: AnySet) => {
    await guard(async () => {
      const next = item.status === "ACTIVE" ? "RETIRED" as const : "ACTIVE" as const;
      if (isTools) await updateToolSet(item.id, { status: next, expectedRevision: item.revision });
      else await updateSkillSet(item.id, { status: next, expectedRevision: item.revision });
      setError(null);
      await load();
    });
  };

  const remove = async (item: AnySet) => {
    await guard(async () => {
      if (isTools) await deleteToolSet(item.id);
      else await deleteSkillSet(item.id);
      setMessage(`${item.displayName} was deleted.`);
      setError(null);
      await load();
    });
  };

  const noun = isTools ? "tool set" : "skill set";

  return (
    <Panel>
      <PanelHeading
        kicker="Reusable selection"
        title={isTools ? "Tool sets" : "Skill sets"}
        description={isTools
          ? "A named selection of admitted Hermes toolsets, so a profile can declare one instead of repeating a list."
          : "A named selection of Skills, so a profile can declare one instead of repeating a list."}
        actions={canManage ? (
          <Button onClick={() => setShowEditor((open) => !open)}>
            {showEditor ? "Cancel" : `New ${noun}`}
          </Button>
        ) : null}
      />

      {error && <Alert tone="error">{error}</Alert>}
      {message && <Alert tone="info">{message}</Alert>}

      {showEditor && canManage && (
        <form className="mb-4 grid gap-3 rounded border border-border p-3" onSubmit={submit}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name">
              <Input
                required
                value={displayName}
                onChange={(event) => {
                  const next = event.target.value;
                  setSlug((current) => (current === slugify(displayName) ? slugify(next) : current));
                  setDisplayName(next);
                }}
              />
            </Field>
            <Field label="Identifier">
              <Input required value={slug} onChange={(event) => setSlug(slugAsTyped(event.target.value))} />
            </Field>
          </div>
          {isTools && (
            <Field
              label="Toolsets"
              hint={availableToolsets.length === 0
                ? "Nothing is admitted yet, so a named set would be empty. Admit toolsets above first."
                : "Only what this deployment already admits can be named here."}
            >
              <div className="grid gap-1.5">
                {availableToolsets.map((name) => (
                  <label key={name} className="flex items-center gap-2 text-body text-muted">
                    <input
                      type="checkbox"
                      checked={chosen.includes(name)}
                      onChange={(event) => setChosen((current) => (
                        event.target.checked ? [...current, name] : current.filter((entry) => entry !== name)
                      ))}
                    />
                    <span className="font-mono text-caption">{name}</span>
                  </label>
                ))}
              </div>
            </Field>
          )}
          <div className="flex justify-end">
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? "Creating…" : `Create ${noun}`}
            </Button>
          </div>
        </form>
      )}

      {sets.length === 0 ? (
        <EmptyState title={`No ${noun}s yet`}>
          {/*
            * "A profile that names none gets everything this deployment admits"
            * read as a delivery promise, and its converse -- that naming one
            * gets less -- is the belief this sentence has to stop. Nothing
            * narrows on a tool set: `agent-processor.ts` selects every admitted
            * toolset with no profile predicate and submits that array to
            * `hermes.start`, and `toolSetId` has no reader in the worker, in
            * the runtime clients, or in the tool-call gate. Admission is the
            * only control that changes what an agent may use, so that is what
            * this points at.
            */}
          {isTools
            ? "Naming one narrows nothing: every run is submitted with every toolset this deployment admits, whether or not its profile declares a set. Admission above is the control that decides what an agent may use; a set is a record of what a version declares."
            : "A profile that names none refers to every Skill the runtime reports. Either way the set is recorded rather than delivered: a run loads whatever the node already holds."}
        </EmptyState>
      ) : (
        <div className="grid gap-2">
          {sets.map((item) => (
            <article
              key={item.id}
              className={cn(
                "flex items-start justify-between gap-4 rounded border border-border p-3",
                item.status !== "ACTIVE" && "opacity-60",
              )}
            >
              <div className="min-w-0">
                <strong className="block text-label font-semibold text-text">{item.displayName}</strong>
                <p className="mb-0 mt-0.5 text-caption text-muted">
                  {tracks(item)
                    // The seeded default. Saying "everything currently admitted"
                    // and then listing what that is keeps the promise and the
                    // present answer visible at once -- an empty list under
                    // "everything" is correct on a fresh install and would look
                    // like a bug without the first half of the sentence.
                    ? isTools
                      ? `Everything this deployment admits${(item.resolvedToolsetNames ?? []).length > 0
                        ? `: ${(item.resolvedToolsetNames ?? []).join(", ")}`
                        : " — nothing is admitted yet"}`
                      : "Every Skill the runtime reports"
                    : isTools
                      ? (item.toolsetNames ?? []).join(", ") || "No toolsets named"
                      : `${(item as SkillSet).skills.length} Skill${(item as SkillSet).skills.length === 1 ? "" : "s"}`}
                </p>
                <small className="mt-1 block font-mono text-micro text-faint">{item.slug}</small>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {/* The tone directly, not through `toneFor`: its vocabulary is
                    lower case, so `toneFor("HEALTHY")` matched nothing and both
                    states came back neutral. A two-state boolean has no
                    readiness string to translate in the first place. */}
                <StatusText tone={item.status === "ACTIVE" ? "good" : "warn"}>
                  {item.status === "ACTIVE" ? "Active" : "Retired"}
                </StatusText>
                {canManage && !tracks(item) && (
                  <>
                    <Button variant="ghost" disabled={busy} onClick={() => void retire(item)}>
                      {item.status === "ACTIVE" ? "Retire" : "Restore"}
                    </Button>
                    <Button variant="ghost" disabled={busy} onClick={() => void remove(item)}>Delete</Button>
                  </>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </Panel>
  );
}
