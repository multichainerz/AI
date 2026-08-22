import { AGENT_RUN_ENDED_EVENT_TYPE } from "@orcasynapse/contracts";
import { describe, expect, it, vi } from "vitest";
import type { DrizzleRuntimeConnectionResolver } from "./connection-resolver.js";
import { HermesClient, hermesInboxOrigin, nativeSessionChatBody, SAFE_EVENT_TYPES } from "./hermes-client.js";

function resolver(): DrizzleRuntimeConnectionResolver {
  return {
    resolveOne: vi.fn(async () => ({
      id: "6cf6ce1b-a8c6-49d7-b6aa-019d35888acb",
      kind: "HERMES",
      baseUrl: "https://hermes.orcasynapse.internal/",
      configuration: {},
      secrets: { apiKey: "strong-hermes-key" },
    })),
  } as unknown as DrizzleRuntimeConnectionResolver;
}

const capabilities = {
  platform: "hermes-agent",
  auth: { type: "bearer", required: true },
  runtime: { mode: "server_agent", tool_execution: "server", split_runtime: false },
  features: { run_submission: true, run_status: true, run_events_sse: true, run_stop: true },
};

/** The error a call raised, so an assertion can be made about which one it is. */
function rejection(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => { throw new Error("The call resolved where a rejection was expected."); },
    (error: unknown) => error as Error,
  );
}

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("HermesClient native sessions", () => {
  it("permits only built-in memory and explicitly admitted toolsets", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => new Response(JSON.stringify(
      input.toString().endsWith("/v1/capabilities")
        ? capabilities
        : { object: "list", platform: "api_server", data: [
            { name: "memory", enabled: true, tools: ["memory"] },
            { name: "terminal", enabled: true, tools: ["terminal"] },
          ] },
    ), { status: 200 }));
    const client = new HermesClient(resolver(), fetcher);
    await expect(client.assertAdmittedToolBoundary()).rejects.toThrow("terminal");
    await expect(client.assertAdmittedToolBoundary(["terminal"])).resolves.toBeUndefined();
  });

  /*
   * `memory` is permitted without being admitted, and that is what makes this
   * boundary a one-tool boundary rather than the zero-tool one it is sometimes
   * described as.
   *
   * Worth its own test because the description outlived the code. The refusal
   * carried a second message -- "OrcaSynapse requires a zero-tool boundary for
   * this run" -- behind `permitted.size === 0`, which cannot happen: `memory`
   * is added unconditionally, so the set is never empty and that sentence had
   * never been shown to anybody. It is gone; this pins the fact that made it
   * unreachable, so removing the built-in grant fails here rather than quietly
   * changing what an installation admitting nothing is allowed to run.
   */
  it("admits Hermes' built-in memory toolset without an operator admitting it", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => new Response(JSON.stringify(
      input.toString().endsWith("/v1/capabilities")
        ? capabilities
        : { object: "list", platform: "api_server", data: [
            { name: "memory", enabled: true, tools: ["memory"] },
          ] },
    ), { status: 200 }));
    const client = new HermesClient(resolver(), fetcher);

    await expect(client.assertAdmittedToolBoundary()).resolves.toBeUndefined();
  });

  it("uses the native transcript without legacy history or memory headers", async () => {
    const stream = [
      `event: run.started\ndata: ${JSON.stringify({ run_id: "native-upstream-1", session_id: "session-1", seq: 1 })}\n\n`,
      `event: assistant.delta\ndata: ${JSON.stringify({ run_id: "native-upstream-1", seq: 2, delta: "Native answer" })}\n\n`,
      `event: assistant.completed\ndata: ${JSON.stringify({ run_id: "native-upstream-1", seq: 3, content: "Native answer" })}\n\n`,
      `event: run.completed\ndata: ${JSON.stringify({ run_id: "native-upstream-1", seq: 4, usage: { input_tokens: 12, output_tokens: 2 } })}\n\n`,
      "event: done\ndata: {}\n\n",
    ];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = input.toString();
      if (url.endsWith("/v1/capabilities")) return new Response(JSON.stringify(capabilities));
      if (url.endsWith("/v1/toolsets")) return new Response(JSON.stringify({ object: "list", platform: "api_server", data: [] }));
      if (url.endsWith("/api/sessions/session-1") && init?.method === "GET") return new Response("{}", { status: 404 });
      if (url.endsWith("/api/sessions") && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({ id: "session-1", model: "hermes-agent", source: "api_server" });
        return new Response(JSON.stringify({ object: "hermes.session" }), { status: 201 });
      }
      if (url.endsWith("/api/sessions/session-1/chat/stream")) {
        expect(JSON.parse(String(init?.body))).toEqual({ message: "New question", instructions: "Stay bounded", model: "hermes-agent" });
        expect(JSON.stringify(init?.headers)).not.toContain("x-hermes-session-key");
        return new Response(sseStream(stream), { headers: { "content-type": "text/event-stream" } });
      }
      throw new Error(`Unexpected Hermes request: ${url}`);
    });
    const client = new HermesClient(resolver(), fetcher);
    const submission = {
      input: "New question",
      instructions: "Stay bounded",
      sessionId: "session-1",
      idempotencyKey: "request-1",
      modelAlias: "hermes-agent",
    };
    const id = await client.start(submission);
    const streamCall = fetcher.mock.calls.find(([input]) => input.toString().endsWith("/api/sessions/session-1/chat/stream"));
    expect(String(streamCall?.[1]?.body)).toBe(JSON.stringify(nativeSessionChatBody(submission)));
    const events: string[] = [];
    await client.events(id, (event) => { events.push(event.type); }, new AbortController().signal);
    await expect(client.status(id)).resolves.toMatchObject({ status: "completed", output: "Native answer", totalTokens: 14 });
    expect(events).toEqual(["RUN_STARTED", "MESSAGE_DELTA", "RUN_COMPLETED"]);
  });

  it("forks and deletes native transcripts", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => new Response(JSON.stringify(
      input.toString().endsWith("/fork")
        ? { object: "hermes.session", session: { id: "target" } }
        : { object: "hermes.session.deleted", deleted: true },
    ), { status: input.toString().endsWith("/fork") ? 201 : 200 }));
    const client = new HermesClient(resolver(), fetcher);
    await expect(client.forkSession("source", "target")).resolves.toBe("forked");
    await expect(client.deleteSession("target")).resolves.toBeUndefined();
  });

  /*
   * A native session turn is delivered exactly once, to the process that
   * submitted it. A worker that inherits somebody else's run therefore has to
   * be able to tell "this turn is gone with its worker" from "that is not an id
   * I ever issued": the first means Hermes still holds the exchange and the
   * transcript the reader sees is now short of it, and the second is a
   * programming error. Both used to raise the same sentence.
   */
  it("tells a run it never started apart from an id it never issued", async () => {
    const client = new HermesClient(resolver(), vi.fn<typeof fetch>());

    const detached = await rejection(client.status(`hermes-native-${"a".repeat(64)}`));
    const unknown = await rejection(client.status("run-from-some-other-surface"));

    expect(detached.name).toBe("HermesRunDetachedError");
    expect(unknown.name).not.toBe("HermesRunDetachedError");
    expect(detached.message).not.toBe(unknown.message);
  });

  it("reports a detached event stream the same way it reports a detached status", async () => {
    const client = new HermesClient(resolver(), vi.fn<typeof fetch>());
    const streamed = await rejection(
      client.events(`hermes-native-${"b".repeat(64)}`, () => undefined, new AbortController().signal),
    );

    expect(streamed.name).toBe("HermesRunDetachedError");
  });

  it("puts session uploads on the inbox port, not the Hermes chat port", async () => {
    expect(hermesInboxOrigin("http://192.0.2.10:8642").origin).toBe("http://192.0.2.10:8643");
    expect(hermesInboxOrigin("https://hermes.example/", { inboxUrl: "https://hermes.example:9443/" }).origin)
      .toBe("https://hermes.example:9443");
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(input.toString()).toBe("https://hermes.orcasynapse.internal:8643/v1/session-uploads/session-1/notes.txt");
      expect(init?.method).toBe("PUT");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer strong-hermes-key");
      expect(Buffer.from(init?.body as Buffer)).toEqual(Buffer.from([1, 2, 3]));
      return new Response(JSON.stringify({ path: "/var/lib/orcasynapse-hermes/artifacts/session-1/inbox/notes.txt" }));
    });
    const client = new HermesClient(resolver(), fetcher);
    await client.materializeSessionInbox("session-1", [{ fileName: "notes.txt", bytes: new Uint8Array([1, 2, 3]) }]);
  });
});

describe("the run-ended marker", () => {
  /*
   * Invariant 3 of the chat event log, asserted where the map is visible.
   *
   * `agent-processor.recordSafeEvent` inserts `event.type` verbatim, and a
   * subscriber ends its stream on `RUN_ENDED` and on nothing else. So a wire
   * name projecting onto that marker would let a Hermes build end a turn while
   * the answer is still unstored -- the reader would be told the run finished
   * and never receive it. The contract states this invariant; only this package
   * can check it, because only this package can see the map.
   */
  it("is a name no Hermes event maps to", () => {
    expect([...SAFE_EVENT_TYPES.values()]).not.toContain(AGENT_RUN_ENDED_EVENT_TYPE);
  });
});
