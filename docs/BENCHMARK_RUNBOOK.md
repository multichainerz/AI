# Benchmark Runbook

OrcaSynapse's Benchmarks workspace answers one question: *does this installation still answer as well as it did?* A suite is a set of questions and the things their answers must — or must never — contain. Running one produces the evidence an evaluation is promoted on.

Find it under **Operations → Benchmarks** (`#operations/benchmarks`). It is gated on `evaluations:read` to look and `evaluations:manage` to author, run or file: commissioning evidence and reading it are different acts, so an auditor can open every result and start none.

## What each kind measures

| Kind | Path exercised | Refuses to start when |
| --- | --- | --- |
| `CHAT_QUALITY` | queues a real `AgentRun` — the same queue, profile version, retrieval, boundary and capability checks a person's message goes through | no ACTIVE agent profile, or several without one named |
| `RETRIEVAL` | embeds the prompt and searches the document vector plane, scoring the passages themselves | no document in `READY` state |
| `MEMORY` | recalls against agent memory for the run's owner and profile, including the always-injected profile facts | no ACTIVE agent profile |

The three are separate because the planes fail independently. Retrieval degrades when an embedding model or relevance floor changes; chat when a prompt, profile or model route changes; memory when distillation or supersession misbehaves. One "is the AI good" number would hide which broke.

**A run never writes to agent memory.** Recall is measured, capture is not — the runs it queues carry `memory:agent:read` when the profile allows it and never `memory:agent:write`. A benchmark that captured facts would change the system it measures, and the second run of a suite would score differently because of the first. A `MEMORY` suite therefore tests recall of what is already stored; on a fresh installation it will score zero, and that is an honest reading rather than a fault.

## Writing a suite

Every check is a plain string or number comparison. Nothing is judged by a model, because a score an operator cannot re-derive by hand is not evidence a release is safe.

| Check | Holds when |
| --- | --- |
| `MUST_INCLUDE` | the answer contains the phrase, case-insensitively |
| `MUST_NOT_INCLUDE` | it does not — a leaked tenant name, a competitor, a refusal |
| `MUST_CITE_DOCUMENT` | a cited file name contains the value, so `runbook` matches `runbook.pdf` |
| `MAX_LATENCY_MS` | the measured latency is at or under a whole number of milliseconds |

Matching is on substrings deliberately: a suite should assert that an answer mentions the rollback step, not that it is phrased a particular way. An exact-match benchmark fails on every rewording and teaches an operator to ignore it.

`MUST_NOT_INCLUDE` earns its place. A pass rate never surfaces "must not name the other tenant" — and when one of those fails, it is recorded as a *critical* failure, which fails an evaluation gate whatever the pass rate says.

Write the **intent** of each case in plain words. It is stored beside the result, so a failure explains itself instead of leaving someone to reconstruct why the case exists a year later.

Two constraints the editor enforces before the server sees them: every case needs at least one check, because a case that asserts nothing passes by doing nothing; and no two cases may share an id, because the id names a row in the results and a reused one hides a regression in the second case entirely.

## Running

Starting a run answers `202` and queues it. Forty cases against a governed agent is minutes of inference, and holding the connection open would tie the result to a browser tab staying open.

- **One run per suite at a time.** A second against the same target asks the same questions of the same model and only makes both slower.
- **The suite revision is pinned at queue time.** Edit the cases or the pass threshold while a run waits and the run is refused rather than executed — filing new questions under the old revision number is the one thing the revision exists to prevent. Renaming a suite or fixing its description does not bump the revision and does not disturb a queued run.
- **Results are written after each case.** A suite that dies at case thirty still shows what the first twenty-nine answered.
- **Stopping keeps what was scored and produces no pass rate.** A third of a suite is not a score for the suite.
- **A worker restart mid-suite is survivable.** The run holds a five-minute lease; once it lapses the run is re-claimed and continues.

Budget roughly one case per model round-trip. On the pilot's 2.6B model that is 30–70 seconds, against a five-minute per-case ceiling, so a forty-case suite is around forty minutes and holds the benchmark slot throughout.

## Filing a result as evaluation evidence

This is the point of the feature. `EvaluationRun` gates promotion on how many cases passed — a number that was, before this, typed in from a run performed somewhere else. A benchmark measures it.

Open a completed run's results and choose **Record as evidence**. You supply only what you are deciding:

- the evaluation's name — which release this gates;
- which required category the run answers for;
- the target type, reference and version;
- the minimum pass rate.

The case counts are read off the run. There is no field for them in `attachBenchmarkEvidenceSchema`, so there is no path by which the figure a promotion rests on could be entered by hand.

The evaluation requires exactly the one category the run measured, and nothing else. Filing a chat benchmark as evidence about tool use or permissions would make a gate look stronger while being weaker; a narrow claim is the one that can be honoured. Run several suites and file each against its own gate.

Only a completed run can be filed, and only once. A run that was stopped, refused or is still going has measured part of a suite, and part of a suite is not evidence about the suite.

## Reading a result

A completed run below its suite's threshold reads **below threshold**, not "completed" — the second is true and tells an operator nothing. The summary counts those as regressions.

Every run records what it was pointed at: agent profile and version, model alias, and whose corpus. The same suite scoring 0.94 then 0.71 says nothing until you know what changed underneath, and those fields are copies rather than references so a historical run keeps reading true after the profile it used is edited or deleted.

Deleting a suite removes its run history. A suite whose result an evaluation cites is kept, and so is one with a run still going.

## Acceptance

Before trusting a suite as a release gate, confirm:

- it fails when it should — break one expected answer deliberately and watch the case go red;
- its `MUST_NOT_INCLUDE` checks name things that would actually be leaked, not things no model would say;
- its threshold reflects a real decision, not the default;
- a `RETRIEVAL` suite runs against the corpus it was written for, since retrieval is owner-scoped and the run records whose;
- the median latency is representative — it is a median rather than a mean precisely so one cold start does not redefine "typical".
