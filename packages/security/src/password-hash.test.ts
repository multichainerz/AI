import { describe, expect, it } from "vitest";
import {
  DUMMY_PASSWORD_DIGEST,
  hashLocalPassword,
  localPasswordIsValid,
  localPasswordNeedsRehash,
  verifyLocalPassword,
} from "./password-hash.js";

describe("local administrator password hashing", () => {
  it("stores a salted scrypt digest and verifies only the original password", async () => {
    const password = "Correct horse battery staple 2026";
    const first = await hashLocalPassword(password, Buffer.alloc(16, 1));
    const second = await hashLocalPassword(password, Buffer.alloc(16, 2));

    expect(first).toMatch(/^scrypt\$131072\$8\$1\$/);
    expect(first).not.toBe(second);
    await expect(verifyLocalPassword(password, first)).resolves.toBe(true);
    await expect(verifyLocalPassword("incorrect password", first)).resolves.toBe(false);
    expect(localPasswordNeedsRehash(first)).toBe(false);
  }, 20_000);

  it("fails closed for malformed digests while retaining the expensive verification path", async () => {
    await expect(verifyLocalPassword("any supplied password", "not-a-digest")).resolves.toBe(false);
    await expect(verifyLocalPassword("any supplied password", DUMMY_PASSWORD_DIGEST)).resolves.toBe(false);
  }, 20_000);

  it("enforces the bounded password policy", () => {
    expect(localPasswordIsValid("too-short")).toBe(false);
    expect(localPasswordIsValid("long-enough-password")).toBe(true);
    expect(localPasswordIsValid("x".repeat(1_025))).toBe(false);
  });
});
