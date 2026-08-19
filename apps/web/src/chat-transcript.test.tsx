/**
 * @vitest-environment jsdom
 *
 * The transcript, which had no test at all while being the thing the product
 * exists to render. One conversation carrying every block it can produce:
 * markdown, agent activity, a pending approval, response
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
          id: "e1b", type: "TOOL_STARTED", toolName: "system.status", status: "started",
          summary: null, preview: null, durationMs: null, inputTokens: null, outputTokens: null,
          reasoningTokens: null, costUsd: null, toolCallKey: "system.status#1", contentOffset: 41,
          occurredAt: "2026-08-07T09:14:01.500Z",
        },
        {
          // `TOOL_CALLED` and `SUBAGENT_FINISHED` stood here for months. Neither
          // is a member of AGENT_RUN_EVENT_TYPES, so this fixture described a
          // transcript the runtime cannot produce — and the cast below is what
          // let it compile. `chat-stream-reducer.test.ts` now pins the real
          // vocabulary; these two are the types the runtime actually emits.
          id: "e2", type: "TOOL_COMPLETED", toolName: "system.status", status: "completed",
          toolCallKey: "system.status#1",
          summary: "Checked service status", preview: "control plane healthy", durationMs: 412,
          inputTokens: 120, outputTokens: 48, reasoningTokens: null, costUsd: 0.0012,
          occurredAt: "2026-08-07T09:14:02.000Z",
        },
        {
          id: "e2b", type: "TOOL_STARTED", toolName: "system.status", status: "started",
          summary: null, preview: null, durationMs: null, inputTokens: null, outputTokens: null,
          reasoningTokens: null, costUsd: null, toolCallKey: "system.status#2", contentOffset: 41,
          occurredAt: "2026-08-07T09:14:02.100Z",
        },
        {
          id: "e2c", type: "TOOL_COMPLETED", toolName: "system.status", status: "completed",
          toolCallKey: "system.status#2",
          summary: "Confirmed service status", preview: "runtime node healthy", durationMs: 385,
          inputTokens: 80, outputTokens: 24, reasoningTokens: null, costUsd: 0.0008, contentOffset: 41,
          occurredAt: "2026-08-07T09:14:02.500Z",
        },
        {
          id: "e3", type: "SUBAGENT_COMPLETED", toolName: null, status: "completed",
          summary: "Summarised retrieval", preview: null, durationMs: 1_902, inputTokens: 880,
          outputTokens: 260, reasoningTokens: 140, costUsd: 0.0041, contentOffset: 250,
          occurredAt: "2026-08-07T09:14:04.000Z",
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
    getChatArtifacts: vi.fn(async () => ({
      items: [{
        id: "0b54a1de-6f0f-4b7e-9a94-1c2d3e4f5a6b",
        runId: "c2a4e6f8-1b3d-4f5a-8c7e-9d0b1a2c3e4f",
        conversationId: conversation.id, messageId: "m2",
        nodeId: "9de260d7-bc51-4558-9d20-06916d393072", divisionId: null,
        name: "checklist.md", path: "out/checklist.md", mediaType: "text/markdown",
        sizeBytes: 2_048, sha256: "a".repeat(64), storage: "INLINE",
        conversationTitle: "Runbook questions", profileName: "Support agent",
        observedAt: "2026-08-07T09:14:05.000Z", createdAt: "2026-08-07T09:14:06.000Z",
      }],
    })),
    getAgentProfiles: vi.fn(async () => ({ items: [] })),
    getModelDeployments: vi.fn(async () => ({
      items: [{ modelAlias: "qwen3.6-27b", status: "ACTIVE", contextWindowTokens: 16_384 }],
    })),
  };
});

Element.prototype.scrollIntoView = () => undefined;

const { ChatView } = await import("./chat-view.js");

async function transcript() {
  render(
    <main className="chat-page">
      <ChatView
        unlocked
        displayName="Operator"
        administratorReadiness={null}
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

  it("shows the agent profile while omitting the singular runtime alias", async () => {
    await transcript();
    const answer = screen.getByText(/Before promoting/).closest("article");
    expect(answer).toBeTruthy();
    const timestamp = (answer as HTMLElement).querySelector("time");

    expect(timestamp?.textContent?.trim()).toBeTruthy();
    expect(within(answer as HTMLElement).getByText("Support agent")).toBeTruthy();
    expect(within(answer as HTMLElement).queryByText("qwen3.6-27b")).toBeNull();
  });

  it("renders user turns as compact content-sized bubbles", async () => {
    await transcript();
    const article = screen.getByText("Run it.").closest("article");
    const bubble = screen.getByText("Run it.").parentElement;
    const metadata = within(article as HTMLElement).getByText("You").parentElement?.parentElement;

    expect(article?.className).toContain("w-fit");
    expect(article?.className).toContain("max-w-[88%]");
    expect(bubble?.className).toContain("rounded-card");
    expect(metadata?.className).toContain("absolute");
    expect(within(article as HTMLElement).getByLabelText("Operator avatar").textContent).toBe("O");
  });

  it("reports measured model-context usage in the composer", async () => {
    await transcript();

    const context = screen.getByLabelText("Context usage 6%");
    expect(context.textContent).toContain("Context");
    expect(context.textContent).toContain("6%");
    expect(context.getAttribute("title")).toContain("902 of 16,384 tokens");
  });

  it("derives effective speed rather than reprinting a number the runtime sent", async () => {
    // 382 output tokens over 4.12 s. Nothing reports this; OrcaSynapse computes
    // it, and it is the one figure on the panel an operator actually compares.
    await transcript();
    const telemetry = screen.getByLabelText("Response telemetry");

    expect(within(telemetry).getByText("92.7 tok/s")).toBeTruthy();
    expect(within(telemetry).getByText("902 in / 382 out")).toBeTruthy();
    // TTFT and latency are gone: the closing line under the answer already
    // prints the turn's duration, and time-to-first-token measured an
    // experience the reader had just had rather than anything to act on.
    expect(within(telemetry).queryByText("640 ms")).toBeNull();
    expect(within(telemetry).queryByText("4.12 s")).toBeNull();
    // Each figure names its own unit, so the four icons that used to sit beside
    // them were decoration standing in for labels the values already carry.
    expect(telemetry.querySelectorAll("svg")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Copy response" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Mark response helpful" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Mark response not helpful" })).toBeNull();
  });

  it("offers a decision only while the approval is still open", async () => {
    await transcript();
    const approval = screen.getByLabelText("Hermes approval request");

    expect(within(approval).getByText("cat /etc/orcasynapse/desired-state.json")).toBeTruthy();
    expect(within(approval).getByRole("button", { name: "Deny" })).toBeTruthy();
    expect(within(approval).getByRole("button", { name: "Allow once" })).toBeTruthy();
    expect(within(approval).getByText(/^Expires /)).toBeTruthy();
  });

  it("places governed actions beside the part of the answer they produced", async () => {
    await transcript();
    const activity = screen.getByLabelText("Hermes agent activity");

    const intro = within(activity).getByText("Before promoting, confirm three things.");
    const tool = within(activity).getByLabelText("Ran 2 tool calls");
    const checklist = within(activity).getByRole("heading", { name: "Checklist" });
    const subagent = within(activity).getByLabelText("Completed 1 agent action");
    const quote = within(activity).getByText(/Anything unsigned/);

    expect(intro.compareDocumentPosition(tool) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tool.compareDocumentPosition(checklist) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(checklist.compareDocumentPosition(subagent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(subagent.compareDocumentPosition(quote) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(activity).getByText("control plane healthy")).toBeTruthy();
    expect(within(activity).getByText("412 ms")).toBeTruthy();
    expect(within(activity).queryByText("Agent run accepted")).toBeNull();
  });

  it("folds a repeated call into one expandable step", async () => {
    await transcript();
    const activity = screen.getByLabelText("Hermes agent activity");

    const repeated = within(activity).getByLabelText("Used system status, 2 calls, Completed");
    expect(repeated.tagName).toBe("SUMMARY");
    expect(repeated.closest("details")?.hasAttribute("open")).toBe(false);
    expect(within(repeated).getByText("×2")).toBeTruthy();
    expect(repeated.closest("details")?.querySelectorAll("ol > li")).toHaveLength(2);
    expect(activity.querySelectorAll("section > ol > li")).toHaveLength(2);
    expect(within(activity).queryByText(/events$/)).toBeNull();
  });

  it("spends ink only on a step that did not simply work", async () => {
    // Every governed call in this transcript succeeded. A trail that annotates
    // each of them "Completed" is a column of noise the reader has to scan past
    // to find the one line that is not -- so success is stated in the
    // accessible name and nowhere else.
    await transcript();
    const activity = screen.getByLabelText("Hermes agent activity");

    expect(within(activity).queryByText("Completed")).toBeNull();
    expect(within(activity).queryByText("In progress")).toBeNull();
    expect(within(activity).queryByText("Agent activity")).toBeNull();
  });

  it("says what happened while it is folded, including a failure", async () => {
    // The risk of folding is a reader who sees one calm line and never opens
    // it, so the summary has to carry the bad news itself. The line is built
    // from parts now rather than one sentence, so the whole of it is asserted
    // through the accessible name and the figures through the rendered spans.
    await transcript();
    const activity = screen.getByLabelText("Hermes agent activity");

    const summary = within(activity).getByLabelText("4.1 s · 2 tools · 1 subagent");
    expect(summary.tagName).toBe("FOOTER");
    expect(within(summary).getByText("4.1 s")).toBeTruthy();
    expect(within(summary).getByText("tools")).toBeTruthy();
    expect(within(summary).getByText("subagent")).toBeTruthy();
  });

  it("attaches a produced file to the message that produced it", async () => {
    await transcript();
    const files = await screen.findByLabelText("Files from this response");

    // On the answer, not in a sidebar: the deliverable is part of the turn.
    expect(screen.getByLabelText("Hermes agent activity").compareDocumentPosition(files) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(files).getByText("checklist.md")).toBeTruthy();
    const download = within(files).getByRole("link", { name: "Download" }) as HTMLAnchorElement;
    expect(download.getAttribute("href")).toBe("/api/v1/chat/artifacts/0b54a1de-6f0f-4b7e-9a94-1c2d3e4f5a6b/content");
    expect(download.getAttribute("download")).toBe("checklist.md");
  });

  it("says why a turn failed and offers the way back", async () => {
    await transcript();

    expect(screen.getByText(/Generation failed · RUNTIME_UNREACHABLE/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry prompt" })).toBeTruthy();
    // A failed turn has nothing to measure, so it must not draw a telemetry row.
    expect(screen.getAllByLabelText("Response telemetry")).toHaveLength(1);
  });

  it("renders no inline style, which the CSP would refuse in the built container", async () => {
    await transcript();
    expect(document.body.innerHTML).not.toMatch(/\sstyle="/);
  });
});
