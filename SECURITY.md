# Security Policy

OrcaSynapse is an on-premises control plane for private AI operations. Its
security posture depends on the enrollment cryptography between VM1 and VM2,
envelope encryption of stored secrets, and the session model of the dashboard
— reports touching any of those are especially valuable.

## Reporting a vulnerability

Report vulnerabilities privately to **ops@sivali.co.id**. Do not open a public
issue for a security report.

Include what you can of:

- the affected surface (API route, installer script, enrollment flow, dashboard view),
- the version (`ai-vX.Y.Z` from the release tag, the installer banner, or `packages/contracts/src/version.ts`),
- reproduction steps or a proof of concept,
- your assessment of impact.

You will receive an acknowledgement within five business days. Please allow a
reasonable window for a fix to ship before public disclosure; we will credit
reporters in the release notes unless you prefer otherwise.

## Supported versions

Only the latest release receives security fixes. Releases are frequent and
upgrading is a re-run of the pinned installer, so there is no maintained LTS
branch.

## Scope notes

- **In scope:** the Fastify API, the React dashboard, the worker, the
  installer scripts (`install.sh`, `scripts/*.sh`), the Ed25519 node
  enrollment and signed-heartbeat scheme, envelope encryption of secret
  records, session and scope enforcement, guardrail bypasses, the inference
  gateway, the pgvector knowledge and agent-memory planes and their owner
  scoping, and the audit trail / SIEM forwarding path.
- **Out of scope:** vulnerabilities in Hermes or your inference server itself
  (report those upstream), denial of service against your own
  deployment, and findings that require an already-compromised root account on
  VM1 or VM2.

## Handling expectations

Never include live credentials in a report: no node private keys, Installation
Keys, administrator passwords, database URLs, or enrollment claims. Redact environment files and logs before attaching them.
