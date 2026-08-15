import type {
  AdministratorSession,
  CreateHermesCorpusMutation,
  HermesCorpusEntry,
  HermesCorpusMutation,
  HermesCorpusRevision,
  HermesCorpusStatus,
} from "@orcasynapse/contracts";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  OrcaSynapseApiError,
  createHermesCorpusMutation,
  decideHermesCorpusMutation,
  getHermesCorpusEntries,
  getHermesCorpusMutations,
  getHermesCorpusOverview,
  getHermesCorpusRevisions,
} from "./api.js";
import { SnapshotIcon, StorageIcon, SyncIcon, TerminalIcon } from "./ui/relay-icons.js";
import {
  Alert, Button, Dialog, EmptyState, Field, Input, LockedScreen, MicroLabel, PageHeader,
  Panel, PanelHeading, Select, StatusText, Textarea, Tile, cn,
} from "./ui/index.js";

/**
 * Which half of the Hermes corpus a mounted instance of this screen governs.
 *
 * The split is the contract's, not an invention of the UI: the VM2 reconciler
 * classifies exactly `memories/MEMORY.md` and `memories/USER.md` as `MEMORY`
 * and every other allowlisted path as one of the four skill kinds, so "Skills"
 * and "Memory" partition the mirror with nothing left over and nothing shared.
 * The mutation vocabulary partitions the same way — every operation is either
 * `MEMORY_*` or `SKILL_*` — which is what lets each tab show only the change
 * requests it could itself have made.
 */
export type CorpusScope = "SKILLS" | "MEMORY";

interface CorpusViewProps {
  session: AdministratorSession | null;
  scope: CorpusScope;
  onConfigure: () => void;
  onSessionExpired: () => void;
}

type Operation = CreateHermesCorpusMutation["operation"];
type Draft = {
  operation: Operation;
  path: string;
  expectedHash: string | null;
  content: string;
  oldText: string;
  reason: string;
};

const skillKinds: Array<{ value: HermesCorpusEntry["kind"] | ""; label: string }> = [
  { value: "", label: "All skill files" },
  { value: "SKILL", label: "Skills" },
  { value: "SKILL_FILE", label: "Skill support" },
  { value: "SKILL_BUNDLE", label: "Bundles" },
  { value: "PROVENANCE", label: "Provenance" },
  { value: "PENDING_CHANGE", label: "Pending changes" },
];

const scopes: Record<CorpusScope, {
  title: string;
  kicker: string;
  mark: string;
  description: string;
  lockedReason: string;
  deniedReason: string;
  countLabel: string;
  emptyTitle: string;
  emptyBody: string;
  selectTitle: string;
  selectBody: string;
}> = {
  SKILLS: {
    title: "Hermes Skills",
    kicker: "Hermes native skills",
    mark: "HS",
    description: "The Skill files Hermes actually loads, with their support files, bundles and provenance. VM2 remains canonical; this control plane mirrors, searches, versions, and audits signed changes.",
    lockedReason: "An administrator session is required to inspect the native Hermes Skill repository.",
    deniedReason: "Your role cannot observe the Hermes repository mirror.",
    countLabel: "Mirrored Skill files",
    emptyTitle: "No skill files",
    emptyBody: "The enrolled Hermes node has not synchronized matching Skill files yet.",
    selectTitle: "Select a Skill file",
    selectBody: "Choose a Skill, support file or bundle to inspect its mirrored content and history.",
  },
  MEMORY: {
    title: "Hermes Memory",
    kicker: "Hermes native memory",
    mark: "HM",
    description: "MEMORY.md and USER.md as Hermes actually holds them. VM2 remains canonical; this control plane mirrors, versions, and audits signed changes. Memory is never used as model context from here.",
    lockedReason: "An administrator session is required to inspect native Hermes memory.",
    deniedReason: "Your role cannot observe the Hermes repository mirror.",
    countLabel: "Mirrored memory files",
    emptyTitle: "No memory files",
    emptyBody: "The enrolled Hermes node has not synchronized MEMORY.md or USER.md yet.",
    selectTitle: "Select a memory file",
    selectBody: "Choose MEMORY.md or USER.md to inspect its mirrored entries and history.",
  },
};

const destructive = new Set<Operation>(["MEMORY_REMOVE", "SKILL_DELETE", "SKILL_REMOVE_FILE"]);
function time(value: string | null): string {
  if (!value) return "Never";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function bytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}

function shortHash(value: string | null): string {
  return value ? value.slice(0, 10) : "—";
}

function mutationTone(status: HermesCorpusMutation["status"]): "good" | "warn" | "bad" | "accent" | "neutral" {
  if (status === "APPLIED") return "good";
  if (["FAILED", "CONFLICT", "REJECTED", "EXPIRED"].includes(status)) return "bad";
  if (status === "PENDING_APPROVAL") return "warn";
  if (["QUEUED", "DISPATCHED"].includes(status)) return "accent";
  return "neutral";
}

function operationForEntry(entry: HermesCorpusEntry): Operation | null {
  if (entry.readOnly) return null;
  if (entry.kind === "MEMORY") return "MEMORY_ADD";
  if (entry.kind === "SKILL") return "SKILL_EDIT";
  if (entry.kind === "SKILL_FILE") return "SKILL_WRITE_FILE";
  return null;
}

function initialDraft(operation: Operation, entry?: HermesCorpusEntry | null, oldText = ""): Draft {
  return {
    operation,
    path: entry?.path ?? "skills/new-skill/SKILL.md",
    expectedHash: ["MEMORY_ADD", "SKILL_CREATE"].includes(operation) ? null : entry?.sha256 ?? null,
    content: operation === "MEMORY_REPLACE" ? oldText
      : operation === "MEMORY_ADD" ? ""
      : operation === "SKILL_CREATE" ? "---\nname: new-skill\ndescription: Describe when Hermes should use this skill.\n---\n\n# New skill\n\nAdd bounded instructions for Hermes.\n"
      : entry?.content ?? "",
    oldText,
    reason: "Maintain the governed Hermes corpus through the control plane.",
  };
}

export function CorpusView({ session, scope, onConfigure, onSessionExpired }: CorpusViewProps) {
  const copy = scopes[scope];
  const memoryScope = scope === "MEMORY";
  const [nodes, setNodes] = useState<HermesCorpusStatus[]>([]);
  const [nodeId, setNodeId] = useState("");
  const [entries, setEntries] = useState<HermesCorpusEntry[]>([]);
  const [mutations, setMutations] = useState<HermesCorpusMutation[]>([]);
  const [revisions, setRevisions] = useState<HermesCorpusRevision[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<HermesCorpusEntry["kind"] | "">("");
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [revisionFocus, setRevisionFocus] = useState<HermesCorpusRevision | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const selected = useMemo(() => entries.find((entry) => entry.id === selectedId) ?? entries[0] ?? null, [entries, selectedId]);
  const node = nodes.find((item) => item.nodeId === nodeId) ?? null;
  const canObserve = session?.scopes.includes("corpus:metadata:read") === true
    || session?.scopes.includes("corpus:content:read") === true;
  const canReadContent = session?.scopes.includes("corpus:content:read") === true;
  const canWrite = session?.scopes.includes("corpus:write") === true;
  const canDelete = session?.scopes.includes("corpus:delete") === true;
  const canApprove = session?.scopes.includes("corpus:approve") === true;

  const fail = (cause: unknown) => {
    if (cause instanceof OrcaSynapseApiError && cause.status === 401) onSessionExpired();
    setError(cause instanceof Error ? cause.message : `OrcaSynapse could not load ${copy.title}.`);
  };

  const loadOverview = async () => {
    const overview = await getHermesCorpusOverview();
    setNodes(overview.nodes);
    setNodeId((current) => current || overview.nodes.find(({ available }) => available)?.nodeId || overview.nodes[0]?.nodeId || "");
  };

  const loadRepository = async (targetNodeId = nodeId) => {
    if (!targetNodeId || !canObserve) return;
    setLoading(true);
    try {
      const [entryList, mutationList] = await Promise.all([
        getHermesCorpusEntries({
          nodeId: targetNodeId,
          ...(query.trim() ? { query: query.trim() } : {}),
          /*
           * Memory is a single kind, so the mirror is asked for that kind and
           * answers with the two files. Skills is four kinds and the entries
           * endpoint takes one, so the ask stays broad and the partition is
           * applied on arrival rather than through four round trips.
           */
          kind: memoryScope ? "MEMORY" : kind,
          includeDeleted,
          includeContent: canReadContent,
        }),
        canReadContent ? getHermesCorpusMutations(targetNodeId) : Promise.resolve({ items: [] }),
      ]);
      const items = entryList.items.filter(({ kind: entryKind }) => (entryKind === "MEMORY") === memoryScope);
      setEntries(items);
      setMutations(mutationList.items.filter(
        ({ operation }) => operation.startsWith("MEMORY_") === memoryScope,
      ));
      setSelectedId((current) => items.some(({ id }) => id === current) ? current : items[0]?.id ?? "");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!session || !canObserve) return;
    void loadOverview().catch(fail);
  }, [session?.id, canObserve]);

  useEffect(() => {
    if (!nodeId || !canObserve) return;
    const timer = window.setTimeout(() => void loadRepository(nodeId).catch(fail), 220);
    return () => window.clearTimeout(timer);
  }, [nodeId, query, kind, includeDeleted, canObserve, canReadContent, memoryScope]);

  useEffect(() => {
    if (!nodeId || !canObserve) return;
    const timer = window.setInterval(() => {
      void Promise.all([loadOverview(), loadRepository(nodeId)]).catch(fail);
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [nodeId, query, kind, includeDeleted, canObserve, canReadContent, memoryScope]);

  useEffect(() => {
    if (!selected) { setRevisions([]); return; }
    let active = true;
    void getHermesCorpusRevisions(selected.id, canReadContent)
      .then((result) => { if (active) setRevisions(result.items); })
      .catch((cause) => { if (active) fail(cause); });
    return () => { active = false; };
  }, [selected?.id, selected?.revision, canReadContent]);

  const refresh = async () => {
    setError(null);
    await Promise.all([loadOverview(), loadRepository()]);
  };

  const openOperation = (operation: Operation, oldText = "") => {
    setNotice(null);
    setDraft(initialDraft(operation, selected, oldText));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft || !nodeId) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const created = await createHermesCorpusMutation({
        nodeId,
        operation: draft.operation,
        path: draft.path.trim(),
        expectedHash: draft.expectedHash,
        content: ["MEMORY_ADD", "MEMORY_REPLACE", "SKILL_CREATE", "SKILL_EDIT", "SKILL_WRITE_FILE"].includes(draft.operation)
          ? draft.content : null,
        oldText: ["MEMORY_REPLACE", "MEMORY_REMOVE"].includes(draft.operation) ? draft.oldText : null,
        reason: draft.reason,
      });
      setDraft(null);
      setNotice(created.status === "PENDING_APPROVAL"
        ? "The destructive change is awaiting approval from another administrator."
        : "The change is queued for signed delivery to Hermes.");
      await loadRepository();
    } catch (cause) { fail(cause); }
    finally { setBusy(false); }
  };

  const decide = async (mutation: HermesCorpusMutation, decision: "APPROVE" | "REJECT") => {
    setBusy(true); setError(null); setNotice(null);
    try {
      await decideHermesCorpusMutation(mutation.id, {
        decision,
        reason: decision === "APPROVE" ? "Reviewed and approved through the Hermes corpus control plane." : "Rejected during corpus governance review.",
      });
      setNotice(decision === "APPROVE" ? "The approved change is queued for Hermes." : "The change was rejected.");
      await loadRepository();
    } catch (cause) { fail(cause); }
    finally { setBusy(false); }
  };

  if (!session) return (
    <LockedScreen title={copy.title} mark={copy.mark} actionLabel="Administrator sign in" onAction={onConfigure}
      reason={copy.lockedReason} />
  );
  if (!canObserve) return (
    <LockedScreen title={copy.title} mark={copy.mark} actionLabel="Review access" onAction={onConfigure}
      headline="Corpus access required" reason={copy.deniedReason} />
  );

  return (
    <div className="mx-auto w-full max-w-[1540px]">
      <PageHeader kicker={copy.kicker} title={copy.title}
        description={copy.description}
        actions={<Button onClick={() => void refresh().catch(fail)} disabled={loading}><SyncIcon size={16} />Refresh</Button>} />

      {error ? <Alert className="mb-4" onDismiss={() => setError(null)}>{error}</Alert> : null}
      {notice ? <Alert className="mb-4" tone="good" onDismiss={() => setNotice(null)}>{notice}</Alert> : null}
      {!canReadContent ? <Alert className="mb-4" tone="warn">Your role has metadata-only access. Paths, hashes, sizes, synchronization state, and revision events are visible; mirrored file contents and mutation requests remain concealed.</Alert> : null}

      <Panel className="mb-4 grid gap-4 p-4 md:grid-cols-[minmax(220px,0.8fr)_minmax(0,1.2fr)_auto] md:items-end">
        <Field label="Hermes node">
          <Select value={nodeId} onChange={(event) => setNodeId(event.target.value)}>
            {nodes.map((item) => <option key={item.nodeId} value={item.nodeId}>{item.nodeDisplayName}</option>)}
          </Select>
        </Field>
        <Field label="Lexical search">
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search paths and mirrored text…" />
        </Field>
        <div className="flex gap-2">
          {/* Memory is one kind, so a kind filter there would be a control with
              one option. Skills is four, and the filter earns its place. */}
          {memoryScope ? null : (
            <Select aria-label="Corpus kind" value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
              {skillKinds.map((item) => <option key={item.value || "all"} value={item.value}>{item.label}</option>)}
            </Select>
          )}
          <Button className="shrink-0" variant={includeDeleted ? "primary" : "secondary"} onClick={() => setIncludeDeleted((value) => !value)}>
            Deleted
          </Button>
        </div>
      </Panel>

      {node ? (
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Tile><MicroLabel className="block">Synchronization</MicroLabel><StatusText className="mt-2" dot tone={!node.available ? "bad" : node.stale ? "warn" : "good"}>{!node.available ? "Unavailable" : node.stale ? "Stale" : "Current"}</StatusText></Tile>
          {/* The node-level total would be a different, larger number than the
              list beneath it, so this tile counts what the tab actually shows. */}
          <Tile><MicroLabel className="block">{copy.countLabel}</MicroLabel><strong className="mt-2 block font-display text-figure text-text">{entries.length}</strong></Tile>
          <Tile><MicroLabel className="block">Observed corpus</MicroLabel><strong className="mt-2 block font-display text-figure text-text">{bytes(node.totalBytes)}</strong></Tile>
          <Tile><MicroLabel className="block">Last signed snapshot</MicroLabel><strong className="mt-2 block text-label text-text">{time(node.lastSyncedAt)}</strong><span className="mt-1 block font-mono text-micro text-faint">{shortHash(node.rootHash)}</span></Tile>
        </div>
      ) : null}

      {node && !node.available ? (
        <Alert className="mb-4" tone="warn">This VM2 predates corpus-sync-v1. Run its generated installer with <span className="font-mono">--repair</span> to add signed corpus synchronization; no clean VM rebuild is required.</Alert>
      ) : null}

      <div className="grid min-h-[590px] gap-4 xl:grid-cols-[300px_minmax(0,1fr)_340px]">
        <Panel className="min-w-0 p-3">
          {/* `node?.writable`, like every other write on this screen: it means
              the node advertised the corpus capability and is neither REVOKED
              nor SUSPENDED, and `createMutation` answers those two with a 409.
              Without it the operator authors a whole SKILL.md on a
              pre-corpus-sync-v1 node and the draft is discarded on submit. */}
          <PanelHeading className="px-1 pt-1" kicker="Repository" title={memoryScope ? "Memory files" : "Skill files"}
            actions={canWrite && !memoryScope && node?.writable ? <Button size="sm" onClick={() => { setSelectedId(""); setDraft(initialDraft("SKILL_CREATE")); }}>New skill</Button> : undefined} />
          {/* The two native memory files can be created before Hermes has ever
              written them, which is the one write this tab offers up front. */}
          {memoryScope && canWrite && node?.writable ? <div className="mb-3 grid grid-cols-2 gap-2">
            <Button size="sm" onClick={() => setDraft({ ...initialDraft("MEMORY_ADD"), path: "memories/MEMORY.md" })}>Add agent memory</Button>
            <Button size="sm" onClick={() => setDraft({ ...initialDraft("MEMORY_ADD"), path: "memories/USER.md" })}>Add user profile</Button>
          </div> : null}
          <div className="grid max-h-[520px] gap-1.5 overflow-y-auto pr-1">
            {/*
              * `size="auto"` and an explicit single column, for the reason
              * `agent-run-ledger.tsx` and `agents-view.tsx` already carry: a
              * row is three stacked lines, every other size is a fixed
              * single-line height, and the Button base is
              * `inline-flex items-center justify-center` -- so the default
              * drew filename, path and kind side by side inside 36px. jsdom
              * sees none of it.
              */}
            {entries.map((entry) => (
              <Button key={entry.id} variant="ghost" size="auto" onClick={() => setSelectedId(entry.id)}
                className={cn("grid w-full grid-cols-1 rounded border p-3 text-left transition-colors", selected?.id === entry.id ? "border-accent/50 bg-soft" : "border-transparent hover:border-border hover:bg-raised", entry.deletedAt && "opacity-55")}>
                <span className="flex items-center gap-2 text-label font-semibold text-text"><StorageIcon size={14} /><span className="truncate">{entry.path.split("/").at(-1)}</span></span>
                <span className="mt-1 block truncate font-mono text-micro text-faint">{entry.path}</span>
                <span className="mt-2 flex items-center justify-between"><MicroLabel>{entry.kind.replaceAll("_", " ")}</MicroLabel><span className="text-micro text-muted">r{entry.revision}</span></span>
              </Button>
            ))}
            {!loading && entries.length === 0 ? <EmptyState title={copy.emptyTitle}>{copy.emptyBody}</EmptyState> : null}
            {loading ? <p className="px-2 text-body text-muted">Reading the signed mirror…</p> : null}
          </div>
        </Panel>

        <Panel className="min-w-0">
          {selected ? (
            <>
              <PanelHeading kicker={selected.kind.replaceAll("_", " ")} title={selected.path}
                description={`${bytes(selected.sizeBytes)} · revision ${selected.revision} · observed ${time(selected.observedAt)}`}
                actions={operationForEntry(selected) && canWrite && node?.writable ? <Button size="sm" variant="primary" onClick={() => openOperation(operationForEntry(selected)!)}>{selected.kind === "MEMORY" ? "Add memory" : "Edit"}</Button> : undefined} />
              <div className="mb-4 flex flex-wrap gap-2">
                <StatusText tone={selected.readOnly ? "warn" : "good"}>{selected.readOnly ? "Mirror only" : "Governed writes"}</StatusText>
                <span className="font-mono text-micro text-faint">sha256:{shortHash(selected.sha256)}</span>
              </div>
              {!canReadContent ? (
                <EmptyState title="Metadata-only access">Your role can inspect file identity and revision metadata, but not mirrored Hermes content.</EmptyState>
              ) : selected.kind === "MEMORY" && selected.structuredEntries?.length ? (
                <div className="mb-4 grid gap-2">
                  {selected.structuredEntries.map((memory, index) => (
                    <Tile key={`${selected.id}-${index}`}>
                      <p className="m-0 whitespace-pre-wrap text-body leading-relaxed text-text">{memory}</p>
                      {canWrite && node?.writable ? <div className="mt-3 flex justify-end gap-2">
                        <Button size="sm" onClick={() => openOperation("MEMORY_REPLACE", memory)}>Replace</Button>
                        {canDelete ? <Button size="sm" variant="danger" onClick={() => openOperation("MEMORY_REMOVE", memory)}>Remove</Button> : null}
                      </div> : null}
                    </Tile>
                  ))}
                </div>
              ) : selected.content !== null ? (
                <pre className="m-0 max-h-[430px] overflow-auto whitespace-pre-wrap rounded border border-border bg-bg p-4 font-mono text-[11.5px] leading-relaxed text-text">{selected.content}</pre>
              ) : (
                <EmptyState title="Content is not mirrored">This file is binary, oversized, sensitive, or intentionally metadata-only.</EmptyState>
              )}
              {!selected.readOnly && canWrite && node?.writable && selected.kind === "SKILL" ? <div className="mt-4 flex justify-end gap-2">
                <Button onClick={() => setDraft({ ...initialDraft("SKILL_WRITE_FILE"), path: `${selected.path.slice(0, -"SKILL.md".length)}references/notes.md` })}>New support file</Button>
                {canDelete ? <>
                <Button variant="danger" onClick={() => openOperation("SKILL_DELETE")}>Delete skill</Button>
                </> : null}
              </div> : null}
              {!selected.readOnly && canDelete && node?.writable && selected.kind === "SKILL_FILE" ? <div className="mt-4 flex justify-end">
                <Button variant="danger" onClick={() => openOperation("SKILL_REMOVE_FILE")}>Delete file</Button>
              </div> : null}
            </>
          ) : <EmptyState title={copy.selectTitle}>{copy.selectBody}</EmptyState>}
        </Panel>

        <div className="grid min-w-0 content-start gap-4">
          <Panel className="p-4">
            <PanelHeading kicker="Change control" title="Recent requests" />
            <div className="grid max-h-[300px] gap-2 overflow-y-auto">
              {mutations.slice(0, 20).map((mutation) => (
                <Tile key={mutation.id} pad="sm">
                  <div className="flex items-start justify-between gap-3"><strong className="text-label text-text">{mutation.operation.replaceAll("_", " ")}</strong><StatusText tone={mutationTone(mutation.status)}>{mutation.status.replaceAll("_", " ")}</StatusText></div>
                  <span className="mt-1 block truncate font-mono text-micro text-faint">{mutation.path}</span>
                  {mutation.error ? <p className="mb-0 mt-2 text-caption text-bad">{mutation.error}</p> : null}
                  {mutation.status === "PENDING_APPROVAL" && mutation.requestedBySubject === session.subject ? (
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <p className="m-0 text-caption text-warn">A different administrator must approve this request.</p>
                      {canApprove ? <Button size="sm" variant="danger" disabled={busy} onClick={() => void decide(mutation, "REJECT")}>Withdraw</Button> : null}
                    </div>
                  ) : null}
                  {mutation.status === "PENDING_APPROVAL" && canApprove && mutation.requestedBySubject !== session.subject ? <div className="mt-2 flex gap-2">
                    <Button size="sm" variant="primary" disabled={busy} onClick={() => void decide(mutation, "APPROVE")}>Approve</Button>
                    <Button size="sm" variant="danger" disabled={busy} onClick={() => void decide(mutation, "REJECT")}>Reject</Button>
                  </div> : null}
                </Tile>
              ))}
              {mutations.length === 0 ? <EmptyState title="No change requests">Changes made here will be signed, dispatched, and audited.</EmptyState> : null}
            </div>
          </Panel>
          <Panel className="p-4">
            <PanelHeading kicker="Immutable mirror history" title="Revisions" />
            <div className="grid max-h-[250px] gap-2 overflow-y-auto">
              {revisions.map((revision) => <Tile key={revision.id} pad="sm">
                <div className="flex items-center justify-between"><span className="flex items-center gap-2 text-label font-semibold text-text"><SnapshotIcon size={14} />Revision {revision.revision}</span><StatusText tone={revision.changeKind === "DELETED" ? "bad" : "neutral"}>{revision.changeKind}</StatusText></div>
                <span className="mt-1 block text-caption text-muted">{time(revision.createdAt)}</span>
                <div className="mt-1 flex items-center justify-between gap-2"><span className="font-mono text-micro text-faint">{shortHash(revision.beforeHash)} → {shortHash(revision.afterHash)}</span><Button size="sm" variant="ghost" onClick={() => setRevisionFocus(revision)}>Inspect</Button></div>
              </Tile>)}
              {selected && revisions.length === 0 ? <EmptyState title="No revisions yet">History appears after the first signed snapshot.</EmptyState> : null}
            </div>
          </Panel>
        </div>
      </div>

      <Dialog open={draft !== null} onClose={() => !busy && setDraft(null)}
        kicker="Governed Hermes mutation" title={draft?.operation.replaceAll("_", " ") ?? "Corpus change"}
        description={draft && destructive.has(draft.operation) ? "This destructive request requires approval by another administrator." : "The expected content hash prevents overwriting a newer Hermes file."}
        footer={<><Button onClick={() => setDraft(null)} disabled={busy}>Cancel</Button><Button variant={draft && destructive.has(draft.operation) ? "danger" : "primary"} type="submit" form="corpus-mutation-form" disabled={busy}>{busy ? "Submitting…" : "Submit change"}</Button></>}>
        {draft ? <form id="corpus-mutation-form" className="grid gap-4" onSubmit={(event) => void submit(event)}>
          <Field label="Repository path" hint={draft.operation === "SKILL_CREATE" ? "The final directory name must match the name in SKILL.md frontmatter." : undefined}><Input value={draft.path} disabled={!(draft.operation === "SKILL_CREATE" || (draft.operation === "SKILL_WRITE_FILE" && draft.expectedHash === null))} onChange={(event) => setDraft({ ...draft, path: event.target.value })} /></Field>
          {["MEMORY_ADD", "MEMORY_REPLACE", "SKILL_CREATE", "SKILL_EDIT", "SKILL_WRITE_FILE"].includes(draft.operation) ? <Field label={draft.operation.startsWith("MEMORY_") ? "Memory text" : "File content"}><Textarea className="min-h-[240px] font-mono" required value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} /></Field> : null}
          {draft.oldText ? <Field label="Matched current text" hint="Hermes replaces or removes only this exact memory entry."><Textarea readOnly value={draft.oldText} /></Field> : null}
          <Field label="Audit reason"><Textarea required value={draft.reason} onChange={(event) => setDraft({ ...draft, reason: event.target.value })} /></Field>
          <div className="flex items-start gap-3 rounded border border-border bg-raised p-3"><TerminalIcon className="mt-0.5 shrink-0" size={17} /><p className="m-0 text-caption leading-relaxed text-muted">Hermes validates and applies this mutation on VM2. OrcaSynapse never mounts or directly reads its filesystem.</p></div>
        </form> : null}
      </Dialog>
      <Dialog open={revisionFocus !== null} onClose={() => setRevisionFocus(null)}
        kicker="Immutable corpus revision" title={revisionFocus ? `Revision ${revisionFocus.revision}` : "Revision"}
        description={revisionFocus ? `${revisionFocus.changeKind.toLowerCase()} · ${time(revisionFocus.createdAt)} · ${revisionFocus.path}` : undefined}
        footer={<Button onClick={() => setRevisionFocus(null)}>Close</Button>}>
        {revisionFocus ? <div className="grid gap-4">
          <div><MicroLabel className="mb-2 block">Before</MicroLabel>{revisionFocus.beforeContent === null ? <EmptyState title="No prior content" /> : <pre className="m-0 max-h-[240px] overflow-auto whitespace-pre-wrap rounded border border-border bg-bg p-3 font-mono text-[11px] text-text">{revisionFocus.beforeContent}</pre>}</div>
          <div><MicroLabel className="mb-2 block">After</MicroLabel>{revisionFocus.afterContent === null ? <EmptyState title="No resulting content" /> : <pre className="m-0 max-h-[240px] overflow-auto whitespace-pre-wrap rounded border border-border bg-bg p-3 font-mono text-[11px] text-text">{revisionFocus.afterContent}</pre>}</div>
          {revisionFocus.mutationId ? <span className="font-mono text-micro text-faint">Mutation {revisionFocus.mutationId}</span> : null}
        </div> : null}
      </Dialog>
    </div>
  );
}
