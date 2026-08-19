import type { ChatArtifact } from "@orcasynapse/contracts";
import { FolderDown } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { OrcaSynapseApiError, chatArtifactContentUrl, getChatArtifacts } from "./api.js";
import {
  Alert, Button, EmptyState, Input, Panel, StatusText, WorkspaceDock, WorkspaceIntro, cn,
} from "./ui/index.js";

interface FilesViewProps {
  onSessionExpired: () => void;
}

/*
 * Wider name column on purpose: the filename is how a person recognizes their
 * deliverable, and everything else on the row exists to confirm the guess.
 */
const ROW = "grid min-w-[860px] grid-cols-[minmax(0,1.6fr)_minmax(0,1.2fr)_100px_120px_112px] items-center gap-3";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatWhen(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    .format(new Date(value));
}

/**
 * Every file agent runs have produced, bounded by the reader's division on the
 * server -- this view renders exactly what the list route returns and adds no
 * filtering of its own, so nothing here is load-bearing for tenancy.
 */
export function FilesView({ onSessionExpired }: FilesViewProps) {
  // `null` is "not loaded", distinct from the empty array that means "no
  // files": collapsing the two would render a failed load as an empty library.
  const [artifacts, setArtifacts] = useState<ChatArtifact[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    getChatArtifacts()
      .then((list) => {
        if (cancelled) return;
        setArtifacts(list.items);
        // A success clears a stale failure: dev StrictMode runs this effect
        // twice, and a failure from the first pass must not outlive a second
        // pass that worked.
        setFailure(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof OrcaSynapseApiError && error.status === 401) return onSessionExpired();
        setFailure(error instanceof Error ? error.message : String(error));
      });
    return () => { cancelled = true; };
  }, [onSessionExpired]);

  const visible = useMemo(() => {
    if (!artifacts) return null;
    const needle = query.trim().toLowerCase();
    if (!needle) return artifacts;
    return artifacts.filter((artifact) =>
      [artifact.name, artifact.path, artifact.conversationTitle ?? "", artifact.profileName ?? ""]
        .some((value) => value.toLowerCase().includes(needle)));
  }, [artifacts, query]);

  return (
    <div className="workspace-stack">
      <WorkspaceIntro icon={<FolderDown size={18} />} title="Files">
        <p className="m-0 text-caption leading-relaxed text-muted">
          Documents your agents produced, kept with the conversation that made them. Files over 4 MB stay on their
          runtime node and are listed here without being retained centrally.
        </p>
      </WorkspaceIntro>

      {failure && <Alert tone="error" className="shrink-0">{failure}</Alert>}

      <WorkspaceDock>
        <Input
          value={query}
          placeholder="Search by name, path or conversation"
          aria-label="Search files"
          className="w-[min(48vw,360px)]"
          onChange={(event) => setQuery(event.target.value)}
        />
        {visible && (
          <span className="ml-auto font-mono text-micro tabular-nums text-faint">
            {visible.length} file{visible.length === 1 ? "" : "s"}
          </span>
        )}
      </WorkspaceDock>

      <Panel className="min-h-0 overflow-auto p-0">
        {visible === null && !failure && (
          <p className="m-0 p-4 text-caption text-muted">Loading files…</p>
        )}
        {visible !== null && visible.length === 0 && (
          <EmptyState title={query ? "Nothing matches" : "No files yet"}>
            {query
              ? "No file name, path or conversation matches that search."
              : "When an agent run saves a deliverable, it appears here."}
          </EmptyState>
        )}
        {visible !== null && visible.length > 0 && (
          <ul aria-label="Agent-produced files" className="m-0 list-none p-0">
            <li aria-hidden="true" className={cn(ROW, "border-b border-border px-4 py-2 text-micro font-semibold uppercase tracking-[0.08em] text-faint")}>
              <span>Name</span><span>Conversation</span><span>Size</span><span>Produced</span><span />
            </li>
            {visible.map((artifact) => (
              <li className={cn(ROW, "border-b border-border/60 px-4 py-2.5 last:border-b-0")} key={artifact.id}>
                <span className="min-w-0">
                  <span className="block truncate text-label font-medium text-text">{artifact.name}</span>
                  {artifact.path !== artifact.name && (
                    <span className="block truncate font-mono text-micro text-faint">{artifact.path}</span>
                  )}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-caption text-muted">{artifact.conversationTitle ?? "Run without a conversation"}</span>
                  {artifact.profileName && (
                    <span className="block truncate text-micro text-faint">{artifact.profileName}</span>
                  )}
                </span>
                <span className="font-mono text-caption tabular-nums text-muted">{formatSize(artifact.sizeBytes)}</span>
                <span className="font-mono text-caption tabular-nums text-muted">{formatWhen(artifact.createdAt)}</span>
                {artifact.storage === "INLINE" ? (
                  <Button asChild size="sm" className="justify-self-end">
                    {/* A navigation, not a fetch: the route forces attachment
                        + octet-stream, which is what keeps agent-authored HTML
                        or SVG from rendering on this origin. */}
                    <a href={chatArtifactContentUrl(artifact.id)} download={artifact.name}>Download</a>
                  </Button>
                ) : (
                  <StatusText tone="warn" title="Larger than the 4 MB retention limit; the file remains on its runtime node.">
                    On node
                  </StatusText>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
