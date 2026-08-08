import {
  BENCHMARK_ASSERTION_KINDS,
  BENCHMARK_KINDS,
  type BenchmarkAssertion,
  type BenchmarkAssertionKind,
  type BenchmarkCase,
  type BenchmarkKind,
  type BenchmarkSuite,
  type CreateBenchmarkSuite,
} from "@orcasynapse/contracts";
import { useState, type FormEvent } from "react";
import { createBenchmarkSuite, updateBenchmarkSuite } from "./api.js";
import { Alert, Button, Drawer, Field, Input, MicroLabel, Select, Textarea } from "./ui/index.js";

/**
 * Authors a suite: the questions, and what their answers must contain.
 *
 * A Drawer rather than a Dialog because a suite is a long form — the primitive
 * set reserves the edge-anchored one for exactly this.
 */

interface SuiteEditorProps {
  /** Absent for a new suite; present to edit an existing one. */
  suite: BenchmarkSuite | null;
  onSaved: (note: string) => void;
  onClose: () => void;
}

const kindLabel: Record<BenchmarkKind, string> = {
  CHAT_QUALITY: "Chat quality — ask the agent",
  RETRIEVAL: "Retrieval — search the documents",
  MEMORY: "Memory — read what the agent knows",
};

const assertionLabel: Record<BenchmarkAssertionKind, string> = {
  MUST_INCLUDE: "must include",
  MUST_NOT_INCLUDE: "must not include",
  MUST_CITE_DOCUMENT: "must cite document",
  MAX_LATENCY_MS: "at most (ms)",
};

const assertionHint: Record<BenchmarkAssertionKind, string> = {
  MUST_INCLUDE: "A phrase the answer has to contain, matched case-insensitively.",
  MUST_NOT_INCLUDE: "A phrase the answer may never contain — a leak, a competitor, a refusal.",
  MUST_CITE_DOCUMENT: "Part of the file name the answer must have drawn on.",
  MAX_LATENCY_MS: "A whole number of milliseconds.",
};

/**
 * Slug fields, shared by every screen that names a record by one.
 *
 * A slug field rewrites what it is given, which means the rewrite runs once per
 * keystroke. `slugAsTyped` is therefore the only rule allowed there, and it
 * deliberately keeps a trailing hyphen: trimming one on each keystroke removes
 * the separator before the character after it arrives, so `retrieval-latency`
 * comes out `retrievallatency` and no hyphenated slug — which every seeded
 * default in this product is — can be typed at all.
 *
 * `slugify` settles the value instead, and so belongs on blur and on submit,
 * where the operator has finished typing. It trims after the length cap rather
 * than before, because a cut at a hyphen would otherwise leave one trailing.
 */
export function slugAsTyped(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+/, "")
    .slice(0, 64);
}

export function slugify(value: string): string {
  return slugAsTyped(value).replace(/-+$/, "");
}

const emptyCase = (index: number): BenchmarkCase => ({
  id: `case-${index + 1}`,
  prompt: "",
  intent: "",
  assertions: [{ kind: "MUST_INCLUDE", value: "" }],
});

const emptyDraft: CreateBenchmarkSuite = {
  slug: "",
  displayName: "",
  description: "",
  kind: "CHAT_QUALITY",
  cases: [emptyCase(0)],
  passThreshold: 0.9,
};

export function BenchmarkSuiteEditor({ suite, onSaved, onClose }: SuiteEditorProps) {
  const [draft, setDraft] = useState<CreateBenchmarkSuite>(() => suite
    ? {
      slug: suite.slug,
      displayName: suite.displayName,
      description: suite.description,
      kind: suite.kind,
      cases: suite.cases.map((item) => ({ ...item, assertions: [...item.assertions] })),
      passThreshold: suite.passThreshold,
    }
    : emptyDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patchCase = (index: number, change: Partial<BenchmarkCase>) => {
    setDraft((current) => ({
      ...current,
      cases: current.cases.map((item, at) => at === index ? { ...item, ...change } : item),
    }));
  };

  const patchAssertion = (caseIndex: number, index: number, change: Partial<BenchmarkAssertion>) => {
    setDraft((current) => ({
      ...current,
      cases: current.cases.map((item, at) => at === caseIndex
        ? { ...item, assertions: item.assertions.map((rule, on) => on === index ? { ...rule, ...change } : rule) }
        : item),
    }));
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (suite) {
        await updateBenchmarkSuite(suite.id, {
          expectedRevision: suite.revision,
          displayName: draft.displayName,
          description: draft.description,
          cases: draft.cases.map((item) => ({ ...item, id: slugify(item.id) })),
          passThreshold: draft.passThreshold,
        });
        onSaved(`'${draft.displayName}' saved.`);
      } else {
        await createBenchmarkSuite({
          ...draft,
          slug: slugify(draft.slug) || slugify(draft.displayName),
          cases: draft.cases.map((item) => ({ ...item, id: slugify(item.id) })),
        });
        onSaved(`'${draft.displayName}' created. Run it to produce a first score.`);
      }
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Unable to save the suite.");
    } finally {
      setBusy(false);
    }
  };

  // Compared as they will be sent, so 'cites-runbook-' and 'cites-runbook' —
  // one of them mid-edit — are recognised as the same row in the results.
  const duplicateIds = new Set(
    draft.cases.map(({ id }) => slugify(id)).filter((id, index, all) => all.indexOf(id) !== index),
  );

  return <Drawer
    open
    kicker={suite ? `Revision ${suite.revision}` : "New suite"}
    title={suite ? suite.displayName : "Author a benchmark suite"}
    description="Each case is a question and the things its answer must — or must never — contain. Nothing here is judged by a model."
    onClose={onClose}
    footer={<div className="flex justify-end gap-2">
      <Button onClick={onClose}>Cancel</Button>
      <Button
        variant="primary"
        type="submit"
        form="benchmark-suite-form"
        disabled={busy || duplicateIds.size > 0}
      >
        {busy ? "Saving..." : suite ? "Save" : "Create suite"}
      </Button>
    </div>}
  >
    <form id="benchmark-suite-form" className="grid gap-4" onSubmit={(event) => void save(event)}>
      {error && <Alert onDismiss={() => setError(null)}>{error}</Alert>}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Display name">
          <Input
            value={draft.displayName}
            minLength={2}
            maxLength={160}
            required
            onChange={(event) => setDraft({ ...draft, displayName: event.target.value })}
          />
        </Field>
        <Field label="Slug" hint={suite ? "Fixed: past runs are filed under it." : "Used in run history and evidence references."}>
          <Input
            value={draft.slug || (suite ? "" : slugify(draft.displayName))}
            disabled={Boolean(suite)}
            onChange={(event) => setDraft({ ...draft, slug: slugAsTyped(event.target.value) })}
            onBlur={() => setDraft((current) => ({ ...current, slug: slugify(current.slug) }))}
          />
        </Field>
        <Field
          label="Exercises"
          className="sm:col-span-2"
          hint={suite
            ? "Fixed: changing it would redefine what past runs measured."
            : "The three planes fail for different reasons, so each is measured on its own."}
        >
          <Select
            value={draft.kind}
            disabled={Boolean(suite)}
            onChange={(event) => setDraft({ ...draft, kind: event.target.value as BenchmarkKind })}
          >
            {BENCHMARK_KINDS.map((kind) => <option key={kind} value={kind}>{kindLabel[kind]}</option>)}
          </Select>
        </Field>
        <Field label="Description" className="sm:col-span-2">
          <Textarea
            value={draft.description}
            minLength={3}
            maxLength={1_000}
            required
            onChange={(event) => setDraft({ ...draft, description: event.target.value })}
          />
        </Field>
        <Field
          label="Pass threshold"
          hint="Below this a run is a regression rather than a pass."
        >
          <Input
            type="number"
            min={0}
            max={1}
            step={0.01}
            value={draft.passThreshold}
            required
            onChange={(event) => setDraft({ ...draft, passThreshold: Number(event.target.value) })}
          />
        </Field>
      </div>

      <div className="flex items-center justify-between gap-3">
        <MicroLabel>Cases ({draft.cases.length})</MicroLabel>
        <Button
          size="sm"
          onClick={() => setDraft({ ...draft, cases: [...draft.cases, emptyCase(draft.cases.length)] })}
        >
          Add case
        </Button>
      </div>

      {duplicateIds.size > 0 && (
        <Alert tone="warn">
          Two cases share the id '{[...duplicateIds][0]}'. The id names a row in the results, so a reused one hides a
          regression in the second case.
        </Alert>
      )}

      <ul className="m-0 grid list-none gap-3 p-0">
        {draft.cases.map((item, caseIndex) => <li
          className="grid gap-3 rounded border border-border bg-raised p-3"
          key={caseIndex}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Case id">
              <Input
                value={item.id}
                required
                onChange={(event) => patchCase(caseIndex, { id: slugAsTyped(event.target.value) })}
                onBlur={() => patchCase(caseIndex, { id: slugify(item.id) })}
              />
            </Field>
            <div className="flex items-end justify-end">
              {draft.cases.length > 1 && <Button
                size="sm"
                variant="danger"
                onClick={() => setDraft({ ...draft, cases: draft.cases.filter((_, at) => at !== caseIndex) })}
              >
                Remove case
              </Button>}
            </div>
          </div>
          <Field label={draft.kind === "CHAT_QUALITY" ? "Question" : "Query"}>
            <Textarea
              value={item.prompt}
              minLength={3}
              maxLength={4_000}
              required
              onChange={(event) => patchCase(caseIndex, { prompt: event.target.value })}
            />
          </Field>
          <Field
            label="Why this case exists"
            hint="Shown beside the result, so a failure explains itself."
          >
            <Input
              value={item.intent}
              minLength={3}
              maxLength={400}
              required
              onChange={(event) => patchCase(caseIndex, { intent: event.target.value })}
            />
          </Field>

          <div className="flex items-center justify-between gap-3">
            <MicroLabel>Must hold</MicroLabel>
            <Button
              size="sm"
              disabled={item.assertions.length >= 20}
              onClick={() => patchCase(caseIndex, {
                assertions: [...item.assertions, { kind: "MUST_INCLUDE", value: "" }],
              })}
            >
              Add check
            </Button>
          </div>
          <ul className="m-0 grid list-none gap-2 p-0">
            {item.assertions.map((rule, index) => <li className="grid gap-2 sm:grid-cols-[minmax(0,13rem)_1fr_auto]" key={index}>
              <Select
                aria-label={`Case ${item.id} check ${index + 1} kind`}
                value={rule.kind}
                onChange={(event) => patchAssertion(caseIndex, index, {
                  kind: event.target.value as BenchmarkAssertionKind,
                })}
              >
                {BENCHMARK_ASSERTION_KINDS.map((kind) => (
                  <option key={kind} value={kind}>{assertionLabel[kind]}</option>
                ))}
              </Select>
              <Input
                aria-label={`Case ${item.id} check ${index + 1} value`}
                value={rule.value}
                required
                maxLength={400}
                placeholder={assertionHint[rule.kind]}
                {...(rule.kind === "MAX_LATENCY_MS" ? { type: "number", min: 1, step: 1 } : {})}
                onChange={(event) => patchAssertion(caseIndex, index, { value: event.target.value })}
              />
              {item.assertions.length > 1 && <Button
                size="sm"
                variant="ghost"
                aria-label={`Remove check ${index + 1} from ${item.id}`}
                onClick={() => patchCase(caseIndex, {
                  assertions: item.assertions.filter((_, on) => on !== index),
                })}
              >
                Remove
              </Button>}
            </li>)}
          </ul>
        </li>)}
      </ul>
    </form>
  </Drawer>;
}
