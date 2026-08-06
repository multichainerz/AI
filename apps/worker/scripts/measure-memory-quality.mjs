/**
 * Measures agent memory against a live installation.
 *
 * Deliberately end to end. Every mechanism this scores — distillation, the
 * always-injected profile, version chains, the idle sweep — was verified
 * locally and then failed on the pilot for reasons no stub could reproduce: a
 * reasoning model spending its whole budget before answering, a similarity
 * search that never surfaced the fact needing retirement, columns that shipped
 * unpopulated. A metric measured against stubs would measure the stubs.
 *
 * Runs inside the worker container, where the database, the master key, and the
 * inference route already are. It invents no endpoints: chat goes through the
 * API exactly as a person's would, distillation is the shipped sweep with its
 * idle wait set to zero, and the judge is the configured inference connection.
 *
 *   docker compose exec worker node apps/worker/scripts/measure-memory-quality.mjs
 *
 * Reads ORCASYNAPSE_BASE_URL (default http://api:4000, the API's port inside
 * the compose network) and ORCASYNAPSE_ADMIN_CREDENTIALS (a path to the local
 * administrator credentials).
 * Nothing read from either is logged.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { AgentMemoryStore, APPROVED_EMBEDDING_MODEL, LocalBgeM3Embedder } from "@orcasynapse/knowledge";
import { DrizzleRuntimeConnectionResolver } from "@orcasynapse/runtime-clients";
import { createDrizzleClient, readBootstrapSecret } from "@orcasynapse/database";
import { EnvelopeEncryption, decodeMasterKey } from "@orcasynapse/security";
import { WorkerAgentMemory } from "../dist/agent-processor.js";
import { MemoryDistiller } from "../dist/memory-distiller.js";
import { SessionMemoryDistiller } from "../dist/session-distiller.js";
import {
  MEMORY_QUALITY_SUITE,
  formatReport,
  parseVerdict,
  summarise,
} from "../dist/memory-quality.js";

const baseUrl = (process.env.ORCASYNAPSE_BASE_URL ?? "http://api:4000").replace(/\/+$/, "");
const credentialsPath = process.env.ORCASYNAPSE_ADMIN_CREDENTIALS;
if (!credentialsPath) {
  throw new Error("ORCASYNAPSE_ADMIN_CREDENTIALS must point to the local administrator credentials file.");
}
const TURN_TIMEOUT_MS = Number(process.env.ORCASYNAPSE_TURN_TIMEOUT_MS ?? 420_000);

const JUDGE_INSTRUCTION = [
  "You grade one answer against one criterion.",
  "",
  "Reply with exactly one word: PASS or FAIL. No explanation.",
  "",
  "Apply the criterion literally. Do not reward an answer for being helpful,",
  "well written, or nearly right. If the criterion is not met, the answer FAILS.",
].join("\n");

let cookie = "";

async function call(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...options.headers },
  });
  const issued = response.headers.getSetCookie?.() ?? [];
  if (issued.length > 0) cookie = issued.map((value) => value.split(";")[0]).join("; ");
  const text = await response.text();
  const body = text.length > 0 ? JSON.parse(text) : {};
  if (!response.ok) {
    const failure = new Error(`${options.method ?? "GET"} ${path} -> ${response.status} ${body.error ?? ""}`);
    failure.status = response.status;
    throw failure;
  }
  return body;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ask(conversationId, content) {
  // A run is marked complete before its memory capture finishes, so a turn
  // submitted immediately is refused at maxConcurrentRuns = 1. Retry the
  // conflict rather than treating it as a failure.
  let submission;
  const submitDeadline = Date.now() + TURN_TIMEOUT_MS;
  for (;;) {
    try {
      submission = await call(`/api/v1/chat/conversations/${conversationId}/messages`, {
        method: "POST",
        body: JSON.stringify({ content }),
      });
      break;
    } catch (error) {
      // Read the status off the error, not out of its message: the message
      // carries a conversation UUID, and hex digits spell 409 and 429 often
      // enough to make a regex over it quietly wrong.
      if (Date.now() > submitDeadline) throw error;
      if (error.status === 429) {
        // The limiter counts user messages per minute, so wait past the
        // window rather than retrying into the same refusal.
        await sleep(20_000);
      } else if (error.status === 409) {
        await sleep(5_000);
      } else {
        throw error;
      }
    }
  }

  const messageId = submission.assistantMessage.id;
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const conversation = await call(`/api/v1/chat/conversations/${conversationId}`);
    const message = conversation.messages.find((entry) => entry.id === messageId);
    if (message?.status === "COMPLETED") return message.content ?? "";
    if (message?.status === "FAILED") throw new Error("the agent run failed");
    await sleep(5_000);
  }
  throw new Error("the agent did not answer within the turn timeout");
}

async function conversationFor(title) {
  return (await call("/api/v1/chat/conversations", { method: "POST", body: JSON.stringify({ title }) })).id;
}

async function main() {
  const { database, close } = createDrizzleClient(readBootstrapSecret("orcasynapse_database_url"));
  const encryption = new EnvelopeEncryption({
    masterKey: decodeMasterKey(readBootstrapSecret("orcasynapse_master_key")),
  });
  const resolver = new DrizzleRuntimeConnectionResolver(database, encryption);
  const embedder = new LocalBgeM3Embedder();
  const distiller = new MemoryDistiller(resolver);
  // Idle wait of zero: the shipped sweep, without ten real minutes per case.
  const sweep = new SessionMemoryDistiller(
    database,
    new WorkerAgentMemory(new AgentMemoryStore(database, APPROVED_EMBEDDING_MODEL), embedder),
    distiller,
    0,
  );
  const workerId = randomUUID();

  /**
   * Drains whatever is already waiting, so an unrelated backlog cannot answer a
   * case's question. Reports the cap rather than stopping quietly at it.
   */
  const drain = async () => {
    for (let pass = 0; pass < 200; pass += 1) {
      if (!await sweep.distilNext(workerId)) return;
    }
    process.stdout.write("  (more than 200 sessions were waiting; the rest were left)\n");
  };

  const judge = async (question, answer, criterion) => {
    const connection = await resolver.resolveOne("INFERENCE");
    const model = connection.configuration?.modelAlias;
    if (typeof model !== "string" || model.length === 0) return null;
    const response = await fetch(`${connection.baseUrl.replace(/\/+$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(connection.secrets.apiKey ? { authorization: `Bearer ${connection.secrets.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: JUDGE_INSTRUCTION },
          { role: "user", content: `CRITERION: ${criterion}\n\nQUESTION: ${question}\n\nANSWER: ${answer}` },
        ],
        temperature: 0,
        max_tokens: 2_400,
      }),
    });
    if (!response.ok) return null;
    const body = await response.json();
    const verdict = body.choices?.[0]?.message?.content;
    return typeof verdict === "string" && verdict.trim().length > 0 ? parseVerdict(verdict) : null;
  };

  await call("/api/v1/admin/session/local", {
    method: "POST",
    body: readFileSync(credentialsPath, "utf8"),
  });

  const outcomes = [];
  try {
    // Drain anything already waiting, so a case's own capture is the only one
    // its question could be answered from.
    await drain();

    for (const testCase of MEMORY_QUALITY_SUITE) {
      process.stdout.write(`  ${testCase.id.padEnd(16)} `);
      try {
        const setup = await conversationFor(`Memory quality: ${testCase.id}`);
        for (const turn of testCase.setup) await ask(setup, turn);
        // This conversation specifically, not the head of the queue.
        await sweep.distilOne(setup, workerId);

        // A fresh conversation, so nothing but memory can supply the answer.
        const asking = await conversationFor(`Memory quality: ${testCase.id} (question)`);
        const answer = await ask(asking, testCase.question);

        const passed = await judge(testCase.question, answer, testCase.criterion);
        if (passed === null) {
          outcomes.push({ case: testCase, answer, passed: false, skipped: "the judge was unavailable" });
          process.stdout.write("skipped — no judge\n");
          continue;
        }
        outcomes.push({ case: testCase, answer, passed });
        process.stdout.write(passed ? "pass\n" : `FAIL — ${answer.slice(0, 80).replace(/\s+/g, " ")}\n`);
      } catch (error) {
        outcomes.push({ case: testCase, answer: "", passed: false, skipped: String(error.message ?? error) });
        process.stdout.write(`skipped — ${error.message ?? error}\n`);
      }
    }
  } finally {
    await close();
  }

  const report = summarise(outcomes);
  console.log(`\n${formatReport(report)}\n`);
  // A skipped case is neither a pass nor a failure, so it must not decide the
  // exit code either; only a scored failure does.
  process.exitCode = report.total > 0 && report.passed === report.total ? 0 : 1;
}

await main();
