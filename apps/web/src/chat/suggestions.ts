/**
 * Empty-state prompt cards. The catalog is larger than the two slots on screen
 * so a new conversation can offer a different pair without inventing copy at
 * render time.
 */

export interface ChatSuggestion {
  label: string;
  sub: string;
  prompt: string;
}

export const CHAT_SUGGESTIONS: readonly ChatSuggestion[] = [
  {
    label: "Outline an on-premise AI deployment",
    sub: "Main considerations, stated concisely",
    prompt: "Summarize the main considerations for an on-premise AI deployment.",
  },
  {
    label: "Create an AI risk checklist",
    sub: "For an internal assistant rollout",
    prompt: "Create a concise risk checklist for deploying an internal AI assistant.",
  },
  {
    label: "Explain the memory contract",
    sub: "Hermes owns context; PostgreSQL does not",
    prompt: "Explain why Hermes native sessions own conversational context and why the control-plane transcript must not be replayed as model history.",
  },
  {
    label: "Draft a VM2 enrollment runbook",
    sub: "Invite, heartbeat, then a native turn",
    prompt: "Write a short operator runbook for enrolling an isolated Hermes node: invitation, install, heartbeat, and the first native session turn that proves it works.",
  },
  {
    label: "Write a guardrail policy brief",
    sub: "Input limits, credentials, fail-closed",
    prompt: "Draft a brief for an input guardrail policy covering character limits, control characters, and credential patterns, and say what fail-closed means after the first activation.",
  },
  {
    label: "Plan a model activation",
    sub: "Draft, evaluate, promote, activate",
    prompt: "Walk through activating an AGENT model route: draft, evaluation evidence, promotion, and the fail-closed default after first activation.",
  },
  {
    label: "Review toolset admission",
    sub: "Default-deny except built-in memory",
    prompt: "Explain native Hermes toolset admission: what is denied by default, why built-in memory is admitted, and how an operator admits another toolset.",
  },
  {
    label: "Summarize corpus observability",
    sub: "What the mirror can and cannot do",
    prompt: "Summarize the Hermes corpus mirror: allowlisted paths, expected-hash mutations, two-person destructive approval, and why PostgreSQL is not a second memory store.",
  },
  {
    label: "Sketch an incident response",
    sub: "From a failed run to audit evidence",
    prompt: "Sketch how an operator should respond to a failed Hermes run: what the session shows, what to check in Operations, and what the audit trail should already contain.",
  },
  {
    label: "Compare deployment topologies",
    sub: "Compact control plane vs isolated runtime",
    prompt: "Compare a compact control-plane install with a segmented VM1/VM2 topology, including where inference credentials and Hermes memory live in each.",
  },
  {
    label: "List first-hour operator checks",
    sub: "Inference, node online, one native turn",
    prompt: "List the first-hour checks after install: healthy inference, enrolled Hermes node, a completed native session turn, and what each check does not prove.",
  },
  {
    label: "Propose session hygiene",
    sub: "Cancel, archive, export, and audit",
    prompt: "Propose a session hygiene practice for operators: when to cancel a run, when to archive or delete a conversation, and what evidence remains in the audit trail.",
  },
];

export function pickChatSuggestions(
  catalog: readonly ChatSuggestion[] = CHAT_SUGGESTIONS,
  count = 4,
  random: () => number = Math.random,
): ChatSuggestion[] {
  const pool = [...catalog];
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swapWith = Math.floor(random() * (index + 1));
    const current = pool[index];
    const other = pool[swapWith];
    if (current === undefined || other === undefined) continue;
    pool[index] = other;
    pool[swapWith] = current;
  }
  return pool.slice(0, Math.min(count, pool.length));
}
