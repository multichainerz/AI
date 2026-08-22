import { describe, expect, it } from "vitest";
import { setupLockActive, setupLockStep, viewAllowedDuringSetupLock } from "./setup-lock.js";

const locked = {
  inferenceReady: false,
  agentModelReady: false,
  agenticInfrastructureReady: false,
};

describe("setupLockActive", () => {
  it("holds the operator on Setup until the runtime step is done", () => {
    expect(setupLockActive(locked)).toBe(true);
    expect(setupLockActive({ ...locked, inferenceReady: true })).toBe(true);
    expect(setupLockActive({ ...locked, inferenceReady: true, agentModelReady: true })).toBe(true);
    expect(setupLockActive({
      inferenceReady: true,
      agentModelReady: true,
      agenticInfrastructureReady: true,
    })).toBe(false);
  });
});

describe("viewAllowedDuringSetupLock", () => {
  it("allows only Setup", () => {
    expect(viewAllowedDuringSetupLock("Deployment")).toBe(true);
    expect(viewAllowedDuringSetupLock("Overview")).toBe(false);
    expect(viewAllowedDuringSetupLock("Chat")).toBe(false);
    expect(viewAllowedDuringSetupLock("Agents")).toBe(false);
    expect(viewAllowedDuringSetupLock("Models")).toBe(false);
  });
});

describe("setupLockStep", () => {
  it("opens inference until that step is done, then the runtime step", () => {
    expect(setupLockStep({ inferenceReady: false })).toBe("inference");
    expect(setupLockStep({ inferenceReady: true })).toBe("runtime");
  });
});
