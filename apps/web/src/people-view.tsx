import type { AdministratorSession, CreateDivision, Division, Person } from "@orcasynapse/contracts";
import { KeyRound, Layers, LockKeyhole, Trash2, Users } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import {
  OrcaSynapseApiError,
  createDivision,
  createPerson,
  deleteDivision,
  getDivisions,
  getPeople,
  resetPersonPassword,
  updateDivision,
  updatePerson,
} from "./api.js";
import { adminAccess } from "./admin-access.js";
import { slugAsTyped, slugify } from "./slug.js";
import {
  Alert, Button, Dialog, Field, Input, LockedScreen, Mark, Metric, MetricRow, MicroLabel,
  Panel, Select, StatusText, WorkspaceDock, WorkspaceIntro, cn,
} from "./ui/index.js";

interface PeopleViewProps {
  session: AdministratorSession | null;
  onOpenSettings: () => void;
  onSessionExpired: () => void;
}

const emptyDivisionDraft: CreateDivision = { slug: "", displayName: "", description: "" };

function when(value: string | null): string {
  if (!value) return "never";
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? parts[0]?.[1] ?? ""}`;
  return letters.toUpperCase() || "·";
}

/**
 * Why one of this screen's two panels has no data, in the words the panel will
 * use to say so.
 *
 * `refused` separates a 403 from every other failure, and the distinction is
 * the whole reason this type exists rather than a `string | null`. A load
 * failure is a thing that went wrong and might not go wrong next time, so an
 * operator is right to reload. A refusal is a stable fact about their role --
 * reloading will refuse again -- and telling them "could not be loaded" invites
 * them to keep trying something that will never work.
 */
interface PanelFailure {
  refused: boolean;
  message: string;
}

/**
 * The two panels' data, and where the round trip that fetches it can go wrong.
 *
 * `Promise.allSettled`, not `Promise.all`, and this is the single line on this
 * screen that the session every developer signs in with cannot check by hand.
 *
 * The two panels are behind different scopes, and the difference is not
 * symmetric. People is `sessions:manage` end to end
 * (`apps/api/src/people/routes.ts`); divisions read on `agents:read` and write
 * on `agents:manage` (`apps/api/src/divisions/routes.ts`). Against `ROLE_SCOPES`
 * in `apps/api/src/auth/admin-session.ts`, PLATFORM_ADMIN and SECURITY_ADMIN
 * hold both, and **OPERATIONS_ADMIN and AUDITOR hold `agents:read` without
 * `sessions:manage`** -- they may read divisions and are refused people
 * outright.
 *
 * Before the merge those two facts lived on two screens and failed
 * independently: an OPERATIONS_ADMIN opening People got an error, and the
 * Divisions tab beside it still worked. One `Promise.all` would have turned
 * that into a regression -- a single 403 on `getPeople()` rejects the pair and
 * blanks a divisions panel that would have drawn perfectly. So each panel
 * renders from its own outcome, and neither can take the other down.
 *
 * A PLATFORM_ADMIN session holds every scope and never produces this, which is
 * why `people-view.test.tsx` drives it with an OPERATIONS_ADMIN session rather
 * than leaving it to be noticed.
 */
function failureFrom(reason: unknown, refusal: string, fallback: string): PanelFailure {
  if (reason instanceof OrcaSynapseApiError && reason.status === 403) {
    return { refused: true, message: refusal };
  }
  return { refused: false, message: reason instanceof Error ? reason.message : fallback };
}

/*
 * Neither sentence says the other panel is fine, which is the version these
 * started as. It reads better and it can be false: a refusal on one request and
 * an unrelated network failure on the other are independent events, and this
 * copy would then be contradicted by the alert directly beneath it. What is
 * always true is that the *refusal* has no bearing on the rest of the screen,
 * so that is what they claim.
 */
const PEOPLE_REFUSED =
  "Your administrator role cannot see people. Reading this list needs the session scope that "
  + "manages sign-in, which a platform or security administrator holds. Nothing else on this "
  + "screen depends on it.";

const DIVISIONS_REFUSED =
  "Your administrator role cannot see divisions. Nothing else on this screen depends on it.";

/**
 * People and the divisions that bound them: one screen, two panels.
 *
 * These were two Settings tabs until v8.9.0, and they were always one job --
 * who is in the organisation and how they are grouped. The split had a
 * measurable cost rather than an untidy one. An administrator adding somebody
 * to a division that does not exist yet had to leave a half-typed person form
 * for the Divisions tab, and `app.tsx` renders through a closed lookup, so
 * changing tab unmounted this component and discarded four `useState` values
 * including the temporary password. Nothing persisted it and nothing warned.
 * The **New division** control in the person form is what removes that round
 * trip; the merge is what makes the control possible.
 *
 * People first and divisions second because of what the administrator arrives
 * holding: a *person*, for whom the division is an attribute. Divisions is also
 * the shorter list -- a deployment has tens of people and a handful of
 * divisions.
 *
 * Behaviours carried over rather than re-derived, each because it was got wrong
 * once already. A password an administrator sets is shown once, here, and never
 * again -- so it is displayed deliberately rather than hidden behind a copy
 * button that might silently fail. A person who signs in through an identity
 * provider has no password this product holds, so the reset control is absent
 * for them rather than present and failing. A division that still holds work
 * refuses deletion by naming what is in the way. And every division mutation
 * carries `expectedRevision`.
 */
export function PeopleView({ session, onOpenSettings, onSessionExpired }: PeopleViewProps) {
  const [people, setPeople] = useState<Person[]>([]);
  const [divisions, setDivisions] = useState<Division[]>([]);
  const [peopleFailure, setPeopleFailure] = useState<PanelFailure | null>(null);
  const [divisionsFailure, setDivisionsFailure] = useState<PanelFailure | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [divisionId, setDivisionId] = useState("");
  const [resetting, setResetting] = useState<Person | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<Division | null>(null);
  /*
   * The division dialog's own state, deliberately separate from everything
   * above. `busy` and `error` below belong to the person form and the row
   * controls; a division that fails to create must leave the person draft
   * exactly as it was, and sharing either field is the easiest way to break
   * that without noticing.
   *
   * `divisionDialogFor` doubles as the open flag and as where the dialog was
   * opened from, because the two entry points want different things on success:
   * one is answering "this person needs a division that does not exist", and
   * should select the new division in the form underneath; the other is the
   * divisions panel's own New division button, which should not reach into a
   * person form the administrator has not opened.
   */
  const [divisionDialogFor, setDivisionDialogFor] = useState<"person-form" | "divisions" | null>(null);
  const [divisionDraft, setDivisionDraft] = useState<CreateDivision>(emptyDivisionDraft);
  const [divisionBusy, setDivisionBusy] = useState(false);
  const [divisionError, setDivisionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const { unlocked, can } = adminAccess(session);
  /*
   * Two gates, kept per panel rather than collapsed into one. Picking either
   * would be wrong in one direction: `sessions:manage` alone hides division
   * management from a role that has it, and `agents:manage` alone offers person
   * management to a role the API will refuse.
   */
  const canManagePeople = can("sessions:manage");
  const canManageDivisions = can("agents:manage");

  const load = async () => {
    if (!unlocked) return;
    const [peopleOutcome, divisionOutcome] = await Promise.allSettled([getPeople(), getDivisions(true)]);

    /*
     * A 401 is not a per-panel fact. The session is gone for both, and this
     * screen answers it the way every other one does -- before either outcome
     * is written, so an expiring session does not paint two refusal notices on
     * its way out to the sign-in dialog.
     */
    for (const outcome of [peopleOutcome, divisionOutcome]) {
      if (outcome.status === "rejected"
        && outcome.reason instanceof OrcaSynapseApiError
        && outcome.reason.status === 401) {
        onSessionExpired();
        return;
      }
    }

    if (peopleOutcome.status === "fulfilled") {
      setPeople(peopleOutcome.value.items);
      setPeopleFailure(null);
    } else {
      const failure = failureFrom(peopleOutcome.reason, PEOPLE_REFUSED, "People could not be loaded.");
      // Cleared on a refusal and kept on a failure. A refusal says the operator
      // may not see this, so continuing to draw a list they were served earlier
      // would contradict it; a network blip says nothing about the rows already
      // on screen, and blanking them loses information for no reason.
      if (failure.refused) setPeople([]);
      setPeopleFailure(failure);
    }

    if (divisionOutcome.status === "fulfilled") {
      setDivisions(divisionOutcome.value.items);
      setDivisionsFailure(null);
    } else {
      const failure = failureFrom(divisionOutcome.reason, DIVISIONS_REFUSED, "Divisions could not be loaded.");
      if (failure.refused) setDivisions([]);
      setDivisionsFailure(failure);
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
      const created = await createPerson({
        displayName, username, password,
        ...(divisionId ? { divisionId } : {}),
      });
      setMessage(
        `${created.displayName} can sign in as “${username}” with the password you set. `
        + "They will be asked to change it, and this is the only time it is shown.",
      );
      setDisplayName(""); setUsername(""); setPassword(""); setDivisionId("");
      setShowEditor(false);
      await load();
    });
  };

  const setEnabled = async (person: Person, enabled: boolean) => {
    await guard(async () => {
      await updatePerson(person.id, { enabled });
      setMessage(enabled
        ? `${person.displayName} can sign in again.`
        : `${person.displayName} is disabled, and any session they had open has ended.`);
      await load();
    });
  };

  const move = async (person: Person, next: string) => {
    await guard(async () => {
      await updatePerson(person.id, { divisionId: next || null });
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
      setResetting(null); setNewPassword("");
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

  const openDivisionDialog = (from: "person-form" | "divisions") => {
    setDivisionDraft(emptyDivisionDraft);
    setDivisionError(null);
    setDivisionDialogFor(from);
  };

  /*
   * The division create, and the one path on this screen whose failure case is
   * the point rather than an edge.
   *
   * Deliberately not routed through `guard`. `guard` writes the page-level
   * error and shares `busy` with the person form; this has to report inside the
   * dialog, leave the dialog open on the draft that failed, and touch none of
   * the four person-form fields -- the temporary password above all, which is
   * shown once and cannot be recovered by reloading.
   */
  const submitDivision = async (event: FormEvent) => {
    event.preventDefault();
    const from = divisionDialogFor;
    setDivisionBusy(true);
    try {
      const created = await createDivision({
        slug: divisionDraft.slug,
        displayName: divisionDraft.displayName,
        ...(divisionDraft.description ? { description: divisionDraft.description } : {}),
      });
      // Reloaded before the id is selected, not after: the select renders its
      // options from `divisions`, and setting a value with no matching option
      // shows the person form's first option instead -- "No division", which is
      // the opposite of what just happened.
      await load();
      if (from === "person-form") setDivisionId(created.id);
      setMessage(from === "person-form"
        ? `${created.displayName} is ready and selected below. Assign it a profile from Agents.`
        : `${created.displayName} is ready. Assign it a profile from Agents.`);
      setDivisionDraft(emptyDivisionDraft);
      setDivisionError(null);
      setDivisionDialogFor(null);
    } catch (cause) {
      if (cause instanceof OrcaSynapseApiError && cause.status === 401) {
        onSessionExpired();
        return;
      }
      setDivisionError(cause instanceof Error ? cause.message : "The division could not be created.");
    } finally {
      setDivisionBusy(false);
    }
  };

  if (!unlocked) {
    return (
      <LockedScreen
        title="Access"
        mark="AC"
        reason="Sign in as an administrator to manage people and divisions."
        actionLabel="Open Settings"
        onAction={onOpenSettings}
      />
    );
  }

  const enabled = people.filter((person) => person.enabled).length;
  const activeDivisions = divisions.filter(({ status }) => status === "ACTIVE").length;
  /*
   * Counted from the divisions rather than from `people.filter(divisionId !==
   * null)`, which is the same number from the other side. The division rows
   * carry a server-counted `userCount`, so this metric still reads correctly
   * for a role that may see divisions and not people -- and it is the API's
   * count rather than this screen's arithmetic over a list it was allowed to
   * fetch.
   */
  const members = divisions.reduce((total, item) => total + item.userCount, 0);
  // An em dash rather than a zero wherever a panel has no data *and* a reason
  // why. Zero is a fact about the deployment; this is a fact about the request.
  const peopleUnknown = peopleFailure !== null && people.length === 0;
  const divisionsUnknown = divisionsFailure !== null && divisions.length === 0;
  const count = (value: number, unknown: boolean) => (unknown ? "—" : String(value));

  /*
   * Active divisions only, wherever a person is being *put* somewhere.
   *
   * The two screens this one merges asked the API different questions -- People
   * called `getDivisions(false)` and Divisions called `getDivisions(true)` --
   * because they wanted different lists. A suspended division must still be
   * listed, so it can be reactivated, and must not be offered as somewhere to
   * put a person. One screen asks the wider question once and narrows here,
   * which keeps both behaviours without the merge costing a third round trip.
   */
  const assignable = divisions.filter(({ status }) => status === "ACTIVE");

  /*
   * What one person's division select may show: the assignable list, plus their
   * own division when it has been suspended underneath them.
   *
   * Without the second half, a person in a suspended division renders a select
   * whose value matches no option, and the browser shows the first one --
   * "No division" -- for somebody who is in one. That misreport existed before
   * the merge and was invisible, because the fact that contradicted it was on
   * the other tab. It is on the same page now.
   */
  const optionsFor = (person: Person): Division[] => {
    const own = divisions.find(({ id }) => id === person.divisionId);
    return own && own.status !== "ACTIVE" ? [...assignable, own] : assignable;
  };

  return (
    <div className="workspace-stack people-workspace flex h-full min-h-0 flex-col gap-3 pb-3">
      <WorkspaceIntro
        icon={<LockKeyhole className="size-4" aria-hidden="true" />}
        title="Access"
        actions={
          <>
            {canManageDivisions ? (
              <Button onClick={() => openDivisionDialog("divisions")}>New division</Button>
            ) : null}
            {canManagePeople ? (
              <Button variant={showEditor ? "outline" : "primary"} onClick={() => setShowEditor((open) => !open)}>
                {showEditor ? "Cancel" : "Add person"}
              </Button>
            ) : null}
          </>
        }
      />

      {error ? <Alert className="shrink-0" tone="error">{error}</Alert> : null}
      {message ? <Alert className="shrink-0" tone="good">{message}</Alert> : null}

      {/*
        * Four metrics, where the two screens carried eight between them. The
        * three dropped -- Local accounts, Suspended divisions, Assigned
        * profiles -- are all still readable where they are acted on: every
        * division row states its own profile and people counts, which is where
        * an administrator about to suspend something looks, and every person
        * row says whether they are local or federated.
        */}
      <WorkspaceDock>
        <MetricRow className="border-b-0 pb-0 lg:grid-cols-4">
          <Metric label="People" value={count(enabled, peopleUnknown)} caption="Able to sign in" />
          <Metric label="Disabled" value={count(people.length - enabled, peopleUnknown)} caption="Blocked" />
          <Metric label="Divisions" value={count(activeDivisions, divisionsUnknown)} caption="Active" />
          <Metric label="In a division" value={count(members, divisionsUnknown)} caption="Bounded" />
        </MetricRow>
      </WorkspaceDock>

      {showEditor && canManagePeople ? (
        <Panel className="shrink-0">
          <form id="add-person-form" className="grid gap-5" onSubmit={submit}>
          <div>
            <h2 className="m-0 font-display text-[17px] font-semibold tracking-[-0.02em] text-text">Add a person</h2>
            <p className="mb-0 mt-1.5 max-w-[62ch] text-body text-muted">
              They sign in with this username and password, and are asked to change it.
            </p>
          </div>
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
            <div className="grid content-start gap-1.5">
              <Field label="Division" hint="Leave empty and they see only deployment-wide agents.">
                <Select value={divisionId} onChange={(event) => setDivisionId(event.target.value)}>
                  <option value="">No division</option>
                  {assignable.map((item) => (
                    <option key={item.id} value={item.id}>{item.displayName}</option>
                  ))}
                </Select>
              </Field>
              {/*
                * The control this whole consolidation exists for. The division
                * the administrator needs is very often the one that does not
                * exist yet -- on a fresh deployment it always is, because the
                * first person is created before any division -- and before
                * this button the only way to make it was to leave, which threw
                * the typed name, username and temporary password away.
                */}
              {canManageDivisions ? (
                <Button size="sm" className="justify-self-start" onClick={() => openDivisionDialog("person-form")}>
                  New division
                </Button>
              ) : null}
            </div>
          </div>
          <div className="flex justify-end">
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? "Creating…" : "Create person"}
            </Button>
          </div>
          </form>
        </Panel>
      ) : null}

      <div className="grid min-h-0 flex-1 gap-3 overflow-hidden lg:grid-cols-2">
        <Panel className="flex min-h-0 min-w-0 flex-col overflow-hidden p-3" aria-label="People">
          <div className="mb-2 flex shrink-0 items-start gap-3">
            <Mark size="sm"><Users className="size-4" aria-hidden="true" /></Mark>
            <div className="min-w-0">
              <h2 className="m-0 font-display text-[17px] font-semibold tracking-[-0.02em] text-text">People</h2>
              <p className="mb-0 mt-1 text-caption text-muted">Everyone this deployment knows about.</p>
            </div>
          </div>
          <div className="grid min-h-0 flex-1 content-start overflow-y-auto">
          {peopleFailure ? (
            <Alert tone={peopleFailure.refused ? "info" : "error"}>{peopleFailure.message}</Alert>
          ) : null}
          {people.length === 0 ? (
            peopleFailure ? null : (
              <div className="grid gap-1.5 border-t border-border py-5">
                <strong className="text-body font-semibold text-foreground">Nobody yet</strong>
                <p className="m-0 max-w-[62ch] text-body text-muted">
                  Divisions bound what a person can see, so a deployment with no people has a boundary and
                  nobody to apply it to. Add somebody to start.
                </p>
              </div>
            )
          ) : people.map((person) => (
            <article
              key={person.id}
              className={cn(
                "grid gap-3 border-t border-border py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center",
                !person.enabled && "opacity-60",
              )}
            >
              <div className="flex min-w-0 items-start gap-3">
                <span
                  aria-hidden="true"
                  className="grid h-9 w-9 shrink-0 place-items-center border border-border-strong bg-surface font-mono text-[10px] font-bold text-accent"
                >
                  {initials(person.displayName)}
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong className="text-label font-semibold text-text">{person.displayName}</strong>
                    {/* The tone directly, not through `toneFor`: its vocabulary
                        is lower case, so `toneFor("HEALTHY")` matched nothing and
                        both arms of this came back neutral -- an enabled and a
                        disabled account were the same grey. There is no readiness
                        string behind a boolean to translate, so translating one
                        through a case-sensitive lookup was only ever a way to
                        lose the colour. */}
                    <StatusText tone={person.enabled ? "good" : "warn"}>
                      {person.enabled ? "Active" : "Disabled"}
                    </StatusText>
                  </div>
                  <p className="mb-0 mt-0.5 text-caption text-muted">
                    {person.credential === "LOCAL" ? person.username : "Signs in through your identity provider"}
                  </p>
                  <MicroLabel className="mt-1 block">
                    last signed in {when(person.lastLoginAt)}
                    {person.lockedUntil ? " · locked out" : ""}
                    {person.passwordChangeRequired && person.credential === "LOCAL" ? " · must change password" : ""}
                  </MicroLabel>
                </div>
              </div>
              {canManagePeople ? (
                <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                  <Select
                    className="h-8 w-[190px] text-caption"
                    aria-label={`Division for ${person.displayName}`}
                    value={person.divisionId ?? ""}
                    disabled={busy}
                    onChange={(event) => void move(person, event.target.value)}
                  >
                    <option value="">No division</option>
                    {optionsFor(person).map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.status === "ACTIVE" ? item.displayName : `${item.displayName} (suspended)`}
                      </option>
                    ))}
                  </Select>
                  {person.credential === "LOCAL" ? (
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => setResetting(person)}>
                      Reset password
                    </Button>
                  ) : null}
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => void setEnabled(person, !person.enabled)}>
                    {person.enabled ? "Disable" : "Enable"}
                  </Button>
                </div>
              ) : null}
            </article>
          ))}
          </div>
        </Panel>

        <Panel className="flex min-h-0 min-w-0 flex-col overflow-hidden p-3" aria-label="Divisions">
          <div className="mb-2 flex shrink-0 items-start gap-3">
            <Mark size="sm"><Layers className="size-4" aria-hidden="true" /></Mark>
            <div className="min-w-0">
              <h2 className="m-0 font-display text-[17px] font-semibold tracking-[-0.02em] text-text">Divisions</h2>
              <p className="mb-0 mt-1 text-caption text-muted">A profile with no division stays visible to everyone.</p>
            </div>
          </div>
          <div className="grid min-h-0 flex-1 content-start overflow-y-auto">
          {divisionsFailure ? (
            <Alert tone={divisionsFailure.refused ? "info" : "error"}>{divisionsFailure.message}</Alert>
          ) : null}
          {divisions.length === 0 ? (
            divisionsFailure ? null : (
              <div className="grid gap-1.5 border-t border-border py-5">
                <strong className="text-body font-semibold text-foreground">No divisions yet</strong>
                <p className="m-0 max-w-[62ch] text-body text-muted">
                  Every agent profile is visible to every signed-in user until a division is created and
                  assigned.
                </p>
              </div>
            )
          ) : (
            <ul className="m-0 grid list-none gap-0 p-0">
              {divisions.map((item) => (
                <li
                  key={item.id}
                  className={cn(
                    "grid gap-3 border-t border-border py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center",
                    item.status !== "ACTIVE" && "opacity-60",
                  )}
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="m-0 font-display text-[15px] font-semibold tracking-[-0.01em] text-text">
                        {item.displayName}
                      </h3>
                      <StatusText tone={item.status === "ACTIVE" ? "good" : "warn"}>
                        {item.status === "ACTIVE" ? "Active" : "Suspended"}
                      </StatusText>
                    </div>
                    <p className="mb-0 mt-1 text-caption text-muted">{item.description || "No description."}</p>
                    <MicroLabel className="mt-1 block">
                      {item.profileCount} profile{item.profileCount === 1 ? "" : "s"} ·{" "}
                      {item.userCount} {item.userCount === 1 ? "person" : "people"} · updated {when(item.updatedAt)}
                    </MicroLabel>
                  </div>
                  {canManageDivisions ? (
                    <div className="flex flex-wrap gap-1 sm:justify-end">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => void setStatus(item, item.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE")}
                      >
                        {item.status === "ACTIVE" ? "Suspend" : "Reactivate"}
                      </Button>
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmDelete(item)}>
                        Delete
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          </div>
        </Panel>
      </div>

      {resetting ? (
        <Dialog
          open
          icon={KeyRound}
          title={`Set a new password for ${resetting.displayName}`}
          description="Their open sessions end immediately, and they are asked to change it at next sign-in."
          onClose={() => { setResetting(null); setNewPassword(""); }}
          footer={
            <>
              <Button onClick={() => { setResetting(null); setNewPassword(""); }}>Cancel</Button>
              <Button variant="primary" type="submit" form="reset-person-password" disabled={busy}>
                Set password
              </Button>
            </>
          }
        >
          <form id="reset-person-password" className="grid gap-5" onSubmit={reset}>
            <Field label="New password" hint="At least 12 characters. Shown once, here.">
              <Input required minLength={12} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
            </Field>
          </form>
        </Dialog>
      ) : null}

      {confirmDelete ? (
        <Dialog
          open
          icon={Trash2}
          title={`Delete ${confirmDelete.displayName}?`}
          description={
            confirmDelete.profileCount > 0 || confirmDelete.userCount > 0
              ? "This division still holds work, so it cannot be deleted. Move its profiles and people elsewhere, or suspend it instead."
              : "This division holds nothing. Deleting it cannot affect any profile or person."
          }
          onClose={() => { if (!busy) setConfirmDelete(null); }}
          footer={
            <>
              <Button onClick={() => setConfirmDelete(null)}>Keep it</Button>
              <Button variant="danger" disabled={busy} onClick={() => void remove(confirmDelete)}>
                Delete division
              </Button>
            </>
          }
        >
          {null}
        </Dialog>
      ) : null}

      {/*
        * A centred `Dialog`, never the right-hand `Drawer`: Setup's panels moved
        * off the edge across v6.0.1 and v6.0.3 because a panel sliding in over
        * the screen it serves covers the thing it is explaining, and this one
        * exists precisely to keep the person form visible behind it.
        *
        * It renders here, at the top level, rather than inside the person form's
        * JSX where it reads as belonging. `DialogPortal` in this design system
        * is a fragment -- the dialog stays in the tree it is written in -- so
        * writing it inside `<form>` would nest a form in a form, which is
        * invalid HTML and makes the inner submit ambiguous. The affordance is in
        * the form; the element cannot be.
        */}
      <Dialog
        open={divisionDialogFor !== null}
        onClose={() => { if (!divisionBusy) setDivisionDialogFor(null); }}
        icon={Layers}
        title="New division"
        description="Any name you like. Nothing in the product enumerates them."
        footer={
          <>
            <Button disabled={divisionBusy} onClick={() => setDivisionDialogFor(null)}>Cancel</Button>
            <Button type="submit" form="new-division-form" variant="primary" disabled={divisionBusy}>
              {divisionBusy ? "Creating…" : "Create division"}
            </Button>
          </>
        }
      >
        <form id="new-division-form" className="grid gap-5" onSubmit={submitDivision}>
          {divisionError ? <Alert tone="error">{divisionError}</Alert> : null}
          <Field label="Name" hint="What operators will call it.">
            <Input
              value={divisionDraft.displayName}
              onChange={(event) => {
                const nextName = event.target.value;
                setDivisionDraft((current) => ({
                  ...current,
                  displayName: nextName,
                  slug: current.slug === slugify(current.displayName) ? slugify(nextName) : current.slug,
                }));
              }}
              required
            />
          </Field>
          <Field label="Identifier" hint="Lowercase, used in the audit trail.">
            <Input
              value={divisionDraft.slug}
              onChange={(event) => setDivisionDraft((current) => ({ ...current, slug: slugAsTyped(event.target.value) }))}
              required
            />
          </Field>
          <Field label="Description" hint="Optional.">
            <Input
              value={divisionDraft.description ?? ""}
              onChange={(event) => setDivisionDraft((current) => ({ ...current, description: event.target.value }))}
            />
          </Field>
        </form>
      </Dialog>
    </div>
  );
}
