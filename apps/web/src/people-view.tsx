import type { AdministratorSession, Division, Person } from "@orcasynapse/contracts";
import { useEffect, useState, type FormEvent } from "react";
import {
  OrcaSynapseApiError,
  createPerson,
  getDivisions,
  getPeople,
  resetPersonPassword,
  updatePerson,
} from "./api.js";
import { adminAccess } from "./admin-access.js";
import {
  Alert, Button, EmptyState, Field, Input, LockedScreen, Metric, MetricRow, MicroLabel,
  PageHeader, Panel, PanelHeading, Select, StatusText, cn, toneFor,
} from "./ui/index.js";

interface PeopleViewProps {
  session: AdministratorSession | null;
  onOpenSettings: () => void;
  onSessionExpired: () => void;
}

function when(value: string | null): string {
  if (!value) return "never";
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

/**
 * The people a division bounds.
 *
 * Two things this screen is careful about. A password an administrator sets is
 * shown once, here, and never again -- so it is displayed deliberately rather
 * than hidden behind a copy button that might silently fail. And a person who
 * signs in through an identity provider has no password this product holds, so
 * the reset control is absent for them rather than present and failing.
 */
export function PeopleView({ session, onOpenSettings, onSessionExpired }: PeopleViewProps) {
  const [people, setPeople] = useState<Person[]>([]);
  const [divisions, setDivisions] = useState<Division[]>([]);
  const [showEditor, setShowEditor] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [divisionId, setDivisionId] = useState("");
  const [resetting, setResetting] = useState<Person | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const { unlocked, can } = adminAccess(session);
  const canManage = can("sessions:manage");

  const load = async () => {
    if (!unlocked) return;
    try {
      const [{ items }, divisionList] = await Promise.all([getPeople(), getDivisions(false)]);
      setPeople(items);
      setDivisions(divisionList.items);
      setError(null);
    } catch (cause) {
      if (cause instanceof OrcaSynapseApiError && cause.status === 401) {
        onSessionExpired();
        return;
      }
      setError(cause instanceof Error ? cause.message : "People could not be loaded.");
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
      const created = await createPerson({
        displayName, username, password,
        ...(divisionId ? { divisionId } : {}),
      });
      setMessage(
        `${created.displayName} can sign in as “${username}” with the password you set. `
        + "They will be asked to change it, and this is the only time it is shown.",
      );
      setDisplayName(""); setUsername(""); setPassword(""); setDivisionId("");
      setShowEditor(false); setError(null);
      await load();
    });
  };

  const setEnabled = async (person: Person, enabled: boolean) => {
    await guard(async () => {
      await updatePerson(person.id, { enabled });
      setMessage(enabled
        ? `${person.displayName} can sign in again.`
        : `${person.displayName} is disabled, and any session they had open has ended.`);
      setError(null);
      await load();
    });
  };

  const move = async (person: Person, next: string) => {
    await guard(async () => {
      await updatePerson(person.id, { divisionId: next || null });
      setError(null);
      await load();
    });
  };

  const reset = async (event: FormEvent) => {
    event.preventDefault();
    if (!resetting) return;
    await guard(async () => {
      await resetPersonPassword(resetting.id, newPassword);
      setMessage(
        `${resetting.displayName} can sign in with the new password. `
        + "Their open sessions have ended and they will be asked to change it.",
      );
      setResetting(null); setNewPassword(""); setError(null);
      await load();
    });
  };

  if (!unlocked) {
    return (
      <LockedScreen
        title="People"
        mark="PE"
        reason="Sign in as an administrator to manage people."
        actionLabel="Open platform settings"
        onAction={onOpenSettings}
      />
    );
  }

  const enabled = people.filter((person) => person.enabled).length;
  const local = people.filter((person) => person.credential === "LOCAL").length;
  const assigned = people.filter((person) => person.divisionId !== null).length;

  return (
    <div className="grid gap-6">
      <PageHeader
        kicker="Access control"
        title="People"
        description="Who can sign in, and which division bounds what they see."
        actions={canManage ? (
          <Button onClick={() => setShowEditor((open) => !open)}>
            {showEditor ? "Cancel" : "Add person"}
          </Button>
        ) : null}
      />

      {error && <Alert tone="error">{error}</Alert>}
      {message && <Alert tone="info">{message}</Alert>}

      <MetricRow>
        <Metric label="People" value={String(enabled)} caption="Able to sign in" />
        <Metric label="Disabled" value={String(people.length - enabled)} caption="Blocked" />
        <Metric label="Local accounts" value={String(local)} caption="Password held here" />
        <Metric label="In a division" value={String(assigned)} caption="Bounded" />
      </MetricRow>

      {showEditor && canManage && (
        <Panel>
          <PanelHeading
            title="Add a person"
            description="They sign in with this username and password, and are asked to change it."
          />
          <form className="grid gap-4" onSubmit={submit}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name">
                <Input required minLength={2} value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
              </Field>
              <Field label="Username" hint="Lowercase. This is what they type to sign in.">
                <Input
                  required
                  pattern="[a-z0-9]+([._-][a-z0-9]+)*"
                  value={username}
                  onChange={(event) => setUsername(event.target.value.toLowerCase())}
                />
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Temporary password" hint="At least 12 characters. Shown once, here.">
                <Input required minLength={12} value={password} onChange={(event) => setPassword(event.target.value)} />
              </Field>
              <Field label="Division" hint="Leave empty and they see only deployment-wide agents.">
                <Select value={divisionId} onChange={(event) => setDivisionId(event.target.value)}>
                  <option value="">No division</option>
                  {divisions.map((item) => (
                    <option key={item.id} value={item.id}>{item.displayName}</option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="flex justify-end">
              <Button type="submit" variant="primary" disabled={busy}>
                {busy ? "Creating…" : "Create person"}
              </Button>
            </div>
          </form>
        </Panel>
      )}

      {resetting && (
        <Panel>
          <PanelHeading
            title={`Set a new password for ${resetting.displayName}`}
            description="Their open sessions end immediately, and they are asked to change it at next sign-in."
          />
          <form className="grid gap-4" onSubmit={reset}>
            <Field label="New password" hint="At least 12 characters. Shown once, here.">
              <Input required minLength={12} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
            </Field>
            <div className="flex justify-end gap-2">
              <Button onClick={() => { setResetting(null); setNewPassword(""); }}>Cancel</Button>
              <Button type="submit" variant="primary" disabled={busy}>Set password</Button>
            </div>
          </form>
        </Panel>
      )}

      <Panel>
        <PanelHeading title="People" description="Everyone this deployment knows about." />
        {people.length === 0 ? (
          <EmptyState title="Nobody yet">
            Divisions bound what a person can see, so a deployment with no people has a boundary and
            nobody to apply it to. Add somebody to start.
          </EmptyState>
        ) : (
          <div className="grid gap-2">
            {people.map((person) => (
              <article
                key={person.id}
                className={cn(
                  "flex items-start justify-between gap-4 rounded border border-border p-3",
                  !person.enabled && "opacity-60",
                )}
              >
                <div className="min-w-0">
                  <strong className="block text-label font-semibold text-text">{person.displayName}</strong>
                  <p className="mb-0 mt-0.5 text-caption text-muted">
                    {person.credential === "LOCAL" ? person.username : "Signs in through your identity provider"}
                  </p>
                  <MicroLabel className="mt-1 block">
                    last signed in {when(person.lastLoginAt)}
                    {person.lockedUntil ? " · locked out" : ""}
                    {person.passwordChangeRequired && person.credential === "LOCAL" ? " · must change password" : ""}
                  </MicroLabel>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <StatusText tone={toneFor(person.enabled ? "HEALTHY" : "DEGRADED")}>
                    {person.enabled ? "Active" : "Disabled"}
                  </StatusText>
                  {canManage && (
                    <>
                      <Select
                        className="h-8 w-[190px] text-caption"
                        value={person.divisionId ?? ""}
                        disabled={busy}
                        onChange={(event) => void move(person, event.target.value)}
                      >
                        <option value="">No division</option>
                        {divisions.map((item) => (
                          <option key={item.id} value={item.id}>{item.displayName}</option>
                        ))}
                      </Select>
                      {/* Absent, not disabled, for a federated person: this
                          product holds no password for them to reset. */}
                      {person.credential === "LOCAL" && (
                        <Button variant="ghost" disabled={busy} onClick={() => setResetting(person)}>
                          Reset password
                        </Button>
                      )}
                      <Button variant="ghost" disabled={busy} onClick={() => void setEnabled(person, !person.enabled)}>
                        {person.enabled ? "Disable" : "Enable"}
                      </Button>
                    </>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
