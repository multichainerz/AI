/**
 * @vitest-environment jsdom
 *
 * The transcript, which had no test at all while being the thing the product
 * exists to render. One conversation carrying every block it can produce:
 * markdown, agent activity, a pending approval, knowledge sources, response
 * telemetry, and a failed turn.
 *
 * It doubles as the only way to *look* at a populated transcript without a
 * signed-in session and a reachable runtime. Set `TRANSCRIPT_PREVIEW_OUT` to a
 * path and it writes the rendered markup there; pair that with the stylesheet
 * from `pnpm --filter @orcasynapse/web build` and it opens in a browser. That is
 * how this release was checked, because porting 200 lines of transcript CSS
 * blind is exactly the change that looks fine in a diff.
 */
import type { ChatConversation } from "@orcasynapse/contracts";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const message = (over: Record<string, unknown>) => ({
  id: String(over.id),
  role: "ASSISTANT",
  content: "",
  status: "COMPLETED",
  createdAt: "2026-08-07T09:14:00.000Z",
  modelAlias: "qwen3.6-27b",
  totalTokens: 1_284,
  inputTokens: 902,
  outputTokens: 382,
  reasoningTokens: 140,
  latencyMs: 4_120,
  firstTokenLatencyMs: 640,
  finishReason: "STOP",
  errorCode: null,
  agentRunId: null,
  sources: [],
  approvals: [],
  runtimeEvents: [],
  feedback: null,
  ...over,
});

const conversation = {
  id: "8a1c2e3d-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
  title: "Runbook questions",
  modelAlias: "qwen3.6-27b",
  profileId: "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e",
  profileName: "Support agent",
  status: "ACTIVE",
  messageCount: 4,
  lastMessagePreview: "Here is the checklist.",
  createdAt: "2026-08-07T09:00:00.000Z",
  updatedAt: "2026-08-07T09:15:00.000Z",
  lastMessageAt: "2026-08-07T09:15:00.000Z",
  knowledgeDocuments: [{ id: "doc-ready", fileName: "runbook.pdf", classification: "INTERNAL", status: "READY" }],
  messages: [
    message({
      id: "m1",
      role: "USER",
      content: "What should we check before promoting the release to the pilot node?",
      totalTokens: null,
      latencyMs: null,
    }),
    message({
      id: "m2",
      content: [
        "Before promoting, confirm three things.",
        "",
        "## Checklist",
        "",
        "1. **Migrations applied** — `drizzle-kit check` reports no drift.",
        "2. **Runtime reachable** — VM2 answers `/health` within the timeout.",
        "3. Toolset policy signed by the current control-plane key.",
        "",
        "> Anything unsigned is refused at admission, not at call time.",
        "",
        "```bash",
        "pnpm verify && bash scripts/test-release-consistency.sh",
        "```",
        "",
        "| Surface | Checked |",
        "| --- | --- |",
        "| contracts | yes |",
        "| installer | yes |",
      ].join("\n"),
      sources: [
        { documentId: "doc-ready", fileName: "runbook.pdf", classification: "INTERNAL", score: 0.82 },
        { documentId: "doc-two", fileName: "release-policy.md", classification: "CONFIDENTIAL", score: 0.64 },
      ],
      runtimeEvents: [
        {
          id: "e1", type: "RUN_STARTED", toolName: null, status: "started", summary: "Agent run accepted",
          preview: null, durationMs: null, inputTokens: null, outputTokens: null, reasoningTokens: null,
          costUsd: null, occurredAt: "2026-08-07T09:14:01.000Z",
        },
        {
          /*
           * The start of the call `e2` completes. Both carry the same
           * `toolCallKey`, which is what makes them one call rather than two
           * rows -- the fixture had no key at all, so the grouping this asserts
           * was invisible to every test.
           */
          id: "e1b", type: "TOOL_STARTED", toolName: "knowledge.search", status: "started",
          summary: null, preview: null, durationMs: null, inputTokens: null, outputTokens: null,
          reasoningTokens: null, costUsd: null, toolCallKey: "knowledge.search#1",
          occurredAt: "2026-08-07T09:14:01.500Z",
        },
        {
          // `TOOL_CALLED` and `SUBAGENT_FINISHED` stood here for months. Neither
          // is a member of AGENT_RUN_EVENT_TYPES, so this fixture described a
          // transcript the runtime cannot produce — and the cast below is what
          // let it compile. `chat-stream-reducer.test.ts` now pins the real
          // vocabulary; these two are the types the runtime actually emits.
          id: "e2", type: "TOOL_COMPLETED", toolName: "knowledge.search", status: "completed",
          toolCallKey: "knowledge.search#1",
          summary: "Retrieved 6 chunks", preview: "query: promotion checklist", durationMs: 412,
          inputTokens: 120, outputTokens: 48, reasoningTokens: null, costUsd: 0.0012,
          occurredAt: "2026-08-07T09:14:02.000Z",
        },
        {
          id: "e3", type: "SUBAGENT_COMPLETED", toolName: null, status: "completed",
          summary: "Summarised retrieval", preview: null, durationMs: 1_902, inputTokens: 880,
          outputTokens: 260, reasoningTokens: 140, costUsd: 0.0041, occurredAt: "2026-08-07T09:14:04.000Z",
        },
      ],
      approvals: [
        {
          id: "a1", status: "PENDING", decision: null, summary: "Hermes wants to read the deployment manifest",
          command: "cat /etc/orcasynapse/desired-state.json", expiresAt: "2026-08-07T09:20:00.000Z",
        },
      ],
    }),
    message({ id: "m3", role: "USER", content: "Run it.", totalTokens: null, latencyMs: null }),
    message({
      id: "m4", status: "FAILED", content: "", errorCode: "RUNTIME_UNREACHABLE", totalTokens: null, latencyMs: null,
    }),
  ],
} as unknown as ChatConversation;

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<typeof import("./api.js")>("./api.js");
  return {
    ...actual,
    getChatConversations: vi.fn(async () => ({ items: [{ ...conversation, messages: undefined }] })),
    getChatConversation: vi.fn(async () => conversation),
    getAgentProfiles: vi.fn(async () => ({ items: [] })),
    getDocuments: vi.fn(async () => ({ items: [] })),
  };
});

Element.prototype.scrollIntoView = () => undefined;

const { ChatView } = await import("./chat-view.js");

async function transcript() {
  render(
    <main className="chat-page">
      <ChatView
        unlocked
        identityMode="ADMINISTRATOR_PREVIEW"
        displayName="Operator"
        administratorReadiness={null}
        oidcConfigured={false}
        onSignIn={vi.fn()}
        onConfigure={vi.fn()}
        onOpenAgents={vi.fn()}
        onOpenPlatform={vi.fn()}
        onSessionExpired={vi.fn()}
      />
    </main>,
  );
  await waitFor(() => screen.getByText(/Before promoting/));
  if (process.env.TRANSCRIPT_PREVIEW_OUT) {
    writeFileSync(process.env.TRANSCRIPT_PREVIEW_OUT, document.body.innerHTML, "utf8");
  }
}

afterEach(cleanup);

describe("chat transcript", () => {
  it("renders an agent answer as markup, not as the markdown it arrived as", async () => {
    await transcript();

    // The heading, list, code block and table have to be real elements: a
    // response that shows its own backticks is the whole failure mode here.
    expect(screen.getByRole("heading", { name: "Checklist" })).toBeTruthy();
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByText("drizzle-kit check").tagName).toBe("CODE");
    expect(screen.getByText(/pnpm verify && bash/).closest("pre")).toBeTruthy();
  });

  it("derives effective speed rather than reprinting a number the runtime sent", async () => {
    // 382 output tokens over 4.12 s. Nothing reports this; OrcaSynapse computes
    // it, and it is the one figure on the panel an operator actually compares.
    await transcript();
    const telemetry = screen.getByLabelText("Response performance");

    expect(within(telemetry).getByText("92.7 tok/s")).toBeTruthy();
    expect(within(telemetry).getByText("640 ms")).toBeTruthy();
    expect(within(telemetry).getByText("4.12 s")).toBeTruthy();
  });

  it("offers a decision only while the approval is still open", async () => {
    await transcript();
    const approval = screen.getByLabelText("Hermes approval request");

    expect(within(approval).getByText("cat /etc/orcasynapse/desired-state.json")).toBeTruthy();
    expect(within(approval).getByRole("button", { name: "Deny" })).toBeTruthy();
    expect(within(approval).getByRole("button", { name: "Allow once" })).toBeTruthy();
    expect(within(approval).getByText(/^Expires /)).toBeTruthy();
  });

  it("names every governed step the run took, with what each one cost", async () => {
    await transcript();
    const activity = screen.getByLabelText("Hermes agent activity");

    expect(within(activity).getByText("4 events")).toBeTruthy();
    /*
     * Four events, three rows: the start and the completion of one tool call
     * are one thing that happened. `getByText` is the assertion -- it throws on
     * multiple matches, so an ungrouped list fails here with the name appearing
     * twice rather than passing quietly.
     */
    expect(within(activity).getAllByRole("listitem")).toHaveLength(3);
    expect(within(activity).getByText("knowledge.search")).toBeTruthy();
    expect(within(activity).getByText(/412 ms · 120 in · 48 out · \$0\.0012/)).toBeTruthy();
    expect(within(activity).getByText("Hermes subagent")).toBeTruthy();
  });

  it("folds the machinery away once the turn has landed", async () => {
    /*
     * Loud while it happens, quiet once it has. A finished answer with nine
     * expanded rows of tool traffic above it buries the thing the reader asked
     * for -- by the third turn the transcript is mostly machinery. The rows
     * stay in the document, so this is a fold and not a deletion.
     */
    await transcript();
    const activity = screen.getByLabelText("Hermes agent activity");

    expect(activity.hasAttribute("open")).toBe(false);
    expect(within(activity).getAllByRole("listitem")).toHaveLength(3);
  });

  it("says what happened while it is folded, including a failure", async () => {
    // The risk of folding is a reader who sees one calm line and never opens
    // it, so the summary has to carry the bad news itself.
    await transcript();
    const activity = screen.getByLabelText("Hermes agent activity");

    expect(within(activity).getByText(/^Worked for /)).toBeTruthy();
  });

  it("attributes the answer to the documents it retrieved", async () => {
    await transcript();
    const sources = screen.getByLabelText("Enterprise knowledge sources");

    expect(within(sources).getByText("runbook.pdf")).toBeTruthy();
    expect(within(sources).getByText(/internal · 82% match/)).toBeTruthy();
  });

  it("says why a turn failed and offers the way back", async () => {
    await transcript();

    expect(screen.getByText(/Generation failed · RUNTIME_UNREACHABLE/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry prompt" })).toBeTruthy();
    // A failed turn has nothing to measure, so it must not draw a telemetry panel.
    expect(screen.getAllByLabelText("Response performance")).toHaveLength(1);
  });

  it("renders no inline style, which the CSP would refuse in the built container", async () => {
    await transcript();
    expect(document.body.innerHTML).not.toMatch(/\sstyle="/);
  });
});
