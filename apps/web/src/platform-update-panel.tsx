import type { PlatformUpdate } from "@orcasynapse/contracts";
import { useState } from "react";
import { getPlatformUpdate } from "./api.js";
import { Button, MicroLabel, Panel, StatusText } from "./ui/index.js";
import { CopyIcon, SyncIcon } from "./ui/relay-icons.js";

type UpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "ready"; update: PlatformUpdate }
  | { status: "error"; message: string };

export function PlatformUpdatePanel({ currentVersion }: { currentVersion: string }) {
  const [state, setState] = useState<UpdateState>({ status: "idle" });
  const [copied, setCopied] = useState(false);

  const check = async () => {
    setCopied(false);
    setState({ status: "checking" });
    try {
      setState({ status: "ready", update: await getPlatformUpdate() });
    } catch (error) {
      setState({
        status: "error",
        message: error instanceof Error ? error.message : "The update check failed.",
      });
    }
  };

  const copyCommand = async (command: string) => {
    await navigator.clipboard.writeText(command);
    setCopied(true);
  };

  const available = state.status === "ready" && state.update.updateAvailable;
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
    <Panel className="overflow-hidden p-0" aria-label="Application update">
      <div className="flex flex-wrap items-start justify-between gap-4 p-5">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded border border-border-strong bg-raised text-accent">
            <SyncIcon size={21} />
          </span>
          <div className="min-w-0">
            <MicroLabel className="block">Application update</MicroLabel>
            <h2 className="m-0 mt-1 font-display text-[15px] font-semibold tracking-[-0.01em] text-text">OrcaSynapse {currentVersion}</h2>
            <p className="mb-0 mt-1 text-body leading-relaxed text-muted">
              Check the official release tags without granting this container control of the VM1 host.
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <StatusText dot tone={statusTone}>{statusLabel}</StatusText>
          <Button onClick={() => void check()} disabled={state.status === "checking"}>
            {state.status === "checking" ? "Checking…" : "Check for updates"}
          </Button>
        </div>
      </div>

      {state.status === "error" && (
        <div className="border-t border-border bg-bad/5 px-5 py-3 text-body text-bad" role="status">
          {state.message}
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
                Run the pinned command on VM1. Existing installer upgrade safeguards remain in force.
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
              <Button variant={state.update.updateAvailable ? "primary" : "ghost"} onClick={() => void copyCommand(state.update.updateCommand)}>
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
    </Panel>
  );
}
