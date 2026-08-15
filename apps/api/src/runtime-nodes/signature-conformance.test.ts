import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * The node request signature has five implementations in three languages: the
 * verifier in `drizzle-runtime-node-manager.ts`, three signers in
 * `install-agentic-node.sh` (the enrollment-time heartbeat, the heartbeat unit
 * installed on VM2, and the desired-state client), and one in
 * `hermes-corpus-reconciler.py`. They agree by construction only.
 *
 * Nothing else in the suite catches them drifting. `test-agentic-installer-
 * smoke.sh` runs a real enrollment against a stub control plane, but that stub
 * returns canned responses and never verifies an inbound node signature — it
 * only proves the *reverse* direction, that the node can verify a document the
 * control plane signed. So a signer and the verifier could disagree on the
 * signed bytes, every test would stay green, and enrollment would fail on the
 * first real VM2 with an opaque 401.
 *
 * This asserts the shape all four must share: five newline-separated fields in
 * the order method, path, timestamp, nonce, body-digest. It cannot prove the
 * runtime values match, but it does catch a field being added, dropped or
 * reordered on one side — which is the way this actually breaks.
 */

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const read = (path: string) => readFileSync(join(repositoryRoot, path), "utf8");

describe("node request signature conformance", () => {
  it("builds the same five fields in the verifier and in every client signer", () => {
    const verifier = read("apps/api/src/runtime-nodes/drizzle-runtime-node-manager.ts");
    const installer = read("scripts/install-agentic-node.sh");
    const reconciler = read("scripts/hermes-corpus-reconciler.py");

    // The verifier, as a template literal.
    expect(verifier).toContain(
      "`${method.toUpperCase()}\\n${path}\\n${timestamp}\\n${nonce}\\n${checksum(body)}`",
    );

    // All three shell signers, as a five-placeholder printf with the same
    // argument order. The count is pinned so a fourth signer added without the
    // method and path fails here rather than in the field.
    const shellFormat = /printf '%s\\n%s\\n%s\\n%s\\n%s' "\$\{method\}" "\$\{path\}" "\$\{timestamp\}" "\$\{nonce\}" "\$\{body_digest\}"/g;
    expect(installer.match(shellFormat) ?? []).toHaveLength(3);

    // The Python signer, as an f-string.
    expect(reconciler).toContain('f"{method.upper()}\\n{path}\\n{timestamp}\\n{nonce}\\n{digest}"');
  });

  it("reads the real files rather than passing on an empty match", () => {
    // Guards the case that would make every assertion above vacuous: a moved or
    // renamed file read as an empty string.
    expect(read("scripts/install-agentic-node.sh").length).toBeGreaterThan(10_000);
    expect(read("scripts/hermes-corpus-reconciler.py").length).toBeGreaterThan(5_000);
  });
});
