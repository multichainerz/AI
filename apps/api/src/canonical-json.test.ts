import { describe, expect, it } from "vitest";
import { assertSignableBody, canonicalize } from "./canonical-json.js";

/**
 * The runtime node installer signs request bodies with `jq -cS` and the control
 * plane verifies with `canonicalize`. Two implementations must agree byte for
 * byte or every signature fails, so the properties that keep them in agreement
 * are pinned here rather than left to hold by luck.
 */

describe("canonicalize", () => {
  it("sorts keys so field order cannot change the signature", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
    expect(canonicalize({ b: "y", a: "x" })).toBe('{"a":"x","b":"y"}');
  });

  it("matches jq -cS for the shapes real signed bodies use", () => {
    // The heartbeat body: strings, an enum, and an array of strings.
    expect(canonicalize({
      status: "ONLINE", observedAt: "2026-08-06T00:00:00.000Z",
      hermesVersion: "1.0.0", capabilities: ["gateway-api", "signed-heartbeat"],
    })).toBe(
      '{"capabilities":["gateway-api","signed-heartbeat"],"hermesVersion":"1.0.0"'
      + ',"observedAt":"2026-08-06T00:00:00.000Z","status":"ONLINE"}',
    );
    // The desired-state request signs over an absent body.
    expect(canonicalize(null)).toBe("null");
  });

  it("preserves array order, which is meaningful", () => {
    expect(canonicalize(["b", "a"])).toBe('["b","a"]');
  });
});

describe("assertSignableBody", () => {
  it("accepts the shapes signed bodies actually use", () => {
    expect(() => assertSignableBody(null)).not.toThrow();
    expect(() => assertSignableBody({ status: "ONLINE", capabilities: ["a"] })).not.toThrow();
    expect(() => assertSignableBody({ nested: { deep: ["x", null, true] } })).not.toThrow();
  });

  it("refuses a number, because jq and JSON.stringify disagree about them", () => {
    // JSON.stringify(1.0) is "1"; jq emits "1.0". A signature over one is not a
    // signature over the other, and the failure would surface as an
    // unexplainable authentication error on the node.
    expect(() => assertSignableBody({ uptime: 1.0 })).toThrow(/must not contain numbers/);
    expect(() => assertSignableBody({ nested: { count: 3 } })).toThrow(/nested\.count/);
    expect(() => assertSignableBody([{ n: 1 }])).toThrow(/\[0\]\.n/);
  });
});
