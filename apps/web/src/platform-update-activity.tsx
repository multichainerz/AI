import type { PlatformUpdateActivity, PlatformUpdatePhase, PlatformUpdateRun } from "@orcasynapse/contracts";
import { useEffect, useRef, useState } from "react";
import { getPlatformUpdateActivity } from "./api.js";
import { cn } from "./ui/cn.js";
import { Button, MicroLabel, StatusText } from "./ui/index.js";

/**
 * What the VM1 update agent is doing, and what it did last.
 *
 * This exists because an approval used to be the end of what the dashboard
 * could tell you: the agent applied it on the host and everything it recorded —
 * the phase, the installer's own log, whether it had to roll back — lived in
 * two root-owned files the container cannot read. An operator's only way to
 * find out whether their upgrade worked was a shell on VM1, which is the thing
 * in-dashboard updates exist to remove.
 *
 * There is one window this cannot cover and does not pretend to: while the
 * stack is being replaced, the API and the dashboard are down, so nothing here
 * can be fetched. The panel says so rather than spinning, and `apiUnavailableUntil`
 * is what lets it distinguish that from a machine that has actually stalled.
 */

/** Phases a run can still move on from. Anything else is where it stopped. */
const RUNNING: ReadonlySet<PlatformUpdatePhase> = new Set(["upgrading", "verifying", "recovering"]);

const PHASE_TONE: Record<PlatformUpdatePhase, "good" | "warn" | "bad" | "neutral"> = {
  healthy: "good",
  idle: "neutral",
  unknown: "neutral",
  upgrading: "warn",
  verifying: "warn",
  recovering: "warn",
  blocked: "warn",
  "rolled-back": "warn",
  failed: "bad",
};

/*
 * Deliberately not the phase name. "rolled-back" is the agent's vocabulary and
 * it understates what happened for a reader scanning one line: the upgrade did
 * not happen and the machine is on its previous release. The tone above already
 * carries the severity, so these say the outcome.
 */
const PHASE_LABEL: Record<PlatformUpdatePhase, string> = {
  idle: "Idle",
  blocked: "Needs re-approval",
  upgrading: "Upgrading",
  verifying: "Verifying",
  recovering: "Recovering",
  healthy: "Update applied",
  "rolled-back": "Rolled back",
  failed: "Failed",
  unknown: "Unrecognised",
};

function moment(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

/** Whole minutes. An agent that checks in every ten does not need seconds. */
export function sinceLabel(value: string, now: number = Date.now()): string {
  const minutes = Math.floor((now - new Date(value).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes === 1) return "1 minute ago";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return "1 hour ago";
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/**
 * The version pair for a run, as far as it is known.
 *
 * `installedVersion` is re-read from disk after the installer returns, so on a
 * rolled-back run it is the release the machine came back on — which is what
 * makes "from X, did not reach Y" readable rather than misleading.
 */
export function transitionLabel(run: PlatformUpdateRun): string {
  const to = run.targetVersion ?? run.targetCommit?.slice(0, 12) ?? "an approved release";
  const from = run.installedVersion ?? run.installedCommit?.slice(0, 12);
  if (run.phase === "healthy") return from === to ? `Now running ${to}` : `${from ?? "This deployment"} → ${to}`;
  if (run.phase === "rolled-back") return `${to} was not applied; running ${from ?? "the previous release"}`;
  return `${from ?? "This deployment"} → ${to}`;
}

interface UpdateActivityProps {
  /** Bumped by the panel after an approval, so this re-reads without a poll. */
  refreshToken: number;
}

export function PlatformUpdateActivityPanel({ refreshToken }: UpdateActivityProps) {
  const [activity, setActivity] = useState<PlatformUpdateActivity | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const logRef = useRef<HTMLPreElement | null>(null);

  const running = activity?.latest ? RUNNING.has(activity.latest.phase) : false;

  useEffect(() => {
    let active = true;
    const read = async () => {
      try {
        const next = await getPlatformUpdateActivity();
        if (!active) return;
        setActivity(next);
        setUnreachable(false);
      } catch {
        // Not surfaced as an error. During an upgrade this request is *expected*
        // to fail, because the API it asks is the one being replaced; the panel
        // says which of those two it is from the record it already holds.
        if (active) setUnreachable(true);
      }
    };
    void read();
    /*
     * Only while something is in flight. A ten-second poll that never stops
     * would keep a browser tab talking to the control plane forever to report
     * "idle", and the agent's own timer is ten minutes -- there is nothing to
     * see between ticks.
     */
    if (!running) return () => { active = false; };
    const timer = window.setInterval(() => void read(), 10_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [refreshToken, running]);

  // The end is where a failure explains itself, and it is what the agent keeps
  // when it has to truncate.
  useEffect(() => {
    if (showLog && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [showLog, activity?.latest?.id]);

  if (!activity) return null;

  const { agent, latest } = activity;

  if (!agent) {
    return (
      <div className="border-t border-border px-5 py-4">
        <MicroLabel className="block">Update agent</MicroLabel>
        <strong className="mt-1 block text-label font-semibold text-text">No update agent has reported on this host</strong>
        <p className="mb-0 mt-1 text-caption leading-relaxed text-muted">
          Approving a release records it, but nothing on VM1 is reading that record, so it will not be applied. The agent
          is installed by install.sh from v5.6.0 — a deployment installed before that runs the command above once, and
          updates from here afterwards.
        </p>
      </div>
    );
  }

  const staleWhileRunning = unreachable && latest?.apiUnavailableUntil
    && Date.now() < new Date(latest.apiUnavailableUntil).getTime();

  return (
    <div className="border-t border-border px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <MicroLabel className="block">Update agent</MicroLabel>
          <strong className="mt-1 block text-label font-semibold text-text">
            {latest ? transitionLabel(latest) : "No upgrade has been attempted on this host"}
          </strong>
          <p className="mb-0 mt-1 text-caption leading-relaxed text-muted">
            {latest?.detail ?? agent.detail}
          </p>
          <p className="mb-0 mt-1 text-caption text-faint">
            {latest?.completedAt
              ? `Finished ${moment(latest.completedAt)}`
              : latest
                ? `Started ${moment(latest.startedAt)}`
                : `Agent checked in ${sinceLabel(agent.checkedAt)}`}
          </p>
        </div>
        <StatusText dot tone={PHASE_TONE[latest?.phase ?? agent.phase]}>
          {PHASE_LABEL[latest?.phase ?? agent.phase]}
        </StatusText>
      </div>

      {staleWhileRunning && (
        <p className="mb-0 mt-3 rounded border border-border bg-raised/60 px-3 py-2 text-caption leading-relaxed text-muted">
          The control plane is being replaced, so this page cannot reach it. That is expected until{" "}
          {moment(latest.apiUnavailableUntil!)} — reload after then. If it is still unreachable past that time, the
          upgrade has stalled rather than restarted.
        </p>
      )}

      {latest?.rollback && (
        <p className="mb-0 mt-3 text-caption leading-relaxed text-warn">Recovery: {latest.rollback}</p>
      )}

      {latest && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => setShowLog((open) => !open)} disabled={!latest.log}>
            {latest.log ? (showLog ? "Hide installer log" : "Show installer log") : "No installer log recorded"}
          </Button>
          {latest.targetCommit && (
            <code className="rounded border border-border bg-bg px-2 py-1 font-mono text-micro text-faint">
              {latest.targetCommit.slice(0, 12)}
            </code>
          )}
        </div>
      )}

      {showLog && latest?.log && (
        <>
          {latest.logTruncated && (
            <p className="mb-0 mt-3 text-caption text-faint">
              Truncated to the last 128 KB. The end is kept, because that is where a failure says why.
            </p>
          )}
          {/*
           * The installer's own log file, never its terminal output. install.sh
           * prints the Offline recovery key with a bare printf that deliberately
           * never reaches that file, so this is the channel that carries no
           * secrets — see the column's comment in the schema.
           */}
          {/*
            * `caption`, not `micro`. Micro is 10px *and* carries 0.08em of
            * tracking, which exists to space out uppercase labels and is wrong
            * on monospace — it pulls apart the one thing a reader is scanning
            * for structure. This is a diagnostic read under pressure, so it
            * takes the smallest size in the scale that is set normally.
            */}
          <pre
            ref={logRef}
            className={cn(
              "mt-2 max-h-[320px] overflow-auto rounded border border-border bg-bg px-3 py-2.5",
              "font-mono text-caption leading-relaxed text-muted",
            )}
          >{latest.log}</pre>
        </>
      )}
    </div>
  );
}
