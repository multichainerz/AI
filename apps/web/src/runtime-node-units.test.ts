import type { HermesRuntimeNode } from "@orcasynapse/contracts";
import { describe, expect, it } from "vitest";
import { unhealthyUnits } from "./runtime-nodes-panel.js";

/*
 * Which of a node's systemd units are not doing their job.
 *
 * The case worth protecting is the third answer: a node that has never reported
 * units is not a healthy node, and if "unknown" ever collapses into "fine" the
 * panel goes back to being unable to say why an enrolled node is silent -- which
 * is the whole reason this exists.
 */

const node = (units: HermesRuntimeNode["units"]): HermesRuntimeNode =>
  ({ units } as HermesRuntimeNode);

const unit = (name: string, active: boolean, enabled: boolean) => ({ name, active, enabled });

describe("unhealthyUnits", () => {
  it("returns null when the node has never reported, not an empty list", () => {
    expect(unhealthyUnits(node(null))).toBeNull();
  });

  it("returns an empty list when everything is running and enabled", () => {
    expect(unhealthyUnits(node([
      unit("orcasynapse-hermes.service", true, true),
      unit("orcasynapse-hermes-corpus.timer", true, true),
    ]))).toEqual([]);
  });

  it("names a stopped unit and says it is inactive", () => {
    expect(unhealthyUnits(node([
      unit("orcasynapse-hermes.service", true, true),
      unit("orcasynapse-hermes-corpus.timer", false, true),
    ]))).toEqual(["orcasynapse-hermes-corpus.timer (inactive)"]);
  });

  /*
   * A different fault with a different fix: this one is running now and will be
   * gone after a reboot. Reporting it as healthy is how a node comes back from
   * maintenance silently degraded.
   */
  it("names a running-but-disabled unit separately", () => {
    expect(unhealthyUnits(node([
      unit("orcasynapse-hermes-heartbeat.timer", true, false),
    ]))).toEqual(["orcasynapse-hermes-heartbeat.timer (not enabled)"]);
  });

  it("reports every failing unit rather than the first", () => {
    expect(unhealthyUnits(node([
      unit("orcasynapse-hermes.service", false, true),
      unit("orcasynapse-hermes-corpus.timer", false, true),
      unit("orcasynapse-hermes-desired-state.timer", true, true),
    ]))).toEqual([
      "orcasynapse-hermes.service (inactive)",
      "orcasynapse-hermes-corpus.timer (inactive)",
    ]);
  });

  it("treats an inactive unit as inactive even when it is also not enabled", () => {
    // One label per unit; "inactive" is the one that needs acting on first.
    expect(unhealthyUnits(node([unit("a.timer", false, false)]))).toEqual(["a.timer (inactive)"]);
  });
});
