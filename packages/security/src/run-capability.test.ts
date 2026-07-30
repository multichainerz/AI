import { describe, expect, it } from "vitest";
import { RunCapabilityIssuer } from "./run-capability.js";

describe("RunCapabilityIssuer", () => {
  it("reproduces a retry-safe token while separating runs", () => {
    const issuer = new RunCapabilityIssuer(Buffer.alloc(32, 7));
    const first = issuer.issue("8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d");
    const retry = issuer.issue("8aa8e0fd-bebe-4de3-ab0a-f5e1170cf10d");
    const other = issuer.issue("6cf6ce1b-a8c6-49d7-b6aa-019d35888acb");
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(retry).toEqual(first);
    expect(other.token).not.toBe(first.token);
    expect(Buffer.from(first.tokenHash)).toHaveLength(32);
  });

  it("rejects invalid IDs before deriving any capability", () => {
    expect(() => new RunCapabilityIssuer(Buffer.alloc(32)).issue("not-a-run")).toThrow("valid run ID");
  });
});
