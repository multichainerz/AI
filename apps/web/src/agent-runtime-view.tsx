import type { AgentMetrics, AgentRun, AgentRunEvent, AgentRuntimeControl } from "@orcasynapse/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { failedStatuses, runningStatuses, statusTone } from "./agent-status.js";
import { groupRuntimeEvents } from "./chat/timeline.js";
import {
  OrcaSynapseApiError,
  cancelAgentRun,
  getAgentMetrics,
  getAgentRunEvents,
  getAgentRuns,
  getAgentRuntime,
  updateAgentRuntime,
} from "./api.js";
import {
  Alert, Button, EmptyState, Field, HeroBanner, Input, LockedScreen, MicroLabel,
  PageHeader, Panel, PanelHeading, StatusText, Tile, cn, toneFor,
} from "./ui/index.js";

interface AgentRuntimeViewProps {
  unlocked: boolean;
  administrator: boolean;
  oidcConfigured: boolean;
  onSignIn: () => void;
  onConfigure: () => void;
  onOpenProfiles: () => void;
  onSessionExpired: () => void;
}

function friendlyTime(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function eventTitle(event: AgentRunEvent): string {
  return event.type.replaceAll("_", " ").toLowerCase().replace(/^./, (first) => first.toUpperCase());
}

function eventDetail(event: AgentRunEvent): string {
  if (event.summary) return event.summary;
  if (event.toolName) return `Governed tool: ${event.toolName}`;
  if (event.childSessionId) return `Temporary child session ${event.childSessionId}`;
  if (event.status) return `Hermes status: ${event.status}`;
  return "Hermes emitted a bounded lifecycle event.";
}

/**
 * The execution half of what used to be one "Profiles & runs" screen.
 *
 * Everything here answers "what is Hermes doing, and can I stop it": the global
 * boundary, the live counters, the retained ledger, and the bounded activity
 * timeline for one run. Nothing here configures an agent -- that is Profiles,
 * one tab to the left, and the two are joined only by `onOpenProfiles`, which
 * exists because a disabled boundary is almost always a Profiles problem seen
 * from here.
 */
export function AgentRuntimeView({
  unlocked, administrator, oidcConfigured, onSignIn, onConfigure, onOpenProfiles, onSessionExpired,
}: AgentRuntimeViewProps) {
  const runsRef = useRef<AgentRun[]>([]);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [runEvents, setRunEvents] = useState<AgentRunEvent[]>([]);
  const [metrics, setMetrics] = useState<AgentMetrics | null>(null);
  const [runtime, setRuntime] = useState<AgentRuntimeControl | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [reason, setReason] = useState("Runtime and Profile Distribution boundaries verified by the platform administrator.");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedRun = useMemo(() => runs.find(({ id }) => id === selectedRunId) ?? runs[0] ?? null, [runs, selectedRunId]);

  const fail = (cause: unknown) => {
    if (cause instanceof OrcaSynapseApiError && cause.status === 401) onSessionExpired();
    setError(cause instanceof Error ? cause.message : "OrcaSynapse could not read the Hermes execution ledger.");
  };

  const load = async () => {
    const runList = await getAgentRuns(administrator);
    runsRef.current = runList.items;
    setRuns(runList.items);
    if (administrator) {
      const [nextRuntime, nextMetrics] = await Promise.all([getAgentRuntime(), getAgentMetrics()]);
      setRuntime(nextRuntime);
      setMetrics(nextMetrics);
    }
  };

  useEffect(() => {
    if (!unlocked) {
      setRuns([]); setRuntime(null); setMetrics(null);
      return;
    }
    let active = true;
    void load().catch((cause) => active && fail(cause));
    const timer = window.setInterval(() => {
      if (active && runsRef.current.some(({ status }) => runningStatuses.has(status))) void load().catch(() => undefined);
    }, 2_500);
    return () => { active = false; window.clearInterval(timer); };
  }, [unlocked, administrator]);

  useEffect(() => {
    if (!unlocked || !selectedRun) {
      setRunEvents([]);
      return;
    }
    let active = true;
    void getAgentRunEvents(selectedRun.id, administrator)
      .then((result) => { if (active) setRunEvents(result.items); })
      .catch((cause) => { if (active) fail(cause); });
    return () => { active = false; };
  }, [unlocked, administrator, selectedRun?.id, selectedRun?.updatedAt]);

  const action = async (key: string, operation: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(key); setError(null);
    try { await operation(); await load(); }
    catch (cause) { fail(cause); }
    finally { setBusy(null); }
  };

  if (!unlocked) {
    return (
      <LockedScreen
        kicker="Governed execution"
        title="Agent Runtime"
        mark="HR"
        headline="Authenticated workspace required"
        reason="Sign in to watch governed Hermes runs. Administrators can also control the global execution boundary and cancel work already in flight."
        actionLabel={oidcConfigured ? "Enterprise sign in" : "Administrator setup"}
        onAction={oidcConfigured ? onSignIn : onConfigure}
        {...(oidcConfigured ? { secondaryLabel: "Administrator setup", onSecondary: onConfigure } : {})}
      />
    );
  }

  return (
    <div className="grid gap-5">
      <PageHeader
        kicker="Hardened orchestration"
        title="Hermes Runtime"
        description="The global execution boundary, live run counters, and the retained execution ledger with its safe activity events."
        actions={<Button onClick={() => void load()}>Refresh</Button>}
      />

      {error && <Alert onDismiss={() => setError(null)}>{error}</Alert>}

      {administrator && <Panel className={cn(
        "grid grid-cols-[auto_minmax(0,1fr)] items-start gap-4 border-l-2",
        runtime?.enabled ? "border-l-good" : "border-l-border-strong",
      )}>
        {/* The kill switch. ON/OFF is stated as a word rather than a colour
            alone, because this is the control an operator reaches for when
            something is already going wrong. */}
        <div className={cn(
          "grid h-11 w-11 place-items-center rounded border font-mono text-caption font-bold",
          runtime?.enabled ? "border-good/50 bg-good/10 text-good" : "border-border-strong bg-raised text-muted",
        )}>
          {runtime?.enabled ? "ON" : "OFF"}
        </div>
        <div className="min-w-0">
          <MicroLabel className="block">Hermes execution</MicroLabel>
          <strong className="mt-1.5 block text-label font-semibold text-text">
            {runtime?.enabled ? "Ready for Chat" : "Activates with the first verified Profile"}
          </strong>
          <p className="mb-0 mt-1 text-body text-muted">
            {runtime?.enabled ? runtime.reason : "Create or verify a Profile; OrcaSynapse will test Hermes and enable this boundary automatically."}
          </p>
          {/* The sentence above names the fix, and the fix is one tab away.
              Saying so without offering the move is how a split strands
              someone. */}
          {!runtime?.enabled && (
            <Button size="sm" className="mt-3" onClick={onOpenProfiles}>Open Profiles</Button>
          )}
          <details className="mt-3">
            <summary className="cursor-pointer text-micro font-semibold uppercase tabular-nums text-faint">Manual control</summary>
            <form
              className="mt-2.5 flex flex-wrap items-end gap-2.5"
              onSubmit={(event) => { event.preventDefault(); if (reason.trim().length >= 3) void action("runtime", () => updateAgentRuntime(!runtime?.enabled, reason.trim())); }}
            >
              <Field label="Audit reason" htmlFor="runtime-reason" className="min-w-[220px] flex-1">
                <Input id="runtime-reason" value={reason} minLength={3} maxLength={500} onChange={(event) => setReason(event.target.value)} />
              </Field>
              <Button
                variant={runtime?.enabled ? "danger" : "secondary"}
                disabled={busy !== null || reason.trim().length < 3}
                type="submit"
              >
                {busy === "runtime" ? "Applying..." : runtime?.enabled ? "Disable execution" : "Enable manually"}
              </Button>
            </form>
          </details>
        </div>
      </Panel>}

      {/*
        * Four run figures and no profile count. The profile total moved to
        * Profiles with the list it describes: a number an operator cannot act
        * on from the screen it appears on is decoration.
        */}
      <HeroBanner
        aria-label="Hermes run summary"
        highlight={{
          label: "Completed runs",
          value: metrics?.completedRuns ?? runs.filter(({ status }) => status === "COMPLETED").length,
          caption: "Retained outcomes with their complete lifecycle",
        }}
        metrics={[
          {
            label: "Queued",
            value: metrics?.queuedRuns ?? runs.filter(({ status }) => status === "QUEUED").length,
            caption: "awaiting worker",
          },
          {
            label: "Running",
            tone: "accent",
            value: metrics?.runningRuns ?? runs.filter(({ status }) => runningStatuses.has(status)).length,
            caption: "live or stopping",
          },
          {
            label: "Failed",
            value: metrics?.failedRuns ?? runs.filter(({ status }) => failedStatuses.has(status)).length,
            caption: "failed, timed out or denied",
          },
        ]}
      />

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
        <Panel>
          <PanelHeading kicker="Execution ledger" title="Recent runs" actions={<StatusText>{runs.length} records</StatusText>} />
          <div className="grid max-h-[520px] gap-1 overflow-y-auto">
            {runs.length === 0 && (
              <EmptyState title="No runs yet">Queued work will appear here with its complete lifecycle.</EmptyState>
            )}
            {runs.map((run) => <Button
              variant="ghost"
              className={cn(
                "grid w-full gap-1 rounded border p-2.5 text-left transition-colors",
                selectedRun?.id === run.id ? "border-border-strong bg-raised" : "border-transparent hover:bg-raised",
              )}
              key={run.id}
              onClick={() => setSelectedRunId(run.id)}
            >
              <StatusText dot tone={toneFor(statusTone(run.status))}>{run.status.replaceAll("_", " ").toLowerCase()}</StatusText>
              <strong className="truncate text-label font-semibold text-text">{run.profileName}</strong>
              <p className="mb-0 line-clamp-2 text-caption text-muted">{run.input}</p>
              <small className="font-mono text-micro text-faint">v{run.profileVersion} · {friendlyTime(run.createdAt)}</small>
            </Button>)}
          </div>
        </Panel>

        <Panel>
          {!selectedRun
            ? <EmptyState title="Select a run">Input, output, events, and failure information remain in the OrcaSynapse execution ledger.</EmptyState>
            : <>
            <PanelHeading
              kicker="Run detail"
              title={selectedRun.profileName}
              description={`${selectedRun.profileSlug} · version ${selectedRun.profileVersion}`}
              actions={<StatusText dot tone={toneFor(statusTone(selectedRun.status))}>{selectedRun.status.replaceAll("_", " ").toLowerCase()}</StatusText>}
            />
            <dl className="m-0 grid grid-cols-3 gap-px rounded border border-border bg-border">
              {[
                { label: "Queued", value: friendlyTime(selectedRun.queuedAt) },
                { label: "Started", value: friendlyTime(selectedRun.startedAt) },
                { label: "Completed", value: friendlyTime(selectedRun.completedAt) },
              ].map((fact) => (
                <div className="min-w-0 bg-surface px-2.5 py-2" key={fact.label}>
                  <dt className="truncate text-micro font-semibold uppercase tabular-nums text-faint">{fact.label}</dt>
                  <dd className="m-0 mt-1 truncate font-mono text-caption text-muted">{fact.value}</dd>
                </div>
              ))}
            </dl>
            <Tile className="mt-3">
              <MicroLabel className="block">Profile Distribution</MicroLabel>
              <code className="mt-1.5 block break-all font-mono text-micro text-muted">
                {selectedRun.profileDistributionDigest ?? "Legacy run — no distribution digest"}
              </code>
            </Tile>
            <section className="mt-3 overflow-hidden rounded border border-border" aria-label="Safe Hermes activity timeline">
              <header className="flex items-center justify-between border-b border-border bg-raised px-3 py-2">
                <MicroLabel>Activity timeline</MicroLabel>
                <StatusText>{runEvents.length} safe event{runEvents.length === 1 ? "" : "s"}</StatusText>
              </header>
              {runEvents.length === 0
                ? <p className="m-0 px-3 py-4 text-body text-faint">No bounded Hermes activity events have been retained for this run.</p>
                /*
                  * Grouped by tool call, sharing the function chat uses. Two
                  * screens read one table, so they had better agree on what a
                  * tool call is -- this one listed every event separately until
                  * `toolCallKey` reached the agents contract.
                  */
                : <ol className="m-0 grid list-none p-0">{groupRuntimeEvents(runEvents).map((entry) => {
                  const event = entry.events[entry.events.length - 1]!;
                  return <li
                    className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2.5 border-t border-border px-3 py-2.5 first:border-t-0"
                    key={entry.key}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "mt-1 h-1.5 w-1.5 shrink-0",
                        entry.status === "failed" ? "bg-bad" : entry.status === "completed" ? "bg-good" : "bg-accent",
                      )}
                    />
                    <div className="min-w-0">
                      <strong className="block text-caption font-semibold text-text">
                        {entry.kind === "tool" ? `Governed tool: ${entry.label}` : eventTitle(event)}
                        {entry.events.length > 1 ? ` · ${entry.events.length} steps` : ""}
                      </strong>
                      <p className="mb-0 mt-0.5 text-caption leading-relaxed text-muted">{eventDetail(event)}</p>
                      <small className="mt-1 block font-mono text-micro text-faint">
                        {friendlyTime(event.occurredAt)}
                        {entry.durationMs !== null ? ` · ${Math.round(entry.durationMs / 100) / 10}s` : ""}
                        {event.inputTokens !== null || event.outputTokens !== null ? ` · ${(event.inputTokens ?? 0) + (event.outputTokens ?? 0)} tokens` : ""}
                      </small>
                    </div>
                  </li>;
                })}</ol>}
              {/* The list is bounded on purpose, and says so: an operator
                  reading it should not assume the omissions are absences. */}
              <footer className="border-t border-border bg-bg px-3 py-2 text-micro leading-relaxed text-faint">
                Token deltas, chain-of-thought, hidden prompts, credentials, tool arguments, and tool results are never
                retained here.
              </footer>
            </section>
            {[
              { label: "Input", body: selectedRun.input, tone: "" },
              ...(selectedRun.output ? [{ label: "Hermes output", body: selectedRun.output, tone: "border-l-2 border-l-accent" }] : []),
            ].map((block) => (
              <Tile className={cn("mt-3", block.tone)} key={block.label}>
                <MicroLabel className="block">{block.label}</MicroLabel>
                <p className="mb-0 mt-1.5 whitespace-pre-wrap break-words text-body leading-relaxed text-text">{block.body}</p>
              </Tile>
            ))}
            {selectedRun.failureMessage && <div className="mt-3 rounded border border-bad/40 bg-bad/10 p-3">
              <strong className="block text-micro font-semibold uppercase tabular-nums text-bad">{selectedRun.failureCode}</strong>
              <p className="mb-0 mt-1.5 text-body leading-relaxed text-muted">{selectedRun.failureMessage}</p>
            </div>}
            {runningStatuses.has(selectedRun.status) && <Button
              variant="danger"
              className="mt-3"
              disabled={busy !== null || selectedRun.status === "CANCEL_REQUESTED"}
              onClick={() => void action(`cancel-${selectedRun.id}`, () => cancelAgentRun(selectedRun.id, administrator))}
            >
              {selectedRun.status === "CANCEL_REQUESTED" ? "Cancellation requested" : "Cancel run"}
            </Button>}
          </>}
        </Panel>
      </div>
    </div>
  );
}
