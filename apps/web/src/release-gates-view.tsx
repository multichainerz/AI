import {
  type AdministratorSession,
  EVALUATION_CATEGORIES,
  type EvaluationCategory,
  type EvaluationRun,
} from "@orcasynapse/contracts";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  OrcaSynapseApiError,
  completeEvaluationRun,
  createEvaluationRun,
  getEvaluationRuns,
  promoteEvaluationRun,
} from "./api.js";
import { Badge } from "@/components/ui/badge";
import { adminAccess } from "./admin-access.js";
import {
  Alert, Button, Input, LockedScreen, MicroLabel, PageHeader, Select, StatusText, Textarea, Tile, cn,
} from "./ui/index.js";

/**
 * Release gates: the evidence a model, prompt, policy or agent has to carry
 * before it may be activated.
 *
 * This was the "Release gates" sub-tab of a screen called "Health & evidence",
 * three levels deep and sharing a poll with the control room. It is its own
 * screen because it answers its own question — *may this artifact ship* — at
 * its own moment, for a different person than the one watching for a
 * degradation. It also has its own scopes (`evaluations:read`,
 * `evaluations:manage`, `evaluations:promote`), which the old shared tab strip
 * expressed by disabling a tab an operator could see but never open.
 *
 * The lifecycle is deliberately three permissioned steps rather than one
 * button: create a candidate, record immutable per-category results, and then
 * promote — a separate decision that demands a written rationale, because
 * promotion is what `ModelDeployment_activation_evidence_check` and its prompt
 * and guardrail siblings look for in the database.
 */

interface ReleaseGatesViewProps {
  session: AdministratorSession | null;
  onConfigure: () => void;
  onSessionExpired: () => void;
}

type EvidenceDraft = Partial<Record<EvaluationCategory, {
  totalCases: string;
  passedCases: string;
  criticalFailures: string;
  evidenceRef: string;
}>>;

function relativeTime(value: string | null): string {
  if (!value) return "never";
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed)) return "unknown";
  const minutes = Math.round(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function percentage(value: number | null): string {
  return value === null ? "--" : `${Math.round(value * 1000) / 10}%`;
}

function humanLabel(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase().replaceAll("_", " ");
}

/**
 * The four lifecycle states, on the shared Badge rather than the bare
 * `<strong className={status.toLowerCase()}>` this screen used to render — a
 * class name with no rule behind it in either theme.
 *
 * `PASSED` deliberately takes the neutral primary chip: the evidence cleared
 * the bar, but nothing has shipped until a person promotes it, and colouring it
 * green here is exactly the confusion the separate promotion step exists to
 * prevent.
 */
function statusVariant(status: EvaluationRun["status"]): "success" | "destructive" | "default" | "outline" {
  if (status === "PROMOTED") return "success";
  if (status === "FAILED") return "destructive";
  if (status === "PASSED") return "default";
  return "outline";
}

export function ReleaseGatesView({ session, onConfigure, onSessionExpired }: ReleaseGatesViewProps) {
  const [evaluations, setEvaluations] = useState<EvaluationRun[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [showEvaluationForm, setShowEvaluationForm] = useState(false);
  const [evidenceRunId, setEvidenceRunId] = useState<string | null>(null);
  const [evidenceDraft, setEvidenceDraft] = useState<EvidenceDraft>({});
  const [confirmPromotionId, setConfirmPromotionId] = useState<string | null>(null);
  const [promotionReason, setPromotionReason] = useState("");

  const { unlocked, scopes } = adminAccess(session);
  const canRead = scopes.includes("evaluations:read");
  const canManage = scopes.includes("evaluations:manage");
  const canPromote = scopes.includes("evaluations:promote");

  // Same reason Operations holds it in a ref: App passes a fresh
  // `onSessionExpired` arrow on every poll, and depending on that identity
  // through refresh would refetch on a loop and clear an error mid-read.
  const latestOnSessionExpired = useRef(onSessionExpired);
  useEffect(() => {
    latestOnSessionExpired.current = onSessionExpired;
  }, [onSessionExpired]);

  const handleError = useCallback((cause: unknown, fallback: string) => {
    if (cause instanceof OrcaSynapseApiError && cause.status === 401) latestOnSessionExpired.current();
    setError(cause instanceof Error ? cause.message : fallback);
  }, []);

  const refresh = useCallback(async () => {
    if (!unlocked || !canRead) return;
    setBusy(true);
    setError(null);
    try {
      setEvaluations((await getEvaluationRuns()).items);
    } catch (cause) {
      handleError(cause, "Release gates could not be loaded.");
    } finally {
      setBusy(false);
    }
  }, [canRead, handleError, unlocked]);

  useEffect(() => { void refresh(); }, [refresh]);

  const createEvaluation = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true); setError(null); setMessage(null);
    try {
      await createEvaluationRun({
        name: String(data.get("name") ?? ""),
        targetType: String(data.get("targetType") ?? "MODEL") as "MODEL" | "PROMPT" | "POLICY" | "AGENT",
        targetReference: String(data.get("targetReference") ?? ""),
        targetVersion: String(data.get("targetVersion") ?? ""),
        minimumPassRate: Number(data.get("minimumPassRate") ?? 95) / 100,
        requiredCategories: [...EVALUATION_CATEGORIES],
      });
      setShowEvaluationForm(false);
      // Counted from the constant, not written out. This said "six" against a
      // five-member enum — a number that was correct when someone typed it and
      // silently wrong the moment the enum changed.
      setMessage(`Evaluation candidate created with all ${EVALUATION_CATEGORIES.length} evidence categories.`);
      await refresh();
    } catch (cause) { handleError(cause, "The evaluation candidate could not be created."); }
    finally { setBusy(false); }
  };

  const openEvidence = (run: EvaluationRun) => {
    setEvidenceRunId(run.id);
    setEvidenceDraft(Object.fromEntries(run.requiredCategories.map((category) => [category, {
      totalCases: "", passedCases: "", criticalFailures: "0", evidenceRef: "",
    }])) as EvidenceDraft);
  };

  const recordEvidence = async (event: FormEvent) => {
    event.preventDefault();
    const run = evaluations.find(({ id }) => id === evidenceRunId);
    if (!run) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      await completeEvaluationRun(run.id, { results: run.requiredCategories.map((category) => {
        const value = evidenceDraft[category];
        return {
          category,
          totalCases: Number(value?.totalCases ?? 0),
          passedCases: Number(value?.passedCases ?? 0),
          criticalFailures: Number(value?.criticalFailures ?? 0),
          evidenceRefs: [value?.evidenceRef.trim() ?? ""],
        };
      }) });
      setEvidenceRunId(null); setMessage("Immutable evaluation evidence recorded.");
      await refresh();
    } catch (cause) { handleError(cause, "Evaluation evidence could not be recorded."); }
    finally { setBusy(false); }
  };

  const promote = async (event: FormEvent, id: string) => {
    event.preventDefault();
    setBusy(true); setError(null); setMessage(null);
    try {
      await promoteEvaluationRun(id, promotionReason);
      setConfirmPromotionId(null); setPromotionReason(""); setMessage("Evaluation candidate promoted with retained evidence and decision rationale.");
      await refresh();
    } catch (cause) { handleError(cause, "The evaluation candidate could not be promoted."); }
    finally { setBusy(false); }
  };

  if (!unlocked) {
    return (
      <LockedScreen
        kicker="Release gates"
        title="Release gates"
        mark="RG"
        reason="Sign in with an administrator session to review the evidence behind an activation."
        actionLabel="Administrator sign in"
        onAction={onConfigure}
      />
    );
  }

  /*
   * A scope the session does not hold is stated, not drawn as an empty list.
   * The old tab strip disabled the tab instead, which told an operator the
   * screen existed and refused to say why they could not reach it.
   */
  if (!canRead) {
    return (
      <LockedScreen
        kicker="Release gates"
        title="Release gates"
        mark="RG"
        reason="This session does not hold the evaluations:read scope. A platform administrator can grant it."
        actionLabel="Review access"
        onAction={onConfigure}
      />
    );
  }

  return (
    <>
      <PageHeader
        kicker="Activation evidence"
        title="Release gates"
        description="A model, prompt, policy or agent cannot be activated without a promoted evaluation for that exact version. Evidence is immutable once recorded; promotion is a separate, permissioned decision."
        actions={<>
          <Button onClick={() => void refresh()} disabled={busy}>{busy ? "Refreshing..." : "Refresh"}</Button>
          {canManage && <Button variant="primary" onClick={() => setShowEvaluationForm((shown) => !shown)}>{showEvaluationForm ? "Cancel" : "New candidate"}</Button>}
        </>}
      />

      <div aria-live="polite">
        {error && <Alert className="mb-4">{error}</Alert>}
        {message && <Alert tone="good" className="mb-4">{message}</Alert>}
      </div>

      <section className="grid gap-4">
        {showEvaluationForm && <form className="ops-form grid gap-3 rounded-card border border-border bg-surface p-5 shadow-card sm:grid-cols-2" onSubmit={(event) => void createEvaluation(event)}>
          <label><span>Candidate name</span><Input name="name" minLength={3} maxLength={160} required /></label>
          <label><span>Target type</span><Select name="targetType"><option>MODEL</option><option>PROMPT</option><option>POLICY</option><option>AGENT</option></Select></label>
          <label><span>Target reference</span><Input name="targetReference" placeholder="laguna-s / hermes-policy" maxLength={240} required /></label>
          <label><span>Version</span><Input name="targetVersion" placeholder="Immutable version or digest" maxLength={120} required /></label>
          <label><span>Minimum pass rate</span><Input name="minimumPassRate" type="number" min={50} max={100} step={0.1} defaultValue={95} required /></label>
          <Tile className="ops-form grid gap-1 sm:col-span-2"><span>Required evidence</span><p>{EVALUATION_CATEGORIES.map(humanLabel).join(" / ")}</p></Tile>
          <div className="flex justify-end sm:col-span-2"><Button variant="primary" type="submit" disabled={busy}>Create candidate</Button></div>
        </form>}

        {/*
          The same record card the incident ledger draws, because it is the same
          kind of object: a durable row with a provenance, a body, its facts and
          the decisions available on it. The markup arrived here verbatim from
          Operations and carried the same defect — a themed shell whose header,
          stat grid, rationale quote and footer had no classes at all, and whose
          status was a `<strong className="promoted">` naming a rule that has
          never existed in this stylesheet.
        */}
        <div className="grid gap-3">{evaluations.map((run) => <article className={cn(
            "grid gap-4 rounded-card border border-l-2 border-border bg-surface p-5 shadow-card",
            // Promotion is the only state that means shipped; PASSED is the one
            // waiting on a person, so it takes the accent rather than a verdict
            // colour it has not earned.
            run.status === "PROMOTED" ? "border-l-good"
              : run.status === "FAILED" ? "border-l-bad"
              : run.status === "PASSED" ? "border-l-accent"
              : "border-l-warn",
          )} key={run.id}>
          <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
            <div className="min-w-0">
              <MicroLabel className="mb-1.5 block">{humanLabel(run.targetType)}</MicroLabel>
              <h3 className="m-0 font-display text-[14px] font-semibold tracking-[-0.01em] text-text">{run.name}</h3>
              {/* Evidence is per exact version — the reference on its own would
                  name the wrong artifact — so the version stays on the identity
                  line, one step quieter than the thing it qualifies. */}
              <p className="mb-0 mt-1 truncate font-mono text-caption text-muted">
                {run.targetReference}<span className="text-faint"> / {run.targetVersion}</span>
              </p>
            </div>
            <Badge variant={statusVariant(run.status)}>{humanLabel(run.status)}</Badge>
          </header>
          <dl className="m-0 grid grid-cols-2 gap-px rounded border border-border bg-border sm:grid-cols-4">
            {[
              { label: "Observed pass rate", value: percentage(run.passRate) },
              { label: "Cases passed", value: `${run.passedCases}/${run.totalCases}` },
              { label: "Critical failures", value: String(run.criticalFailures) },
              { label: "Required minimum", value: percentage(run.minimumPassRate) },
            ].map((fact) => (
              <div className="min-w-0 bg-surface px-2.5 py-2" key={fact.label}>
                <dt className="truncate text-micro font-semibold uppercase tabular-nums text-faint">{fact.label}</dt>
                <dd className="m-0 mt-1 truncate font-display text-label font-semibold tabular-nums text-text">{fact.value}</dd>
              </div>
            ))}
          </dl>
          <div className="flex flex-wrap items-center gap-1.5">
            <MicroLabel className="mr-1">Required evidence</MicroLabel>
            {run.requiredCategories.map((category) => (
              <code className="rounded border border-border bg-raised px-2 py-1 font-mono text-micro text-muted" key={category}>{humanLabel(category)}</code>
            ))}
          </div>
          {run.promotionReason && <blockquote className="m-0 rounded border border-l-2 border-border border-l-accent bg-raised p-3">
            <MicroLabel className="block">Promotion rationale</MicroLabel>
            <span className="mt-1 block text-body leading-relaxed text-muted">{run.promotionReason}</span>
          </blockquote>}
          <footer className="flex flex-wrap items-center justify-between gap-2.5 border-t border-border pt-3.5">
            <StatusText>Created {relativeTime(run.createdAt)}{run.promotedAt ? ` / promoted ${relativeTime(run.promotedAt)}` : ""}</StatusText>
            <div className="flex gap-2">{run.status === "DRAFT" && canManage && <Button size="sm" onClick={() => openEvidence(run)}>Record evidence</Button>}{run.status === "PASSED" && canPromote && <Button variant="primary" size="sm" onClick={() => { setConfirmPromotionId(run.id); setPromotionReason(""); }}>Promote</Button>}</div>
          </footer>
          {confirmPromotionId === run.id && <form className="ops-form grid gap-3 rounded border border-border-strong bg-raised p-3" onSubmit={(event) => void promote(event, run.id)}><label><span>Promotion rationale</span><Textarea value={promotionReason} onChange={(event) => setPromotionReason(event.target.value)} minLength={3} maxLength={1000} rows={2} placeholder="Why this exact evidence is approved for release" required /></label><div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => { setConfirmPromotionId(null); setPromotionReason(""); }}>Cancel</Button><Button type="submit" disabled={busy}>Confirm promotion</Button></div></form>}
          {evidenceRunId === run.id && <form className="ops-form grid gap-3 rounded border border-border-strong bg-raised p-3" onSubmit={(event) => void recordEvidence(event)}><div className="flex items-start justify-between gap-4"><div><strong>Record immutable results</strong><span>Every required category needs an evidence artifact reference.</span></div><Button variant="ghost" size="sm" onClick={() => setEvidenceRunId(null)}>Close</Button></div>{run.requiredCategories.map((category) => {
            const draft = evidenceDraft[category];
            const update = (field: "totalCases" | "passedCases" | "criticalFailures" | "evidenceRef", value: string) => setEvidenceDraft((current) => ({ ...current, [category]: { totalCases: "", passedCases: "", criticalFailures: "0", evidenceRef: "", ...current[category], [field]: value } }));
            return <fieldset key={category}><legend>{humanLabel(category)}</legend><label><span>Total</span><Input type="number" min={1} value={draft?.totalCases ?? ""} onChange={(event) => update("totalCases", event.target.value)} required /></label><label><span>Passed</span><Input type="number" min={0} value={draft?.passedCases ?? ""} onChange={(event) => update("passedCases", event.target.value)} required /></label><label><span>Critical</span><Input type="number" min={0} value={draft?.criticalFailures ?? "0"} onChange={(event) => update("criticalFailures", event.target.value)} required /></label><label className="sm:col-span-3"><span>Evidence reference</span><Input value={draft?.evidenceRef ?? ""} onChange={(event) => update("evidenceRef", event.target.value)} placeholder="Report ID or immutable URI" required /></label></fieldset>;
          })}<div className="flex justify-end sm:col-span-2"><Button variant="primary" type="submit" disabled={busy}>Complete evaluation</Button></div></form>}
        </article>)}{evaluations.length === 0 && <p className={cn("m-0 rounded border border-dashed border-border px-4 py-7 text-body text-muted")}>No evaluation candidates have been created. Nothing can be activated until one is created, completed and promoted.</p>}</div>
      </section>
    </>
  );
}
