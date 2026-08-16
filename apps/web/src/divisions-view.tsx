import type { AdministratorSession, CreateDivision, Division } from "@orcasynapse/contracts";
import { useEffect, useState, type FormEvent } from "react";
import { OrcaSynapseApiError, createDivision, deleteDivision, getDivisions, updateDivision } from "./api.js";
import { adminAccess } from "./admin-access.js";
import { slugAsTyped, slugify } from "./slug.js";
import {
  Alert, Button, EmptyState, Field, Input, LockedScreen, Metric, MetricRow, MicroLabel,
  PageHeader, Panel, PanelHeading, StatusText, cn, toneFor,
} from "./ui/index.js";

interface DivisionsViewProps {
  session: AdministratorSession | null;
  onOpenSettings: () => void;
  onSessionExpired: () => void;
}

const emptyDraft: CreateDivision = { slug: "", displayName: "", description: "" };

function when(value: string): string {
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

/**
 * Divisions: which agent profiles a user may see and run.
 *
 * Two things this screen must not imply, because the product does not do them.
 * A division is not an isolation boundary — agents on one node share memory,
 * which is why the note at the foot says so rather than leaving a reader to
 * assume otherwise. And a division never bounds an administrator: there is no
 * division-scoped admin anywhere in the product, which is what makes every
 * administration screen safe by construction.
 */
export function DivisionsView({ session, onOpenSettings, onSessionExpired }: DivisionsViewProps) {
  const [divisions, setDivisions] = useState<Division[]>([]);
  const [draft, setDraft] = useState<CreateDivision>(emptyDraft);
  const [showEditor, setShowEditor] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Division | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const { unlocked, can } = adminAccess(session);
  const canManage = can("agents:manage");

  const load = async () => {
    if (!unlocked) return;
    try {
      const { items } = await getDivisions(true);
      setDivisions(items);
      setError(null);
    } catch (cause) {
      if (cause instanceof OrcaSynapseApiError && cause.status === 401) {
        onSessionExpired();
        return;
      }
      setError(cause instanceof Error ? cause.message : "Divisions could not be loaded.");
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unlocked]);

  async function guard(work: () => Promise<void>) {
    setBusy(true);
    try {
      await work();
      setError(null);
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
      const created = await createDivision({
        slug: draft.slug,
        displayName: draft.displayName,
        ...(draft.description ? { description: draft.description } : {}),
      });
      setMessage(`${created.displayName} is ready. Assign it a profile from Agents.`);
      setDraft(emptyDraft);
      setShowEditor(false);
      await load();
    });
  };

  const setStatus = async (item: Division, status: Division["status"]) => {
    await guard(async () => {
      await updateDivision(item.id, { status, expectedRevision: item.revision });
      setMessage(status === "SUSPENDED"
        ? `${item.displayName} is suspended. Its profiles keep their assignment; no new profile can be moved into it.`
        : `${item.displayName} is active again.`);
      await load();
    });
  };

  const remove = async (item: Division) => {
    await guard(async () => {
      await deleteDivision(item.id);
      setMessage(`${item.displayName} was deleted.`);
      setConfirmDelete(null);
      await load();
    });
  };

  if (!unlocked) {
    return (
      <LockedScreen
        title="Divisions"
        mark="DV"
        reason="Sign in as an administrator to manage divisions."
        actionLabel="Open platform settings"
        onAction={onOpenSettings}
      />
    );
  }

  const active = divisions.filter(({ status }) => status === "ACTIVE").length;
  const assigned = divisions.reduce((total, item) => total + item.profileCount, 0);
  const members = divisions.reduce((total, item) => total + item.userCount, 0);

  return (
    <div className="grid gap-6">
      <PageHeader
        kicker="Access control"
        title="Divisions"
        description="Bound which agent profiles a user can see and run."
        actions={canManage ? (
          <Button onClick={() => setShowEditor((open) => !open)}>
            {showEditor ? "Cancel" : "New division"}
          </Button>
        ) : null}
      />

      {error && <Alert tone="error">{error}</Alert>}
      {message && <Alert tone="info">{message}</Alert>}

      <MetricRow>
        <Metric label="Divisions" value={String(active)} caption="Active" />
        <Metric label="Suspended" value={String(divisions.length - active)} caption="Out of use" />
        <Metric label="Assigned profiles" value={String(assigned)} caption="Bound to a division" />
        <Metric label="People" value={String(members)} caption="In a division" />
      </MetricRow>

      {showEditor && canManage && (
        <Panel>
          <PanelHeading
            title="New division"
            description="Any name you like. Nothing in the product enumerates them."
          />
          <form className="grid gap-4" onSubmit={submit}>
            <Field label="Name" hint="What operators will call it.">
              <Input
                value={draft.displayName}
                onChange={(event) => {
                  const displayName = event.target.value;
                  setDraft((current) => ({
                    ...current,
                    displayName,
                    // Follows the name until somebody edits the slug themselves,
                    // the same way the other create forms behave.
                    slug: current.slug === slugify(current.displayName) ? slugify(displayName) : current.slug,
                  }));
                }}
                required
              />
            </Field>
            <Field label="Identifier" hint="Lowercase, used in the audit trail.">
              <Input
                value={draft.slug}
                onChange={(event) => setDraft((current) => ({ ...current, slug: slugAsTyped(event.target.value) }))}
                required
              />
            </Field>
            <Field label="Description" hint="Optional.">
              <Input
                value={draft.description ?? ""}
                onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
              />
            </Field>
            <div className="mt-4 flex justify-end gap-2">
              <Button type="submit" disabled={busy}>{busy ? "Creating…" : "Create division"}</Button>
            </div>
          </form>
        </Panel>
      )}

      <Panel>
        <PanelHeading
          title="Divisions"
          description="A profile with no division stays visible to everyone."
        />
        {divisions.length === 0 ? (
          <EmptyState title="No divisions yet">
            Every agent profile is visible to every signed-in user until a division is created and
            assigned.
          </EmptyState>
        ) : (
          <ul className="grid gap-3">
            {divisions.map((item) => (
              <li key={item.id} className={cn("flex items-start justify-between gap-6 rounded-card border border-border p-4", item.status !== "ACTIVE" && "opacity-60")}>
                <div className="min-w-0">
                  <h3>{item.displayName}</h3>
                  <p>{item.description || "No description."}</p>
                  <MicroLabel>
                    {item.profileCount} profile{item.profileCount === 1 ? "" : "s"} ·{" "}
                    {item.userCount} {item.userCount === 1 ? "person" : "people"} · updated {when(item.updatedAt)}
                  </MicroLabel>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-2">
                  <StatusText tone={toneFor(item.status === "ACTIVE" ? "HEALTHY" : "DEGRADED")}>
                    {item.status === "ACTIVE" ? "Active" : "Suspended"}
                  </StatusText>
                  {canManage && (
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void setStatus(item, item.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE")}
                      >
                        {item.status === "ACTIVE" ? "Suspend" : "Reactivate"}
                      </Button>
                      <Button variant="ghost" disabled={busy} onClick={() => setConfirmDelete(item)}>
                        Delete
                      </Button>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {confirmDelete && (
        <Panel>
          <PanelHeading title={`Delete ${confirmDelete.displayName}?`} />
          <p>
            {confirmDelete.profileCount > 0 || confirmDelete.userCount > 0
              ? "This division still holds work, so it cannot be deleted. Move its profiles and people elsewhere, or suspend it instead."
              : "This division holds nothing. Deleting it cannot affect any profile or person."}
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>Keep it</Button>
            <Button disabled={busy} onClick={() => void remove(confirmDelete)}>Delete division</Button>
          </div>
        </Panel>
      )}

      <Panel>
        <PanelHeading title="What a division does, and what it does not" />
        <p>
          A division decides which agent profiles a user can see and run. A profile with no division
          is visible to everyone, which is what every profile is until you assign one.
        </p>
        <p>
          It is not an isolation boundary. Agents that run on the same Agentic System node share
          their memory and their Skills, whichever division their profile belongs to.
        </p>
        <p>
          Administrators are never bounded by a division. There is no division-scoped administrator,
          so every administration screen shows the whole deployment.
        </p>
      </Panel>
    </div>
  );
}
