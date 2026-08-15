import type {
  AdministratorSession,
  GovernedTool,
  HermesRuntimeCatalogue,
  ToolsetAdmission,
} from "@orcasynapse/contracts";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Switch } from "@/components/ui/switch";
import {
  OrcaSynapseApiError,
  decideToolsetAdmission,
  getGovernedTools,
  getRuntimeCatalogue,
  getToolsetAdmissions,
} from "./api.js";
import { adminAccess } from "./admin-access.js";
import {
  Alert, Button, EmptyState, Field, Input, LockedScreen, MicroLabel,
  PageHeader, Panel, PanelHeading, StatusText, Tile, cn,
} from "./ui/index.js";

interface ToolingViewProps {
  session: AdministratorSession | null;
  onConfigure: () => void;
  onSessionExpired: () => void;
}

/**
 * The one tool the runtime is permitted to run whether or not anybody allowed it.
 *
 * `HermesClient.assertAdmittedToolBoundaryFor` adds this to the permitted set
 * unconditionally. Two things follow, and the screen got both wrong before: an
 * enabled `memory` is never drift, and a switch on it would be a control that
 * cannot change the outcome. It is drawn as a fixed, locked-on row instead —
 * omitting it made "0 allowed" read as "my agents can do nothing", which is the
 * opposite of what the boundary does.
 */
const BASELINE = "memory";

/**
 * One row of the list: a tool group the runtime reports, or a decision this
 * installation recorded about one it has not.
 */
interface ToolRow {
  name: string;
  label: string | null;
  toolCount: number;
  /** Switched on inside the runtime's own managed policy. */
  enabled: boolean;
  /** The runtime told us about it. False for a decision staged ahead of time. */
  reported: boolean;
  /** This installation permits it. Always true for the baseline. */
  permitted: boolean;
  baseline: boolean;
  reason: string | null;
}

function plural(count: number, singular: string, plural_ = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural_}`;
}

/**
 * Agent Tools was two screens wearing one hat.
 *
 * One plane is live: the runtime runs its own tools, OrcaSynapse never sees an
 * individual call, and permitting a whole tool group is the entire lever. The
 * other — a gateway, a tool registry, exact-version grants, approvals and a
 * call ledger for tools OrcaSynapse executes itself — cannot execute anything
 * in this build and never has: nothing seeds `GovernedTool`, there is no route
 * to create one, and `DrizzleToolingManager.executeHandler` throws for every
 * handler key. Half the screen therefore asked an administrator to reason about
 * grants, scopes and approvals for tools that do not exist, which is most of
 * why it read as incomprehensible.
 *
 * That half is gone. What remains is the live plane as a list you can read and
 * a switch you can throw, plus one tripwire: if a release ever registers an MCP
 * tool, the screen says so rather than hiding a subsystem that came back.
 */
export function ToolingView({ session, onConfigure, onSessionExpired }: ToolingViewProps) {
  const [admissions, setAdmissions] = useState<ToolsetAdmission[]>([]);
  const [catalogue, setCatalogue] = useState<HermesRuntimeCatalogue | null>(null);
  // "Unread" and "read, and empty" are different governance states, and
  // conflating them hid an unreachable runtime behind a reassuring empty list.
  const [catalogueRead, setCatalogueRead] = useState(true);
  const [mcpTools, setMcpTools] = useState<GovernedTool[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState<{ name: string; next: boolean } | null>(null);
  const [reason, setReason] = useState("");
  const [stagedName, setStagedName] = useState("");
  const [stagedReason, setStagedReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { unlocked, scopes } = adminAccess(session);
  const canManage = scopes.includes("tools:manage");

  /**
   * Everything the runtime reports, plus anything this installation decided
   * about that it has not.
   *
   * A decision on an unreported tool still belongs on screen: hiding it would
   * make a revocation look like it had already taken effect.
   */
  const rows = useMemo((): ToolRow[] => {
    const decisions = new Map(admissions.map((entry) => [entry.toolsetName, entry]));
    const reported = catalogue?.toolsets ?? [];
    const list: ToolRow[] = reported
      .filter(({ name }) => name !== BASELINE)
      .map((toolset) => ({
        name: toolset.name,
        label: toolset.label,
        toolCount: toolset.toolCount,
        enabled: toolset.enabled,
        reported: true,
        permitted: decisions.get(toolset.name)?.admitted === true,
        baseline: false,
        reason: decisions.get(toolset.name)?.reason ?? null,
      }));
    const known = new Set(list.map(({ name }) => name));
    for (const entry of admissions) {
      if (known.has(entry.toolsetName) || entry.toolsetName === BASELINE) continue;
      list.push({
        name: entry.toolsetName,
        label: null,
        toolCount: 0,
        enabled: false,
        reported: false,
        permitted: entry.admitted,
        baseline: false,
        reason: entry.reason,
      });
    }
    list.sort((left, right) => left.name.localeCompare(right.name));

    const memory = reported.find(({ name }) => name === BASELINE) ?? null;
    return [{
      name: BASELINE,
      label: memory?.label ?? null,
      toolCount: memory?.toolCount ?? 0,
      enabled: memory?.enabled ?? false,
      reported: memory !== null,
      permitted: true,
      baseline: true,
      reason: null,
    }, ...list];
  }, [catalogue, admissions]);

  const others = useMemo(() => rows.filter(({ baseline }) => !baseline), [rows]);
  const allowed = useMemo(() => others.filter(({ permitted }) => permitted), [others]);
  // What the boundary is refusing runs over. The baseline cannot appear here:
  // it is permitted by construction.
  const drifted = useMemo(
    () => others.filter((row) => row.enabled && !row.permitted).map(({ name }) => name),
    [others],
  );

  /** The answer to "what can my agents do right now", stated rather than counted. */
  const summary = useMemo((): { tone: "good" | "warn" | "bad"; headline: string; detail: string } => {
    if (!loaded) {
      /*
       * First paint holds no catalogue and no decisions, which is exactly what a
       * runtime that answered and offers nothing looks like. Announcing "memory
       * only" there is a claim this screen has not checked yet — the same
       * conflation `catalogueRead` exists to prevent, on a shorter clock.
       */
      return {
        tone: "warn",
        headline: "Reading what the runtime offers.",
        detail: "OrcaSynapse is asking the runtime which tools it offers. Nothing below is settled until it answers.",
      };
    }
    if (drifted.length > 0) {
      return {
        tone: "bad",
        headline: "Agent runs and chat are blocked.",
        detail: `The runtime has ${plural(drifted.length, "tool")} switched on that nobody allowed here (${drifted.join(", ")}). Allow them below, or have the runtime switch them off. Nothing runs until the two agree.`,
      };
    }
    if (!catalogueRead) {
      return {
        tone: "warn",
        headline: "OrcaSynapse could not reach the runtime.",
        detail: "The list below is this installation's own record of past decisions, not what the runtime is running now. Check the Hermes connection under Settings.",
      };
    }
    return {
      tone: allowed.length > 0 ? "warn" : "good",
      headline: allowed.length > 0
        ? `Agents can use built-in memory and ${plural(allowed.length, "other tool")}.`
        : "Agents can use built-in memory only.",
      detail: "The runtime runs these tools itself, so OrcaSynapse records that a tool ran but never sees the call.",
    };
  }, [loaded, drifted, catalogueRead, allowed]);

  const fail = (cause: unknown) => {
    if (cause instanceof OrcaSynapseApiError && cause.status === 401) onSessionExpired();
    setError(cause instanceof Error ? cause.message : "OrcaSynapse could not complete the tool operation.");
  };

  const load = async () => {
    const [admissionList, runtimeCatalogue, toolList] = await Promise.all([
      getToolsetAdmissions(),
      // The runtime may be unreachable; its catalogue is informative, not
      // load-bearing, so a failure must not blank the whole page.
      getRuntimeCatalogue().catch(() => null),
      getGovernedTools(),
    ]);
    setAdmissions(admissionList.items);
    setCatalogue(runtimeCatalogue);
    setCatalogueRead(runtimeCatalogue !== null);
    setMcpTools(toolList.items);
    setLoaded(true);
  };

  useEffect(() => {
    if (!unlocked) return;
    let active = true;
    void load().catch((cause) => active && fail(cause));
    const timer = window.setInterval(() => { if (active) void load().catch(() => undefined); }, 15_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [unlocked]);

  const action = async (key: string, operation: () => Promise<unknown>, message: string) => {
    if (busy) return;
    setBusy(key); setError(null); setNotice(null);
    try { await operation(); await load(); setNotice(message); }
    catch (cause) { fail(cause); }
    finally { setBusy(null); }
  };

  const decide = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing || reason.trim().length < 3) return;
    const { name, next } = editing;
    await action(name, async () => {
      await decideToolsetAdmission(name, next, reason.trim());
      setEditing(null);
      setReason("");
    }, next
      ? `${name} is allowed. The runtime still decides whether to switch it on.`
      : `${name} is blocked. Any run made while the runtime still has it on is refused.`);
  };

  const stage = async (event: FormEvent) => {
    event.preventDefault();
    const name = stagedName.trim();
    if (name.length < 1 || stagedReason.trim().length < 3) return;
    await action(`staged-${name}`, async () => {
      await decideToolsetAdmission(name, true, stagedReason.trim());
      setStagedName("");
      setStagedReason("");
    }, `${name} is allowed. It will appear above once the runtime reports it.`);
  };

  if (!unlocked) {
    return <LockedScreen
      kicker="Agents"
      title="Tools"
      mark="TL"
      headline="Scoped administrator required"
      reason="Unlock the console to see which tools your agents can use, and to allow or block one."
      actionLabel="Administrator setup"
      onAction={onConfigure}
    />;
  }

  return <div className="grid gap-5">
    <PageHeader
      kicker="Agents"
      title="Tools"
      description="What your agents are allowed to use. The runtime runs these tools itself, so OrcaSynapse permits or refuses a whole tool group rather than an individual call."
      actions={<Button onClick={() => void load()}>Refresh</Button>}
    />

    {error && <Alert onDismiss={() => setError(null)}>{error}</Alert>}
    {notice && <Alert tone="good" onDismiss={() => setNotice(null)}>{notice}</Alert>}

    <Panel
      aria-label="What agents can use"
      className={cn(
        "border-l-2",
        summary.tone === "bad" ? "border-l-bad" : summary.tone === "warn" ? "border-l-warn" : "border-l-good",
      )}
    >
      <MicroLabel className="block">Right now</MicroLabel>
      <strong className={cn(
        "mt-1.5 block text-label font-semibold",
        summary.tone === "bad" ? "text-bad" : summary.tone === "warn" ? "text-warn" : "text-text",
      )}>
        {summary.headline}
      </strong>
      <p className="mb-0 mt-1 max-w-[86ch] text-body leading-relaxed text-muted">{summary.detail}</p>
    </Panel>

    <Panel aria-label="Runtime tools" data-loaded={loaded ? "true" : "false"}>
      <PanelHeading
        title="Runtime tools"
        description="Each row is a group of related tools the runtime offers. The switch is this installation's decision; the runtime's own policy decides whether it is actually switched on."
        /* "0 of 0 allowed" beside a row that reads "Always allowed" is a
           fraction with nothing in it, so it is drawn only once there is
           something to count. */
        actions={others.length > 0
          ? <StatusText tone={allowed.length > 0 ? "good" : "neutral"}>
              {allowed.length} of {others.length} allowed
            </StatusText>
          : undefined}
      />

      <div className="grid gap-2">
        {rows.map((row) => {
          const drifting = row.enabled && !row.permitted;
          const open = editing?.name === row.name;
          return (
            <Tile
              as="article"
              key={row.name}
              aria-label={row.name}
              className={cn(
                "grid gap-3",
                drifting ? "border-bad/50 bg-bad/10" : null,
                open ? "border-accent/60" : null,
              )}
            >
              <div className="flex flex-wrap items-start justify-between gap-x-5 gap-y-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <strong className="font-mono text-label font-semibold text-text">{row.name}</strong>
                    {row.label ? <span className="text-caption text-muted">{row.label}</span> : null}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                    {row.reported
                      ? <small className="text-caption text-muted">{plural(row.toolCount, "tool")}</small>
                      : <small className="text-caption text-muted">
                          {row.baseline ? "not listed by the runtime" : "decision on record only"}
                        </small>}
                    {row.reported && (drifting
                      ? <StatusText dot tone="bad">on at the runtime but not allowed here</StatusText>
                      : row.enabled
                        ? <StatusText dot tone="good">on at the runtime</StatusText>
                        : <StatusText tone="neutral">off at the runtime</StatusText>)}
                  </div>
                  {row.baseline && (
                    <small className="mt-1.5 block max-w-[72ch] text-caption leading-relaxed text-muted">
                      Built-in memory is permitted on every run and cannot be turned off here. It writes only the
                      runtime's own MEMORY.md and USER.md; OrcaSynapse neither receives nor mirrors that content.
                    </small>
                  )}
                  {row.reason ? (
                    <small className="mt-1.5 block max-w-[72ch] text-caption leading-relaxed text-faint">
                      {row.reason}
                    </small>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2.5">
                  <span className="text-caption text-muted">
                    {row.baseline ? "Always allowed" : row.permitted ? "Allowed" : "Blocked"}
                  </span>
                  {/*
                    * The switch states the decision and opens the reason beneath
                    * the row rather than flipping straight away. It stays where
                    * it is until the decision is recorded, because until then it
                    * has not been made.
                    */}
                  <Switch
                    aria-label={`Allow ${row.name}`}
                    checked={row.permitted}
                    disabled={row.baseline || !canManage || busy !== null}
                    onCheckedChange={(next) => {
                      setEditing({ name: row.name, next });
                      setReason("");
                    }}
                  />
                </div>
              </div>

              {open && (
                <form
                  className="grid gap-2.5 border-t border-border pt-3 sm:flex sm:items-end"
                  onSubmit={(event) => void decide(event)}
                >
                  {/* A reason is a governance requirement the API enforces with
                      a 400. Asked for here, at the moment of the decision, it
                      reads as the decision — the single shared box this screen
                      used to carry disabled every button on the page until it
                      was filled in, which is what made it feel like paperwork. */}
                  <Field
                    className="min-w-0 flex-1"
                    label={editing.next ? `Why ${row.name} is allowed` : `Why ${row.name} is blocked`}
                  >
                    <Input
                      value={reason}
                      minLength={3}
                      maxLength={500}
                      placeholder="Reviewed with the data owner"
                      onChange={(event) => setReason(event.target.value)}
                    />
                  </Field>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      variant={editing.next ? "primary" : "danger"}
                      type="submit"
                      disabled={busy !== null || reason.trim().length < 3}
                    >
                      {busy === row.name ? "Saving…" : editing.next ? "Allow" : "Block"}
                    </Button>
                    <Button variant="ghost" onClick={() => { setEditing(null); setReason(""); }}>Cancel</Button>
                  </div>
                </form>
              )}
            </Tile>
          );
        })}
      </div>

      {/* `loaded` and not merely `others.length === 0`: the two states are
          identical in the markup and opposite in meaning. */}
      {loaded && others.length === 0 && (
        <EmptyState
          className="mt-2"
          title={catalogueRead
            ? "The runtime reports no tools beyond built-in memory"
            : "Nothing could be read from the runtime"}
        >
          {catalogueRead
            ? "There is nothing else to allow or block. A tool group appears here as soon as the runtime offers one."
            : "The runtime did not answer, so nothing can be listed. A decision recorded below is in place for when it does."}
        </EmptyState>
      )}

      {canManage && (
        <div className="mt-4 border-t border-border pt-4">
          <MicroLabel className="block">Not listed above</MicroLabel>
          <p className="mb-0 mt-1.5 max-w-[72ch] text-caption leading-relaxed text-muted">
            Allow a tool the runtime has not reported yet, named exactly as the runtime spells it. It takes
            effect the moment the runtime offers it.
          </p>
          {/*
            * `flex-wrap` is load-bearing, not tidiness: without it the two
            * fields and the button refuse to reflow and the row squeezes them
            * into a third of the panel instead of taking a second line.
            */}
          <form
            className="mt-3 flex flex-wrap items-end gap-2.5"
            onSubmit={(event) => void stage(event)}
          >
            <Field label="Tool name" className="min-w-[180px] flex-1">
              <Input
                value={stagedName}
                maxLength={120}
                placeholder="clarify"
                onChange={(event) => setStagedName(event.target.value)}
              />
            </Field>
            <Field label="Why it is allowed" className="min-w-[220px] flex-[2]">
              <Input
                value={stagedReason}
                minLength={3}
                maxLength={500}
                placeholder="Reviewed with the data owner"
                onChange={(event) => setStagedReason(event.target.value)}
              />
            </Field>
            {/* Outline, not `secondary`: the secondary fill measures
                rgb(28,28,36) against a rgb(22,22,28) panel, so the one control
                the empty-runtime state offers had no visible edge at all. */}
            <Button
              type="submit"
              className="shrink-0"
              disabled={busy !== null || stagedName.trim().length < 1 || stagedReason.trim().length < 3}
            >
              {busy === `staged-${stagedName.trim()}` ? "Saving…" : "Record decision"}
            </Button>
          </form>
        </div>
      )}
    </Panel>

    {/*
      * The one tripwire kept from the removed plane.
      *
      * `GovernedTool` is the first link in its chain — no tool, no grant, no
      * call, no approval — so a non-empty registry is the only way that plane
      * can come back to life. If it ever does, this says so instead of leaving
      * a subsystem running behind a screen that no longer mentions it.
      */}
    {mcpTools.length > 0 && (
      <Panel aria-label="OrcaSynapse-executed MCP tools" className="border-l-2 border-l-warn">
        <strong className="block text-label font-semibold text-warn">
          {mcpTools.length === 1
            ? "1 OrcaSynapse-executed MCP tool is registered."
            : `${mcpTools.length} OrcaSynapse-executed MCP tools are registered.`}
        </strong>
        <p className="mb-0 mt-1 max-w-[86ch] text-body leading-relaxed text-muted">
          This build cannot execute them: no local executor is registered for any handler, so every such call
          fails. They are separate from the runtime tools above and are not governed from this screen. Raise it
          with the platform team before relying on them.
        </p>
      </Panel>
    )}
  </div>;
}
