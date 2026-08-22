import { AGENT_RUN_EVENT_TYPES } from "@orcasynapse/contracts";
import { createHash } from "node:crypto";
import type { DrizzleRuntimeConnectionResolver, RuntimeConnection } from "./connection-resolver.js";

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
/**
 * Ceiling for a *single* SSE event, in characters.
 *
 * Characters, not bytes, because that is the unit every other bound in this
 * file uses: `safeDelta` keeps 64,000 characters and `safeEventText` keeps
 * 1,000. A byte-denominated guard rejected roughly 22k CJK characters — well
 * inside what `safeDelta` would have kept — for being three bytes each.
 *
 * The value has to clear the largest event this client will actually accept:
 * a 64,000-character delta, JSON-escaped, which a server that escapes
 * non-ASCII can inflate sixfold. It is a bound on how much unparsed text may
 * accumulate before this client gives up on resynchronising, not a policy on
 * what Hermes may send.
 */
const MAX_SSE_EVENT_CHARACTERS = 512 * 1024;

/*
 * How much of an answer may pool before it is handed over.
 *
 * Each flush becomes one AgentRunEvent row and one cursor, so this pair sets
 * both how smooth the answer looks and how much the database is asked to do. At
 * 1,024 characters a reader received the answer in kilobyte lumps about ten
 * times a second, which reads as jumpy however fast delivery is. These values
 * are only affordable because a subscriber is now woken when the row commits
 * rather than finding it on its next poll (v1.9.0).
 *
 * The interval is a THRESHOLD, not a latency guarantee: it is evaluated only
 * when a new delta arrives. If Hermes goes quiet mid-buffer nothing flushes
 * until the next delta, the next non-delta event, or the end of the stream --
 * exactly as before. The character bound is the one that binds on a fast
 * producer, so it is both the dial to turn if the write rate proves too
 * expensive and the one the test pins; the interval is deliberately not
 * asserted, because a test that drives the clock past it would be asserting the
 * clock rather than this.
 */
const DELTA_FLUSH_CHARACTERS = 256;
const DELTA_FLUSH_INTERVAL_MS = 40;

/**
 * Derived from the contract rather than restated.
 *
 * This was a hand-maintained union listing the same ten names as
 * `AGENT_RUN_EVENT_TYPES`, which is two sources of truth for one vocabulary
 * and the reason adding an event type here failed to reach the dashboard.
 * Deriving it means a type the contract does not admit cannot be written to
 * the run ledger, and a type added to the contract is available here without
 * anyone remembering to copy it.
 */
export type HermesSafeRunEventType = (typeof AGENT_RUN_EVENT_TYPES)[number];

export interface HermesSafeRunEvent {
  sourceEventId: string | null;
  type: HermesSafeRunEventType;
  delta: string | null;
  preview: string | null;
  errorCode: string | null;
  summary: string | null;
  status: string | null;
  toolName: string | null;
  /*
   * The runtime's own identifier for a tool call, when it offers one. Most
   * Hermes surfaces do not: `tool.progress` carries the tool's name and nothing
   * that ties it to the start it belongs to. Null here means "not reported",
   * and the worker synthesises a key rather than the client inventing one,
   * because correlation has to survive a reconnect that resets this client.
   */
  toolCallKey: string | null;
  /*
   * The event's own prose where it runs longer than a summary line -- reasoning
   * text, a tool's returned output. Capped, because a tool that returns a file
   * should not be able to write that file into the run's history.
   */
  text: string | null;
  childSessionId: string | null;
  durationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  costUsd: number | null;
  approvalExternalId: string | null;
  approvalCommand: string | null;
  approvalChoices: Array<"ALLOW_ONCE" | "DENY">;
  occurredAt: Date;
}

/**
 * Hermes wire names to the vocabulary this control plane stores.
 *
 * Hermes-native session streams have used both prefixed and unprefixed event
 * names, so both spellings are listed rather than one being assumed canonical.
 * Anything absent from this map is dropped at the projection boundary.
 *
 * - `tool.failed` had no entry at all. A tool that failed produced a start with
 *   no completion, which reads to an operator exactly like a tool still
 *   running: the run appeared to hang rather than to have failed.
 * - `tool.progress` was mapped onto `TOOL_STARTED`, so a single tool call
 *   emitted N "started" rows against one completion. That is why a tool call
 *   could never be rendered as one object with a lifecycle.
 * - `reasoning.available` was dropped. See `AGENT_RUN_EVENT_TYPES` for why the
 *   destination is named `REASONING_REPORTED` and not `THINKING`.
 */
/*
 * Exported for one assertion: that nothing here maps to the marker the control
 * plane writes to end a run's event log. A subscriber stops on that marker, so
 * a runtime able to produce one could end a turn while the answer is still
 * unstored. The test is in this package because contracts cannot see this map.
 */
export const SAFE_EVENT_TYPES = new Map<string, HermesSafeRunEventType>([
  ["run.start", "RUN_STARTED"],
  ["run.started", "RUN_STARTED"],
  ["message.delta", "MESSAGE_DELTA"],
  ["assistant.delta", "MESSAGE_DELTA"],
  ["tool.start", "TOOL_STARTED"],
  ["tool.started", "TOOL_STARTED"],
  ["tool.progress", "TOOL_PROGRESS"],
  ["hermes.tool.progress", "TOOL_PROGRESS"],
  ["tool.complete", "TOOL_COMPLETED"],
  ["tool.completed", "TOOL_COMPLETED"],
  ["tool.failed", "TOOL_FAILED"],
  ["tool.error", "TOOL_FAILED"],
  ["reasoning.available", "REASONING_REPORTED"],
  ["subagent.start", "SUBAGENT_STARTED"],
  ["subagent.complete", "SUBAGENT_COMPLETED"],
  ["approval.required", "APPROVAL_REQUIRED"],
  ["run.approval_required", "APPROVAL_REQUIRED"],
  ["approval.request", "APPROVAL_REQUIRED"],
  ["run.complete", "RUN_COMPLETED"],
  ["run.completed", "RUN_COMPLETED"],
  ["run.failed", "RUN_FAILED"],
  ["error", "RUN_FAILED"],
  ["run.cancelled", "RUN_CANCELLED"],
]);

function safeEventText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const sanitized = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return sanitized ? sanitized.slice(0, maximum) : null;
}

function safeDelta(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const sanitized = value.replace(/[\u0000\u000b\u000c\u000e-\u001f\u007f]/g, "");
  return sanitized.length === 0 ? null : sanitized.slice(0, 64_000);
}

function safeNonnegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function safeNonnegativeInteger(value: unknown): number | null {
  const number = safeNonnegativeNumber(value);
  return number === null ? null : Math.floor(number);
}

/**
 * Token counts, or nulls when the runtime did not actually measure them.
 *
 * Hermes reports `usage: {input_tokens: 0, output_tokens: 0, total_tokens: 0}`
 * for providers that do not return usage — llama.cpp behind an OpenAI-compatible
 * gateway among them — even for a run that plainly produced output. Recording
 * those as measured zeroes tells an operator the run was free, which is a
 * stronger and more misleading claim than admitting the runtime stayed silent.
 *
 * A completed run always consumes input tokens, because instructions are never
 * empty. So an all-zero block against real output means "not reported", and the
 * dashboard already renders null as an em dash.
 */
function reportedUsage(
  value: Record<string, unknown>,
  usage: Record<string, unknown>,
  output: string | null,
): Pick<HermesRunState, "inputTokens" | "outputTokens" | "reasoningTokens" | "totalTokens"> {
  const counts = {
    inputTokens: safeNonnegativeInteger(value.input_tokens ?? usage.input_tokens),
    outputTokens: safeNonnegativeInteger(value.output_tokens ?? usage.output_tokens),
    reasoningTokens: safeNonnegativeInteger(value.reasoning_tokens ?? usage.reasoning_tokens),
    totalTokens: safeNonnegativeInteger(value.total_tokens ?? usage.total_tokens),
  };
  const silent = Object.values(counts).every((count) => count === null || count === 0);
  if (silent && output !== null && output.length > 0) {
    return { inputTokens: null, outputTokens: null, reasoningTokens: null, totalTokens: null };
  }
  return counts;
}

function safeApprovalChoices(value: unknown): Array<"ALLOW_ONCE" | "DENY"> {
  if (!Array.isArray(value)) return ["ALLOW_ONCE", "DENY"];
  const normalized = new Set(value.flatMap((choice) => {
    if (typeof choice !== "string") return [];
    const name = choice.trim().toLowerCase();
    if (name === "once" || name === "allow_once" || name === "approve") return ["ALLOW_ONCE" as const];
    if (name === "deny" || name === "denied") return ["DENY" as const];
    return [];
  }));
  if (!normalized.has("DENY")) normalized.add("DENY");
  return [...normalized];
}

/*
 * The events whose payload carries prose worth keeping beyond a summary line.
 *
 * `RUN_COMPLETED` is absent on purpose: its `output` is the finished answer,
 * which the message already stores, and copying it here would have the
 * transcript hold the same text twice and the timeline able to show it as
 * though it were a separate step.
 */
const TEXT_BEARING = new Set<HermesSafeRunEventType>(["REASONING_REPORTED", "TOOL_COMPLETED", "TOOL_FAILED"]);

function safeRunEvent(eventName: string, sourceEventId: string | null, data: unknown): HermesSafeRunEvent | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const value = data as Record<string, unknown>;
  const dataEvent = typeof value.event === "string" ? value.event : eventName;
  const type = SAFE_EVENT_TYPES.get(dataEvent.toLowerCase());
  if (!type) return null;
  const usage = value.usage && typeof value.usage === "object" && !Array.isArray(value.usage)
    ? value.usage as Record<string, unknown>
    : {};
  const rawTime = value.timestamp ?? value.occurred_at ?? value.ts;
  const parsedTime = typeof rawTime === "number"
    ? new Date(rawTime > 10_000_000_000 ? rawTime : rawTime * 1_000)
    : typeof rawTime === "string" ? new Date(rawTime) : new Date();
  const durationMs = safeNonnegativeInteger(value.duration_ms) ?? (() => {
    const seconds = safeNonnegativeNumber(value.duration ?? value.duration_seconds);
    return seconds === null ? null : Math.round(seconds * 1_000);
  })();
  // `run.completed` carries the same zeroed usage block as the run state, and it
  // is the only event that also carries output — so it is the only one where
  // zeroes can be read as silence rather than as a measurement.
  const tokens = reportedUsage(value, usage, typeof value.output === "string" ? value.output : null);
  const toolName = safeEventText(value.tool ?? value.tool_name ?? value.name, 160);
  const nativeMemoryEvent = toolName?.toLowerCase() === "memory";
  return {
    sourceEventId: safeEventText(sourceEventId ?? value.event_id ?? value.id, 255),
    type,
    delta: type === "MESSAGE_DELTA" ? safeDelta(value.delta) : null,
    // Hermes' memory tool can include the fact it wrote in preview/result
    // fields. The control plane records that native memory activity happened,
    // never the content, so the audit projection cannot become a mirror.
    preview: nativeMemoryEvent ? null : safeEventText(value.preview, 1_000),
    errorCode: safeEventText(value.error_code ?? value.code, 80),
    summary: nativeMemoryEvent
      ? "Hermes native memory activity."
      : safeEventText(value.summary ?? value.preview ?? value.goal ?? value.task ?? value.message ?? value.error, 1_000),
    status: safeEventText(value.status, 80),
    toolName,
    // Deliberately not falling back to `value.id`: on a tool event that is the
    // event's identifier, already claimed above as sourceEventId, and reusing
    // it would give every event in one call a different "call" key -- the exact
    // failure this column exists to end.
    toolCallKey: safeEventText(value.tool_call_id ?? value.call_id ?? value.invocation_id, 200),
    text: !nativeMemoryEvent && TEXT_BEARING.has(type)
      ? safeEventText(value.reasoning ?? value.reasoning_content ?? value.result ?? value.text, 20_000)
      : null,
    childSessionId: safeEventText(value.child_session_id ?? value.subagent_id ?? value.task_id, 255),
    durationMs,
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    reasoningTokens: tokens.reasoningTokens,
    costUsd: safeNonnegativeNumber(value.cost_usd ?? usage.cost_usd),
    approvalExternalId: type === "APPROVAL_REQUIRED"
      ? safeEventText(value.approval_id ?? value.request_id ?? value.id, 255)
      : null,
    approvalCommand: type === "APPROVAL_REQUIRED" ? safeEventText(value.command, 1_000) : null,
    approvalChoices: type === "APPROVAL_REQUIRED" ? safeApprovalChoices(value.choices) : [],
    occurredAt: Number.isNaN(parsedTime.getTime()) ? new Date() : parsedTime,
  };
}

function stringSetting(connection: RuntimeConnection, name: string, fallback: string): string {
  const value = connection.configuration[name];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function numberSetting(connection: RuntimeConnection, name: string, fallback: number): number {
  const value = connection.configuration[name];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function endpoint(connection: RuntimeConnection, path: string): URL {
  const base = new URL(connection.baseUrl);
  const url = new URL(path, `${connection.baseUrl.replace(/\/+$/, "")}/`);
  if (url.origin !== base.origin) throw new Error("Hermes request paths must remain on the configured origin.");
  return url;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("Hermes response is too large.");
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Hermes response is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (size === 0) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error("Hermes returned invalid JSON.");
  }
}

export interface SessionInboxUpload {
  fileName: string;
  bytes: Uint8Array;
}

/** Same host as Hermes, port 8643 — the node inbox that writes `artifacts/<session>/inbox/`. */
export function hermesInboxOrigin(baseUrl: string, configuration: Record<string, unknown> = {}): URL {
  const override = configuration.inboxUrl;
  if (typeof override === "string" && override.trim()) return new URL(override.trim());
  const url = new URL(baseUrl);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  url.port = "8643";
  return url;
}

export interface HermesRunSubmission {
  input: string;
  instructions: string;
  sessionId: string;
  idempotencyKey: string;
  modelAlias: string;
  /** Toolsets an operator has admitted. Anything else enabled fails the run. */
  admittedToolsets?: readonly string[];
}

export interface HermesRunState {
  id: string;
  status: string;
  output: string | null;
  error: string | null;
  modelAlias: string | null;
  sessionId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  finishReason: string | null;
}

interface NativeSessionRun {
  id: string;
  state: HermesRunState;
  events: HermesSafeRunEvent[];
  controller: AbortController;
  version: number;
  waiters: Set<() => void>;
  cleanupTimer?: NodeJS.Timeout;
}

const NATIVE_RUN_PREFIX = "hermes-native-";

export function nativeRunId(idempotencyKey: string): string {
  return `${NATIVE_RUN_PREFIX}${createHash("sha256").update(idempotencyKey).digest("hex")}`;
}

function isTerminalStatus(status: string): boolean {
  return ["completed", "failed", "cancelled", "canceled"].includes(status.toLowerCase());
}

/**
 * A native session turn this process did not start, and cannot pick up.
 *
 * Hermes' native session surface delivers a turn exactly once: as the SSE body
 * of the POST to `/api/sessions/:id/chat/stream` that carried the message, to
 * the process that issued that POST. The id in `nativeRunId` is derived here
 * from the idempotency key and is never sent to the runtime, so there is
 * nothing on Hermes keyed by it to ask about and no half-finished response to
 * resume; re-issuing the POST would submit the same message to the session a
 * second time, which is exactly what persisting `externalRunId` exists to
 * prevent. The Runs API the capability gate requires is a different surface
 * that `start` deliberately does not submit through -- attaching through it
 * would mean giving up native sessions, and with them Hermes owning the
 * transcript and its MEMORY.md / USER.md lifecycle.
 *
 * So this is not a retryable condition, and callers are told which absence it
 * is rather than being left to guess. It matters because the two have opposite
 * consequences: an id this client never issued is a programming error, while a
 * detached run means Hermes holds an exchange the reader's transcript does not,
 * and every later answer in that conversation is informed by it.
 */
export class HermesRunDetachedError extends Error {
  constructor(readonly runId: string) {
    super(
      "The Hermes native session run was started by a worker process that is gone. "
      + "Hermes still holds that exchange in its session transcript; it cannot be re-attached or resumed.",
    );
    this.name = "HermesRunDetachedError";
  }
}

/**
 * Which of the two absences a missing run is.
 *
 * Both answers used to be the same sentence, which told a worker holding a
 * perfectly good id that its run had detached and a worker holding a detached
 * run nothing it could act on differently.
 */
function absentRun(runId: string): Error {
  return runId.startsWith(NATIVE_RUN_PREFIX)
    ? new HermesRunDetachedError(runId)
    : new Error("Hermes was asked about a run id this client never issued.");
}

export class HermesClient {
  private readonly nativeRuns = new Map<string, NativeSessionRun>();

  constructor(
    private readonly resolver: DrizzleRuntimeConnectionResolver,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  /**
   * Fork the persisted Hermes transcript into a caller-selected session ID.
   *
   * OrcaSynapse keeps only its operational chat projection; this native API is
   * therefore the only valid way to preserve conversational state across a
   * fork. A missing source is reported explicitly so callers never present a
   * copied Orca transcript as though Hermes had inherited it.
   */
  async forkSession(sourceSessionId: string, targetSessionId: string): Promise<"forked" | "source_absent"> {
    const connection = await this.resolver.resolveOne("HERMES");
    const sessionsPath = stringSetting(connection, "sessionsPath", "/api/sessions").replace(/\/+$/, "");
    const response = await this.nativeSessionJson(
      connection,
      endpoint(connection, `${sessionsPath}/${encodeURIComponent(sourceSessionId)}/fork`),
      { method: "POST", body: JSON.stringify({ id: targetSessionId }) },
      [404],
    );
    return response.status === 404 ? "source_absent" : "forked";
  }

  /** Ensure Hermes removes the native transcript; an already-absent session is success. */
  async deleteSession(sessionId: string): Promise<void> {
    const connection = await this.resolver.resolveOne("HERMES");
    const sessionsPath = stringSetting(connection, "sessionsPath", "/api/sessions").replace(/\/+$/, "");
    await this.nativeSessionJson(
      connection,
      endpoint(connection, `${sessionsPath}/${encodeURIComponent(sessionId)}`),
      { method: "DELETE" },
      [404],
    );
  }

  async assertAdmittedToolBoundary(admitted: Iterable<string> = []): Promise<void> {
    const connection = await this.resolver.resolveOne("HERMES");
    await this.assertAdmittedToolBoundaryFor(connection, admitted);
  }

  /**
   * Refuse the run unless every enabled toolset has been admitted by an operator.
   *
   * Hermes executes its own tools server-side, so OrcaSynapse cannot inspect or
   * scope an individual call the way it does its own governed tools. Admission
   * is the only boundary available, which makes drift the thing to fail on: a
   * toolset enabled on the runtime that nobody admitted means the runtime is no
   * longer the one this installation approved, and that is not a run to submit.
   *
   * With nothing admitted this is the tightest boundary available, which is
   * Hermes' built-in `memory` and nothing else. It used to be described here as
   * "exactly the zero-tool boundary it replaces", and that was never true: the
   * built-in grant below is unconditional, so an installation admitting nothing
   * still permits one toolset. The refusal carried the same mistake in a
   * sentence guarded by `permitted.size === 0` -- a size that cannot be zero --
   * so a message about requiring a zero-tool boundary sat in the source for
   * several releases having never reached anybody. Both are corrected rather
   * than made reachable: making them true would mean withdrawing the built-in
   * memory grant, which is a deliberate capability and not an oversight. Pinned
   * by "admits Hermes' built-in memory toolset without an operator admitting
   * it" in hermes-client.test.ts.
   */
  private async assertAdmittedToolBoundaryFor(
    connection: RuntimeConnection,
    admitted: Iterable<string>,
  ): Promise<void> {
    const { toolsets } = await this.assertBaseBoundary(connection);
    const permitted = new Set(admitted);
    // The built-in memory tool is the one intentional native capability in
    // Hermes-session mode. It writes only Hermes-owned MEMORY.md / USER.md;
    // OrcaSynapse neither receives nor mirrors that content.
    permitted.add("memory");
    const unadmitted = toolsets
      .filter((toolset) => toolset.enabled && !permitted.has(toolset.name))
      .map((toolset) => toolset.name);
    if (unadmitted.length === 0) return;
    throw new Error(
      `Hermes has enabled toolsets this installation has not admitted: ${unadmitted.slice(0, 5).join(", ")}.`,
    );
  }

  private async assertBaseBoundary(connection: RuntimeConnection): Promise<{
    capabilities: Record<string, unknown>;
    toolsets: Array<{ name: string; enabled: boolean }>;
  }> {
    const capabilitiesPath = stringSetting(connection, "capabilitiesPath", "/v1/capabilities");
    const capabilities = await this.request(connection, endpoint(connection, capabilitiesPath), { method: "GET" });
    if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
      throw new Error("Hermes capability discovery returned an invalid response.");
    }
    const value = capabilities as Record<string, unknown>;
    const auth = value.auth && typeof value.auth === "object" ? value.auth as Record<string, unknown> : {};
    const features = value.features && typeof value.features === "object" ? value.features as Record<string, unknown> : {};
    const runtime = value.runtime && typeof value.runtime === "object" ? value.runtime as Record<string, unknown> : {};
    if (
      value.platform !== "hermes-agent" || auth.required !== true ||
      features.run_submission !== true || features.run_status !== true || features.run_events_sse !== true || features.run_stop !== true
    ) {
      throw new Error("Hermes does not expose the required authenticated Runs API boundary.");
    }
    if (
      Object.keys(runtime).length > 0 &&
      (runtime.mode !== "server_agent" || runtime.tool_execution !== "server" || runtime.split_runtime !== false)
    ) {
      throw new Error("Hermes reports an incompatible runtime execution boundary.");
    }

    const toolsetsPath = stringSetting(connection, "toolsetsPath", "/v1/toolsets");
    const toolsetResponse = await this.request(connection, endpoint(connection, toolsetsPath), { method: "GET" });
    const toolsetValues = Array.isArray(toolsetResponse)
      ? toolsetResponse
      : toolsetResponse && typeof toolsetResponse === "object" && !Array.isArray(toolsetResponse) &&
          (toolsetResponse as Record<string, unknown>).platform === "api_server" &&
          Array.isArray((toolsetResponse as Record<string, unknown>).data)
        ? (toolsetResponse as { data: unknown[] }).data
        : null;
    if (!toolsetValues) throw new Error("Hermes toolset discovery returned an invalid API-server response.");
    const toolsets = toolsetValues.map((toolset) => {
      if (
        !toolset || typeof toolset !== "object" || Array.isArray(toolset) ||
        typeof (toolset as { name?: unknown }).name !== "string" ||
        typeof (toolset as { enabled?: unknown }).enabled !== "boolean"
      ) {
        throw new Error("Hermes toolset discovery contained an unrecognized entry; OrcaSynapse denies execution fail-closed.");
      }
      return toolset as { name: string; enabled: boolean };
    });
    return { capabilities: value, toolsets };
  }

  /**
   * What the runtime reports it can do: toolsets and skills.
   *
   * Discovery only, and deliberately lenient — an unrecognised entry is skipped
   * rather than thrown on. `assertBaseBoundary` is the fail-closed gate that
   * decides whether a run may proceed; this one only describes, so refusing to
   * render a catalogue because one skill lacked a description would be the
   * wrong trade.
   */
  async catalogue(): Promise<{
    toolsets: Array<{ name: string; label: string | null; enabled: boolean; toolCount: number }>;
    skills: Array<{ name: string; description: string | null; category: string | null }>;
  }> {
    const connection = await this.resolver.resolveOne("HERMES");
    const { toolsets } = await this.assertBaseBoundary(connection);

    const detailed = toolsets.map((toolset) => {
      const record = toolset as unknown as Record<string, unknown>;
      const tools = Array.isArray(record.tools) ? record.tools : [];
      return {
        name: toolset.name,
        label: typeof record.label === "string" ? record.label : null,
        enabled: toolset.enabled,
        toolCount: tools.length,
      };
    });

    let skills: Array<{ name: string; description: string | null; category: string | null }> = [];
    try {
      const path = stringSetting(connection, "skillsPath", "/v1/skills");
      const response = await this.request(connection, endpoint(connection, path), { method: "GET" });
      const values = response && typeof response === "object" && Array.isArray((response as { data?: unknown }).data)
        ? (response as { data: unknown[] }).data
        : [];
      skills = values.flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const record = value as Record<string, unknown>;
        if (typeof record.name !== "string") return [];
        return [{
          name: record.name,
          description: typeof record.description === "string" ? record.description : null,
          category: typeof record.category === "string" ? record.category : null,
        }];
      });
    } catch {
      // A runtime without /v1/skills is still usable; the panel simply shows none.
      skills = [];
    }

    return { toolsets: detailed, skills };
  }

  async start(input: HermesRunSubmission): Promise<string> {
    const connection = await this.resolver.resolveOne("HERMES");
    await this.assertAdmittedToolBoundaryFor(connection, input.admittedToolsets ?? []);
    return this.startNativeSession(connection, input);
  }

  /**
   * Place control-plane uploads on the node under `artifacts/<session>/inbox/`
   * so Hermes native file tools can read and edit them. Same bearer as Hermes.
   */
  async materializeSessionInbox(sessionId: string, files: readonly SessionInboxUpload[]): Promise<void> {
    if (files.length === 0) return;
    const connection = await this.resolver.resolveOne("HERMES");
    const origin = hermesInboxOrigin(connection.baseUrl, connection.configuration as Record<string, unknown>);
    for (const file of files) {
      const url = new URL(
        `v1/session-uploads/${encodeURIComponent(sessionId)}/${encodeURIComponent(file.fileName)}`,
        origin,
      );
      const response = await this.fetcher(url, {
        method: "PUT",
        redirect: "error",
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(file.bytes.byteLength),
          ...(connection.secrets.apiKey ? { authorization: `Bearer ${connection.secrets.apiKey}` } : {}),
        },
        body: Buffer.from(file.bytes),
      });
      if (!response.ok) {
        throw new Error(`Session inbox refused ${file.fileName} with status ${response.status}.`);
      }
    }
  }

  /**
   * Start one turn through Hermes' native session surface.
   *
   * The stream is owned by this worker rather than by the browser. Hermes can
   * therefore persist the transcript in its own state database and apply its
   * built-in MEMORY.md / USER.md lifecycle, while OrcaSynapse consumes only a
   * bounded operational projection for the run ledger. Conversation history
   * is intentionally absent from the request: Hermes is the source of truth.
   */
  private async startNativeSession(connection: RuntimeConnection, input: HermesRunSubmission): Promise<string> {
    const id = nativeRunId(input.idempotencyKey);
    if (this.nativeRuns.has(id)) return id;
    await this.ensureNativeSession(connection, input.sessionId, input.modelAlias);
    const run: NativeSessionRun = {
      id,
      state: {
        id,
        status: "queued",
        output: null,
        error: null,
        modelAlias: input.modelAlias,
        sessionId: input.sessionId,
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        totalTokens: null,
        finishReason: null,
      },
      events: [],
      controller: new AbortController(),
      version: 0,
      waiters: new Set(),
    };
    this.nativeRuns.set(id, run);
    void this.consumeNativeSession(connection, input, run).catch((error: unknown) => {
      if (isTerminalStatus(run.state.status)) return;
      const message = error instanceof Error ? error.message : "Hermes native session execution failed.";
      run.state = { ...run.state, status: "failed", error: message.slice(0, 500), finishReason: "error" };
      this.appendNativeEvent(run, {
        sourceEventId: `${id}:client-failed`,
        type: "RUN_FAILED",
        delta: null,
        preview: null,
        errorCode: "HERMES_NATIVE_SESSION_FAILED",
        summary: message.slice(0, 1_000),
        status: "failed",
        toolName: null,
        toolCallKey: null,
        text: null,
        childSessionId: null,
        durationMs: null,
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        costUsd: null,
        approvalExternalId: null,
        approvalCommand: null,
        approvalChoices: [],
        occurredAt: new Date(),
      });
    });
    return id;
  }

  private async ensureNativeSession(
    connection: RuntimeConnection,
    sessionId: string,
    modelAlias: string,
  ): Promise<void> {
    const sessionsPath = stringSetting(connection, "sessionsPath", "/api/sessions").replace(/\/+$/, "");
    const sessionUrl = endpoint(connection, `${sessionsPath}/${encodeURIComponent(sessionId)}`);
    const existing = await this.nativeSessionJson(connection, sessionUrl, { method: "GET" }, [404]);
    if (existing.status !== 404) return;
    const created = await this.nativeSessionJson(connection, endpoint(connection, sessionsPath), {
      method: "POST",
      body: JSON.stringify({
        id: sessionId,
        model: modelAlias,
        source: "api_server",
      }),
    }, [409]);
    if (created.status !== 409 && created.status !== 201 && created.status !== 200) {
      throw new Error(`Hermes rejected native session creation with status ${created.status}.`);
    }
  }

  private async nativeSessionJson(
    connection: RuntimeConnection,
    url: URL,
    init: RequestInit,
    permittedStatuses: number[] = [],
  ): Promise<{ status: number; body: unknown }> {
    const timeoutMs = Math.min(30_000, Math.max(1_000, numberSetting(connection, "timeoutMs", 8_000)));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetcher(url, {
        ...init,
        redirect: "error",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...(connection.secrets.apiKey ? { authorization: `Bearer ${connection.secrets.apiKey}` } : {}),
          ...init.headers,
        },
      });
      const body = await boundedJson(response);
      if (!response.ok && !permittedStatuses.includes(response.status)) {
        const detail = body && typeof body === "object" && !Array.isArray(body)
          ? safeEventText((body as Record<string, unknown>).message ?? (body as Record<string, unknown>).error, 300)
          : null;
        throw new Error(`Hermes rejected the request with status ${response.status}${detail ? `: ${detail}` : ""}.`);
      }
      return { status: response.status, body };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async consumeNativeSession(
    connection: RuntimeConnection,
    input: HermesRunSubmission,
    run: NativeSessionRun,
  ): Promise<void> {
    let authoritativeOutputSeen = false;
    const sessionsPath = stringSetting(connection, "sessionsPath", "/api/sessions").replace(/\/+$/, "");
    const response = await this.fetcher(
      endpoint(connection, `${sessionsPath}/${encodeURIComponent(input.sessionId)}/chat/stream`),
      {
        method: "POST",
        redirect: "error",
        signal: run.controller.signal,
        headers: {
          accept: "text/event-stream",
          "content-type": "application/json",
          ...(connection.secrets.apiKey ? { authorization: `Bearer ${connection.secrets.apiKey}` } : {}),
        },
        body: JSON.stringify({
          message: input.input,
          instructions: input.instructions,
          model: input.modelAlias,
        }),
      },
    );
    if (!response.ok) throw new Error(`Hermes rejected the native session stream with status ${response.status}.`);
    if (!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
      throw new Error("Hermes returned an invalid native session stream content type.");
    }
    await this.consumeSafeEventStream(response, async (event) => {
      if (event.type === "RUN_STARTED") {
        run.state = { ...run.state, status: "running" };
      } else if (event.type === "MESSAGE_DELTA" && event.delta && !authoritativeOutputSeen) {
        run.state = {
          ...run.state,
          output: `${run.state.output ?? ""}${event.delta}`.slice(0, 2_000_000),
        };
      } else if (event.type === "RUN_COMPLETED") {
        run.state = {
          ...run.state,
          status: "completed",
          error: null,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          reasoningTokens: event.reasoningTokens,
          totalTokens: event.inputTokens !== null && event.outputTokens !== null
            ? event.inputTokens + event.outputTokens + (event.reasoningTokens ?? 0)
            : null,
          finishReason: "stop",
        };
      } else if (event.type === "RUN_FAILED") {
        run.state = {
          ...run.state,
          status: "failed",
          error: event.summary ?? event.errorCode ?? "Hermes native session failed.",
          finishReason: "error",
        };
      } else if (event.type === "RUN_CANCELLED") {
        run.state = { ...run.state, status: "cancelled", finishReason: "cancelled" };
      }
      this.appendNativeEvent(run, event);
    }, (eventName, data) => {
      if (eventName.toLowerCase() !== "assistant.completed" || !data || typeof data !== "object" || Array.isArray(data)) {
        return;
      }
      const content = (data as Record<string, unknown>).content;
      if (typeof content === "string") {
        authoritativeOutputSeen = true;
        run.state = { ...run.state, output: content.slice(0, 2_000_000) };
      }
    });
    if (!isTerminalStatus(run.state.status)) {
      throw new Error("Hermes native session stream ended without a terminal event.");
    }
  }

  private appendNativeEvent(run: NativeSessionRun, event: HermesSafeRunEvent): void {
    run.events.push(event);
    run.version += 1;
    const waiters = [...run.waiters];
    run.waiters.clear();
    for (const waiter of waiters) waiter();
    if (isTerminalStatus(run.state.status) && !run.cleanupTimer) {
      run.cleanupTimer = setTimeout(() => {
        if (this.nativeRuns.get(run.id) === run) this.nativeRuns.delete(run.id);
      }, 15 * 60_000);
      run.cleanupTimer.unref();
    }
  }

  async status(runId: string): Promise<HermesRunState> {
    const native = this.nativeRuns.get(runId);
    if (native) return { ...native.state };
    throw absentRun(runId);
  }

  async decideApproval(runId: string, choice: "once" | "deny"): Promise<void> {
    void runId;
    void choice;
    throw new Error("Hermes native sessions do not expose the governed approval protocol.");
  }

  async stop(runId: string): Promise<void> {
    const native = this.nativeRuns.get(runId);
    if (native) {
      if (!isTerminalStatus(native.state.status)) {
        native.state = { ...native.state, status: "cancelled", finishReason: "cancelled" };
        native.controller.abort();
        this.appendNativeEvent(native, {
          sourceEventId: `${runId}:client-cancelled`,
          type: "RUN_CANCELLED",
          delta: null,
          preview: null,
          errorCode: null,
          summary: "Run cancelled by OrcaSynapse.",
          status: "cancelled",
          toolName: null,
          toolCallKey: null,
          text: null,
          childSessionId: null,
          durationMs: null,
          inputTokens: null,
          outputTokens: null,
          reasoningTokens: null,
          costUsd: null,
          approvalExternalId: null,
          approvalCommand: null,
          approvalChoices: [],
          occurredAt: new Date(),
        });
      }
      return;
    }
    /*
     * A detached run is not stopped, and saying so would not help.
     *
     * The abort above works on this process' own stream; a turn owned by a
     * process that is gone has no handle here and no endpoint keyed by this id.
     * Every caller stops best-effort and then finalises regardless -- see the
     * cancel paths in the worker's agent-processor -- so raising here would be
     * swallowed at every site while inviting a future caller to treat a stop
     * that was never possible as a failure worth reporting to a user.
     */
  }

  async events(
    runId: string,
    onEvent: (event: HermesSafeRunEvent) => Promise<void> | void,
    signal: AbortSignal,
    lastEventId?: string,
  ): Promise<void> {
    const native = this.nativeRuns.get(runId);
    if (native) {
      await this.consumeNativeEvents(native, onEvent, signal, lastEventId);
      return;
    }
    throw absentRun(runId);
  }

  private async consumeNativeEvents(
    run: NativeSessionRun,
    onEvent: (event: HermesSafeRunEvent) => Promise<void> | void,
    signal: AbortSignal,
    lastEventId?: string,
  ): Promise<void> {
    let cursor = 0;
    if (lastEventId) {
      const index = run.events.findIndex((event) => event.sourceEventId === lastEventId);
      if (index >= 0) cursor = index + 1;
    }
    while (!signal.aborted) {
      while (cursor < run.events.length) {
        await onEvent(run.events[cursor]!);
        cursor += 1;
      }
      if (isTerminalStatus(run.state.status)) return;
      const version = run.version;
      await new Promise<void>((resolve) => {
        const wake = () => {
          signal.removeEventListener("abort", wake);
          run.waiters.delete(wake);
          resolve();
        };
        run.waiters.add(wake);
        signal.addEventListener("abort", wake, { once: true });
        if (run.version !== version || isTerminalStatus(run.state.status)) wake();
      });
    }
  }

  private async consumeSafeEventStream(
    response: Response,
    onEvent: (event: HermesSafeRunEvent) => Promise<void> | void,
    onRawEvent?: (eventName: string, data: unknown) => Promise<void> | void,
  ): Promise<void> {
    if (!response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")) {
      throw new Error("Hermes returned an invalid run event stream content type.");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Hermes returned an empty run event stream.");
    const decoder = new TextDecoder();
    let buffer = "";
    let pendingDelta = "";
    let pendingDeltaEvent: HermesSafeRunEvent | null = null;
    let lastDeltaFlushAt = Date.now();
    const flushDelta = async () => {
      if (!pendingDeltaEvent || pendingDelta.length === 0) return;
      await onEvent({ ...pendingDeltaEvent, delta: pendingDelta });
      pendingDelta = "";
      pendingDeltaEvent = null;
      lastDeltaFlushAt = Date.now();
    };
    // Set while the tail of an event this client already gave up on is still
    // arriving, so its remainder is dropped rather than parsed as a new event.
    let resynchronising = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        while (true) {
          const boundary = /\r?\n\r?\n/.exec(buffer);
          if (!boundary || boundary.index === undefined) {
            // No terminator yet. Bound what one unfinished event may accumulate
            // so a server that never terminates a frame cannot grow this
            // without limit — then wait for the next boundary and carry on.
            if (buffer.length > MAX_SSE_EVENT_CHARACTERS) {
              resynchronising = true;
              buffer = "";
            }
            break;
          }
          const block = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          // An event too large to use is malformed input like an unparseable
          // body or an unrecognised type, and is skipped the same way. Ending
          // the stream over one of them costs the caller every *later* event
          // too, which downstream shows up as a run that freezes mid-answer
          // and then jumps to its final result once polling catches up.
          if (resynchronising) {
            resynchronising = false;
            continue;
          }
          if (block.length > MAX_SSE_EVENT_CHARACTERS) continue;
          let eventName = "message";
          let sourceEventId: string | null = null;
          const dataLines: string[] = [];
          for (const line of block.split(/\r?\n/)) {
            if (line.startsWith("event:")) eventName = line.slice(6).trim();
            else if (line.startsWith("id:")) sourceEventId = line.slice(3).trim();
            else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
          }
          if (dataLines.length === 0) continue;
          let data: unknown;
          try {
            data = JSON.parse(dataLines.join("\n")) as unknown;
          } catch {
            continue;
          }
          await onRawEvent?.(eventName, data);
          if (!sourceEventId && data && typeof data === "object" && !Array.isArray(data)) {
            const value = data as Record<string, unknown>;
            const runId = safeEventText(value.run_id, 200);
            const sequence = safeNonnegativeInteger(value.seq);
            if (runId && sequence !== null) sourceEventId = `${runId}:${sequence}`;
          }
          const event = safeRunEvent(eventName, sourceEventId, data);
          if (!event) continue;
          if (event.type === "MESSAGE_DELTA" && event.delta) {
            pendingDeltaEvent = event;
            pendingDelta += event.delta;
            if (pendingDelta.length >= DELTA_FLUSH_CHARACTERS
              || Date.now() - lastDeltaFlushAt >= DELTA_FLUSH_INTERVAL_MS) {
              await flushDelta();
            }
            continue;
          }
          await flushDelta();
          await onEvent(event);
        }
      }
      await flushDelta();
    } finally {
      // A delta that was coalesced but never flushed is output the caller has
      // already been billed for. Every exit path has to hand it over — an
      // aborted signal and a transport error included — or the tail of the
      // answer is simply lost.
      try {
        await flushDelta();
      } catch {
        // The failure that brought us here is the one worth reporting.
      }
      // Without this the upstream keeps producing into a stream nobody reads.
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  async pollIntervalMs(): Promise<number> {
    const connection = await this.resolver.resolveOne("HERMES");
    return Math.min(10_000, Math.max(500, numberSetting(connection, "runPollIntervalMs", 1_000)));
  }

  private async request(connection: RuntimeConnection, url: URL, init: RequestInit): Promise<unknown> {
    const timeoutMs = Math.min(30_000, Math.max(1_000, numberSetting(connection, "timeoutMs", 8_000)));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetcher(url, {
        ...init,
        redirect: "error",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...(connection.secrets.apiKey ? { authorization: `Bearer ${connection.secrets.apiKey}` } : {}),
          ...init.headers,
        },
      });
      const body = await boundedJson(response);
      if (!response.ok) {
        const detail = body && typeof body === "object" && !Array.isArray(body)
          ? safeEventText((body as Record<string, unknown>).message ?? (body as Record<string, unknown>).error, 300)
          : null;
        throw new Error(`Hermes rejected the request with status ${response.status}${detail ? `: ${detail}` : ""}.`);
      }
      return body;
    } finally {
      clearTimeout(timeout);
    }
  }
}
