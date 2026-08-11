# Hermes-Native Memory Runbook

OrcaSynapse delegates agent memory and conversational continuity to Hermes. The
active runtime owns `MEMORY.md`, `USER.md`, and its native session database on
VM2. OrcaSynapse does not read, mirror, edit, embed, search, or expose those
contents.

Document knowledge is a separate subsystem. Extracted document chunks and
BGE-M3 embeddings remain owner-scoped in PostgreSQL/pgvector on VM1 and may be
retrieved before a turn. They are references for the current answer, not agent
memory.

## Active boundary

| State | Owner | Location | Visible in OrcaSynapse |
| --- | --- | --- | --- |
| Native session transcript | Hermes | VM2 Hermes state database | Sanitized message/run projection only |
| `MEMORY.md` | Hermes | Active VM2 Hermes home/profile | No |
| `USER.md` | Hermes | Active VM2 Hermes home/profile | No |
| Document chunks and embeddings | OrcaSynapse | VM1 PostgreSQL/pgvector | Yes, subject to authorization |
| Run lifecycle and audit evidence | OrcaSynapse | VM1 PostgreSQL | Yes; memory contents are excluded |

The VM2 managed policy explicitly enables `memory.memory_enabled` and
`memory.user_profile_enabled` with Hermes' native character limits. The runtime
allowlist admits the built-in `memory` tool and `no_mcp`; every other toolset is
still denied unless an operator has explicitly admitted it.

Vanilla Hermes does **not** create a separate `MEMORY.md` and `USER.md` pair for
each session. Session transcripts are separate, while those two memory files are
shared by every session using the active Hermes home/profile. That is acceptable
for the current single-trust-boundary, pre-production installation. It is not a
multi-user isolation boundary; separate Hermes profiles/homes or a deliberately
scoped future design are required before mutually untrusted users are admitted.
The managed installer removes any external `memory.provider` setting so there is
only this built-in owner.

The legacy OrcaSynapse `AgentMemory` tables, policy schemas, and migrations are
kept for rollback compatibility with `backup/pgvector`. They are not wired into
the worker, are not granted as run capabilities, and are not exposed in current
workspace navigation.

## What the audit trail records

OrcaSynapse records session creation, run submission, safe lifecycle events,
terminal status, timing, token counts when Hermes reports them, cancellation,
profile/version identity, and administrative actions. It does not record memory
file contents or infer which facts Hermes added, changed, or removed. A memory
change is observable only if Hermes emits a safe operational event for it.

This separation is intentional: the audit trail proves who ran what and how it
ended without becoming a second memory store.

## Session lifecycle

- A conversation ID is also its Hermes native session ID. OrcaSynapse sends
  only the new user turn; it does not replay its message projection.
- Forking uses Hermes' native session-fork endpoint and is allowed only from
  the latest completed message. A historical point cannot be represented by
  the pinned Hermes API, so OrcaSynapse refuses it instead of presenting an
  inaccurate branch.
- A legacy conversation whose Hermes-native source session is absent cannot be
  forked with context. Start a new conversation or retain the legacy deployment
  on `backup/pgvector` for that workflow.
- Conversation deletion removes the authoritative Hermes session before the
  OrcaSynapse projection. If Hermes cannot confirm deletion, the local record is
  retained and the operation fails closed, preventing an invisible orphaned
  transcript.

## Backup and restore

Back up both machines when agent continuity matters:

1. Back up VM1 PostgreSQL for control-plane state, document knowledge, run
   projections, and audit evidence.
2. Back up `${ORCASYNAPSE_HERMES_STATE_ROOT:-/var/lib/orcasynapse-hermes}` on
   VM2 for Hermes sessions, native memory, Skills, identity, and managed runtime
   state.
3. Protect backups with the organization's encryption, retention, and access
   controls. Native memory may contain personal or sensitive facts.
4. Restore VM2 state only onto an approved Hermes revision, then verify file
   ownership remains `orcasynapse-hermes:orcasynapse-hermes` and the service
   account home is the managed state root.
5. Run a two-turn session after restore and verify the second turn sees the
   first through Hermes without OrcaSynapse replaying conversation history.

A clean VM2 reinstall without restoring its state starts with empty Hermes
sessions and memory. Restoring only PostgreSQL does not restore native memory.

## Operational verification

On VM2:

```bash
sudo systemctl is-active orcasynapse-hermes
sudo grep -A7 '^memory:' /etc/hermes/config.yaml
sudo grep -A5 '^platform_toolsets:' /etc/hermes/config.yaml
sudo journalctl -u orcasynapse-hermes --since '15 minutes ago'
```

Expected managed settings include:

```yaml
memory:
  memory_enabled: true
  user_profile_enabled: true
  memory_char_limit: 2200
  user_char_limit: 1375

platform_toolsets:
  api_server:
    - no_mcp
    - memory
```

Do not open or copy `MEMORY.md` or `USER.md` merely to prove they exist. Verify
ownership and behavior, not their contents.

## Failure handling

- If a turn fails before Hermes accepts the native session stream, OrcaSynapse
  records a failed run and does not synthesize memory.
- If the worker loses its connection mid-turn, Hermes cancels that turn. The
  persisted transcript up to Hermes' committed boundary remains on VM2.
- If VM2 state is lost, re-enrollment restores execution but not prior native
  memory. Restore the VM2 backup if continuity is required.
- If the managed config lacks native memory after an upgrade, rerun the same
  VM2 installer. Repair mode preserves enrollment and adds the missing managed
  memory block idempotently.

## Rollback

The pre-transition product state is preserved at `backup/pgvector`. Rolling
back is a product decision, not a database toggle: deploy that branch and its
matching artifacts together. Do not simultaneously enable Hermes-native memory
and the old pgvector recall/capture worker, because two independent memory
owners will diverge.
