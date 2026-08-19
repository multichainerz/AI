import type { ChatArtifact, ChatArtifactOrigin } from "@orcasynapse/contracts";
import {
  File as FileIcon,
  FileArchive,
  FileCode2,
  FileJson2,
  FileSpreadsheet,
  FileText,
  FolderDown,
  Image as ImageIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { OrcaSynapseApiError, chatArtifactContentUrl, getChatArtifacts } from "./api.js";
import { Badge } from "@/components/ui/badge";
import {
  Alert, Button, EmptyState, Input, Panel, StatusText, WorkspaceDock, WorkspaceIntro, cn,
} from "./ui/index.js";

interface FilesViewProps {
  onSessionExpired: () => void;
}

/*
 * Wider name column on purpose: the filename is how a person recognizes their
 * file, and everything else on the row exists to confirm the guess.
 */
const ROW = "grid min-w-[920px] grid-cols-[minmax(0,1.5fr)_96px_minmax(0,1.1fr)_92px_118px_112px] items-center gap-3";

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
 * A glyph per media family, so a library scans by shape before it reads by
 * name. Decorative: the media type is printed beside the name, and the glyph
 * never carries a fact the text does not.
 */
function fileGlyph(mediaType: string): ReactNode {
  const type = mediaType.toLowerCase();
  if (type.startsWith("image/")) return <ImageIcon size={16} />;
  if (type.includes("json")) return <FileJson2 size={16} />;
  if (type.includes("zip") || type.includes("tar") || type.includes("compress")) return <FileArchive size={16} />;
  if (type.includes("csv") || type.includes("spreadsheet") || type.includes("excel")) return <FileSpreadsheet size={16} />;
  if (type.includes("javascript") || type.includes("typescript") || type.includes("python") || type.includes("x-sh")) return <FileCode2 size={16} />;
  if (type.startsWith("text/") || type.includes("markdown") || type.includes("pdf")) return <FileText size={16} />;
  return <FileIcon size={16} />;
}

type OriginFilter = "ALL" | ChatArtifactOrigin;

const ORIGIN_FILTERS: Array<{ key: OriginFilter; label: string }> = [
  { key: "ALL", label: "All" },
  { key: "AGENT", label: "Agent" },
  { key: "UPLOADED", label: "Uploaded" },
];

/**
 * Every file this principal may see, bounded by their division on the server
 * -- this view renders exactly what the list route returns, and the origin
 * filter narrows the rendering, never the tenancy.
 */
export function FilesView({ onSessionExpired }: FilesViewProps) {
  // `null` is "not loaded", distinct from the empty array that means "no
  // files": collapsing the two would render a failed load as an empty library.
  const [artifacts, setArtifacts] = useState<ChatArtifact[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [origin, setOrigin] = useState<OriginFilter>("ALL");

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
    return artifacts.filter((artifact) =>
      (origin === "ALL" || artifact.origin === origin)
      && (!needle || [artifact.name, artifact.path, artifact.conversationTitle ?? "", artifact.profileName ?? ""]
        .some((value) => value.toLowerCase().includes(needle))));
  }, [artifacts, query, origin]);

  const filtered = query.trim().length > 0 || origin !== "ALL";

  return (
    <div className="workspace-stack">
      <WorkspaceIntro icon={<FolderDown size={18} />} title="Files">
        <p className="m-0 text-caption leading-relaxed text-muted">
          Files your agents produced and files you uploaded, kept with the conversation they belong to. Agent files
          over 4 MB stay on their runtime node and are listed without being retained centrally.
        </p>
      </WorkspaceIntro>

      {failure && <Alert tone="error" className="shrink-0">{failure}</Alert>}

      <WorkspaceDock className="flex flex-wrap items-center gap-3">
        <Input
          value={query}
          placeholder="Search by name, path or conversation"
          aria-label="Search files"
          className="w-[min(48vw,360px)]"
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="flex items-center gap-1" role="group" aria-label="Filter by origin">
          {ORIGIN_FILTERS.map((filter) => (
            <Button
              key={filter.key}
              variant="ghost"
              size="sm"
              aria-pressed={origin === filter.key}
              className={cn("h-8 px-2.5", origin === filter.key ? "bg-soft text-accent" : "text-muted")}
              onClick={() => setOrigin(filter.key)}
            >
              {filter.label}
            </Button>
          ))}
        </div>
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
          <EmptyState title={filtered ? "Nothing matches" : "No files yet"}>
            {filtered
              ? "No file matches the search and filter."
              : "When an agent saves a deliverable, or you attach a file in a Session, it appears here."}
          </EmptyState>
        )}
        {visible !== null && visible.length > 0 && (
          <ul aria-label="Files" className="m-0 list-none p-0">
            <li aria-hidden="true" className={cn(ROW, "border-b border-border px-4 py-2 text-micro font-semibold uppercase tracking-[0.08em] text-faint")}>
              <span>Name</span><span>Origin</span><span>Conversation</span><span>Size</span><span>Added</span><span />
            </li>
            {visible.map((artifact) => (
              <li className={cn(ROW, "border-b border-border/60 px-4 py-2.5 transition-colors last:border-b-0 hover:bg-raised/40")} key={artifact.id}>
                <span className="flex min-w-0 items-center gap-3">
                  <span aria-hidden="true" className="grid h-8 w-8 shrink-0 place-items-center rounded border border-border bg-raised/60 text-muted">
                    {fileGlyph(artifact.mediaType)}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-label font-medium text-text">{artifact.name}</span>
                    <span className="block truncate font-mono text-micro text-faint">
                      {artifact.path !== artifact.name ? artifact.path : artifact.mediaType}
                    </span>
                  </span>
                </span>
                {/*
                  * Provenance as a labelled fact: which hands touched the file
                  * is the first thing a reader deciding whether to trust it
                  * needs, and it must not be an inference from a missing
                  * profile name.
                  */}
                <span>
                  {artifact.origin === "UPLOADED"
                    ? <Badge variant="default">Uploaded</Badge>
                    : <Badge variant="outline">Agent</Badge>}
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
