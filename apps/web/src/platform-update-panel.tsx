import type { PlatformUpdate } from "@orcasynapse/contracts";
import { useState } from "react";
import { approveReleaseTarget, clearReleaseTarget, getPlatformUpdate } from "./api.js";
import { PlatformUpdateActivityPanel } from "./platform-update-activity.js";
import { Button, MicroLabel, Panel, StatusText } from "./ui/index.js";
import { CopyIcon } from "./ui/relay-icons.js";

type UpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "ready"; update: PlatformUpdate }
  | { status: "error"; message: string };

function approvedAt(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function failureMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

interface PlatformUpdatePanelProps {
  currentVersion: string;
  /**
   * Whether this session holds `readiness:approve`. Every administrator role
   * may read the check; recording a target is the deliberate act, so a session
   * without the scope is shown the target rather than a button that would come
   * back 403.
   */
  canApprove: boolean;
}

export function PlatformUpdatePanel({ currentVersion, canApprove }: PlatformUpdatePanelProps) {
  const [state, setState] = useState<UpdateState>({ status: "idle" });
  const [copied, setCopied] = useState(false);
  /*
   * Which decision is in flight, kept apart from the check's own state so a
   * refused approval does not throw away the release the operator just looked
   * at — they need it on screen to decide what to do about the refusal. Which
   * one, rather than merely whether: both buttons can be on screen at once when
   * a release newer than the approved target appears, and a single flag made a
   * withdrawal relabel the approve button.
   */
  const [pending, setPending] = useState<"approve" | "withdraw" | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const busy = pending !== null;
  /*
   * Bumped after a decision so the activity panel re-reads immediately. The
   * agent will not have acted yet — its timer is ten minutes — but an operator
   * who has just approved a release is owed the agent's own liveness on the
   * spot, since that is what decides whether anything will happen at all.
   */
  const [activityToken, setActivityToken] = useState(0);

  const check = async () => {
    setCopied(false);
    setDecisionError(null);
    setState({ status: "checking" });
    try {
      setState({ status: "ready", update: await getPlatformUpdate() });
    } catch (error) {
      setState({
        status: "error",
        message: failureMessage(error, "The update check failed."),
      });
    }
  };

  /** Re-reads rather than patching state: the revision has moved. */
  const decide = async (kind: "approve" | "withdraw", decision: () => Promise<unknown>, fallback: string) => {
    setPending(kind);
    setDecisionError(null);
    try {
      await decision();
      setState({ status: "ready", update: await getPlatformUpdate() });
      setActivityToken((token) => token + 1);
    } catch (error) {
      setDecisionError(failureMessage(error, fallback));
    } finally {
      setPending(null);
    }
  };

  const copyCommand = async (command: string) => {
    await navigator.clipboard.writeText(command);
    setCopied(true);
  };

  const available = state.status === "ready" && state.update.updateAvailable;
  const target = state.status === "ready" ? state.update.target : null;
  // Nothing to approve once the checked release is already the recorded target.
  const approvable = canApprove
    && state.status === "ready"
    && state.update.updateAvailable
    && target?.desiredVersion !== state.update.latestVersion
    ? state.update
    : null;
  const statusLabel = state.status === "checking"
    ? "Checking"
    : state.status === "error"
      ? "Unavailable"
      : available
        ? "Update available"
        : state.status === "ready"
          ? "Up to date"
          : "Not checked";
  const statusTone = state.status === "error" ? "bad" : available ? "warn" : state.status === "ready" ? "good" : "neutral";

  return (
    <Panel className="overflow-hidden p-0" aria-label="System update">
      <div className="flex flex-wrap items-start justify-between gap-4 p-5">
        <div className="flex min-w-0 items-start gap-3">
          {/*
            * The Orca mark in white on the brand fill, rather than the accent
            * sync glyph this used to carry.
            *
            * `sivali-mark.svg` is a traced, fixed-colour violet, so white comes
            * from `brightness-0 invert` — the mark is flattened to black and
            * then inverted, which is why it survives the eight distinct fills
            * in the source without a second asset to keep in step. Tailwind
            * utilities rather than a `style` attribute, because the container
            * serves `style-src 'self'`.
            *
            * The tile is filled rather than `bg-raised`: white on a raised
            * surface is legible in dark theme and invisible in light, and this
            * panel renders in both.
            */}
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded border border-accent-fill bg-accent-fill">
            <img src="/brand/sivali-mark.svg" alt="" width={22} height={22} className="block shrink-0 brightness-0 invert" />
          </span>
          <div className="min-w-0">
            <MicroLabel className="block">System update</MicroLabel>
            <h2 className="m-0 mt-1 font-display text-[15px] font-semibold tracking-[-0.01em] text-text">OrcaSynapse {currentVersion}</h2>
            <p className="mb-0 mt-1 text-body leading-relaxed text-muted">
              Check the official release tags without granting this container control of the VM1 host.
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <StatusText dot tone={statusTone}>{statusLabel}</StatusText>
          {approvable && (
            <Button variant="primary" onClick={() => void decide(
              "approve",
              () => approveReleaseTarget({
                desiredVersion: approvable.latestVersion,
                expectedRevision: approvable.target?.revision ?? 0,
              }),
              "The release could not be approved.",
            )} disabled={busy}>
              {pending === "approve" ? "Approving…" : `Approve ${approvable.latestVersion}`}
            </Button>
          )}
          <Button onClick={() => void check()} disabled={state.status === "checking" || busy}>
            {state.status === "checking" ? "Checking…" : "Check for updates"}
          </Button>
        </div>
      </div>

      {state.status === "error" && (
        <div className="border-t border-border bg-bad/5 px-5 py-3 text-body text-bad" role="status">
          {state.message}
        </div>
      )}

      {decisionError && (
        <div className="border-t border-border bg-bad/5 px-5 py-3 text-body text-bad" role="status">
          {decisionError}
        </div>
      )}

      {state.status === "ready" && (
        <div className="border-t border-border bg-raised/50 px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <strong className="block text-label font-semibold text-text">
                {state.update.updateAvailable
                  ? `${state.update.latestVersion} is ready to install`
                  : `${state.update.currentVersion} is the latest release`}
              </strong>
              <span className="mt-1 block text-caption text-muted">
                {state.update.automaticUpdateSupported
                  ? "Approve it and the agent on VM1 applies it, gates it on readiness, and restores this release if the new one does not serve."
                  : "Run the pinned command on VM1. Existing installer upgrade safeguards remain in force."}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <a
                className="inline-flex h-9 items-center justify-center whitespace-nowrap rounded border border-border-strong px-3 text-body font-semibold text-text transition-colors hover:border-faint"
                href={state.update.releaseUrl}
                target="_blank"
                rel="noreferrer"
              >
                View release
              </a>
              {/*
                * `primary` only when the command is the way this deployment
                * actually updates. It was the loudest control on the screen next
                * to the approve button that had already made it unnecessary,
                * which sent operators looking for a shell they no longer need.
                */}
              <Button
                variant={state.update.updateAvailable && !state.update.automaticUpdateSupported ? "primary" : "ghost"}
                onClick={() => void copyCommand(state.update.updateCommand)}
              >
                <CopyIcon size={16} />
                {copied ? "Copied" : "Copy update command"}
              </Button>
            </div>
          </div>
          <code className="mt-3 block overflow-x-auto rounded border border-border bg-bg px-3 py-2.5 font-mono text-caption text-muted">
            {state.update.updateCommand}
          </code>
          <p className="mb-0 mt-2 text-caption text-faint">{state.update.automaticUpdateReason}</p>
        </div>
      )}

      {target && (
        <div className="border-t border-border px-5 py-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <strong className="block text-label font-semibold text-text">
                {target.desiredVersion} is approved as this deployment's target
              </strong>
              {/*
                * This said "Recorded, not applied — the upgrade still runs on
                * VM1 with the command above" and then, one sentence later, that
                * the hosts read the record themselves. Both halves were written
                * at different times and they contradict each other; the second
                * is the true one since the host update agent shipped. What is
                * still true either way is the boundary: the host pulls, and
                * nothing is pushed to it from a browser.
                */}
              <span className="mt-1 block text-caption text-muted">
                Approved by {target.approvedBySubject} on {approvedAt(target.approvedAt)}. The hosts read this record
                themselves and pick up the pinned commit; nothing is ever pushed to them from the browser.
              </span>
            </div>
            {canApprove && (
              <Button
                variant="ghost"
                onClick={() => void decide("withdraw", clearReleaseTarget, "The approval could not be withdrawn.")}
                disabled={busy}
              >
                {pending === "withdraw" ? "Withdrawing…" : "Withdraw approval"}
              </Button>
            )}
          </div>
          {/*
            * The commit, not just the tag. A tag can be re-pointed after
            * approval, so this is the value that says what will actually be
            * installed — and the one an operator compares against a host.
            */}
          <code className="mt-3 block overflow-x-auto rounded border border-border bg-bg px-3 py-2.5 font-mono text-caption text-muted">
            {target.desiredCommit}
          </code>
        </div>
      )}

      <PlatformUpdateActivityPanel refreshToken={activityToken} />
    </Panel>
  );
}
