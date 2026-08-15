/**
 * @vitest-environment jsdom
 *
 * Two defects that lived in Setup's recovery block until it was extracted, both
 * of which a screenshot passes and a person does not.
 */
import type { OnboardingSnapshot } from "@orcasynapse/contracts";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  exportCredentialRecoveryKit: vi.fn(),
  verifyCredentialRecoveryKit: vi.fn(),
  getOnboardingSnapshot: vi.fn(),
}));

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<typeof import("./api.js")>("./api.js");
  return { ...actual, ...api };
});

const { RecoveryKitDialog } = await import("./recovery-kit-dialog.js");

const snapshot = {
  recovery: { recoveryOwner: "Platform owner", revision: 3 },
} as unknown as OnboardingSnapshot;

/*
 * jsdom's `File` implements neither `text()` nor `arrayBuffer()` — measured,
 * not assumed. Both are baseline browser APIs, so the gap is jsdom's rather
 * than the component's, and the shim is written over `FileReader`, which jsdom
 * does implement. `File.prototype.text` is still the method under test: a
 * component that called anything else would not be rescued by this.
 */
if (typeof File.prototype.text !== "function") {
  File.prototype.text = function readAsText(this: File) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error("unreadable"));
      reader.readAsText(this);
    });
  };
}

beforeEach(() => {
  api.exportCredentialRecoveryKit.mockReset();
  api.exportCredentialRecoveryKit.mockResolvedValue({
    fileName: "orcasynapse-recovery-2026-08-15.json",
    serializedKit: "{\"format\":\"orcasynapse-recovery/v1\"}",
  });
  api.getOnboardingSnapshot.mockReset();
  api.getOnboardingSnapshot.mockResolvedValue(snapshot);
  api.verifyCredentialRecoveryKit.mockReset();
  api.verifyCredentialRecoveryKit.mockResolvedValue(snapshot);
  // jsdom implements neither, and the export path calls both.
  Object.assign(URL, { createObjectURL: vi.fn(() => "blob:kit"), revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function open() {
  render(
    <RecoveryKitDialog
      open
      snapshot={snapshot}
      onClose={vi.fn()}
      onSnapshot={vi.fn()}
      onSessionExpired={vi.fn()}
    />,
  );
}

const LONG = "a-sufficiently-long-passphrase";

describe("the recovery kit dialog", () => {
  it("keeps the passphrase being chosen out of the one being checked", async () => {
    /*
     * Both forms shared a single `recoveryPassphrase`. Typing the passphrase
     * for a kit being created therefore also typed it into the field that is
     * supposed to prove you still know the passphrase of a kit you already
     * hold — which is not a cosmetic collision: it turns the verification into
     * a test of what was just typed rather than of what is on the disk.
     */
    const user = userEvent.setup();
    open();

    await user.type(screen.getByLabelText("Recovery passphrase"), LONG);

    expect(screen.getByLabelText("Recovery passphrase")).toHaveProperty("value", LONG);
    expect(screen.getByLabelText("Passphrase of the retained kit")).toHaveProperty("value", "");
  });

  it("keeps the verification passphrase out of the export form too", async () => {
    const user = userEvent.setup();
    open();

    await user.type(screen.getByLabelText("Passphrase of the retained kit"), LONG);

    expect(screen.getByLabelText("Recovery passphrase")).toHaveProperty("value", "");
    expect(screen.getByLabelText("Confirm passphrase")).toHaveProperty("value", "");
  });

  it("does not label the file picker with a file it has not been given", async () => {
    /*
     * `exportRecovery` wrote the exported file's name into the picker's label
     * and cleared the kit in the same breath, so the control read like a file
     * was selected while Verify stayed disabled because none was. The exported
     * name is worth reporting; it is just not a selection.
     */
    const user = userEvent.setup();
    open();

    await user.type(screen.getByLabelText("Recovery passphrase"), LONG);
    await user.type(screen.getByLabelText("Confirm passphrase"), LONG);
    await user.click(screen.getByRole("button", { name: "Export recovery kit" }));

    await waitFor(() => expect(screen.getByText(/Saved as orcasynapse-recovery/)).toBeTruthy());
    // The picker still asks for a file, because it still has none.
    expect(screen.getByText("Select the saved recovery kit")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Verify recovery kit" })).toHaveProperty("disabled", true);
  });

  it("labels the picker and enables verification once a kit is actually chosen", async () => {
    /*
     * The positive control for the case above. Without it, "the label does not
     * name a file" would pass against a picker that can never name one.
     */
    const user = userEvent.setup();
    open();

    const picker = screen.getByText("Select the saved recovery kit")
      .closest("label")
      ?.querySelector("input[type=file]") as HTMLInputElement;
    await user.upload(picker, new File(["{\"format\":\"orcasynapse-recovery/v1\"}"], "retained-kit.json", { type: "application/json" }));

    await waitFor(() => expect(screen.getByText("retained-kit.json")).toBeTruthy());
    await user.type(screen.getByLabelText("Passphrase of the retained kit"), LONG);

    expect(screen.getByRole("button", { name: "Verify recovery kit" })).toHaveProperty("disabled", false);
  });

  it("sends the retained kit's own passphrase to verification, not the export one", async () => {
    const user = userEvent.setup();
    open();

    await user.type(screen.getByLabelText("Recovery passphrase"), "export-side-passphrase");
    const picker = screen.getByText("Select the saved recovery kit")
      .closest("label")
      ?.querySelector("input[type=file]") as HTMLInputElement;
    await user.upload(picker, new File(["{\"format\":\"orcasynapse-recovery/v1\"}"], "retained-kit.json", { type: "application/json" }));
    await waitFor(() => expect(screen.getByText("retained-kit.json")).toBeTruthy());
    await user.type(screen.getByLabelText("Passphrase of the retained kit"), "retained-side-passphrase");
    await user.click(screen.getByRole("button", { name: "Verify recovery kit" }));

    await waitFor(() => expect(api.verifyCredentialRecoveryKit).toHaveBeenCalled());
    expect(api.verifyCredentialRecoveryKit.mock.calls[0]?.[0]).toMatchObject({
      passphrase: "retained-side-passphrase",
      expectedRevision: 3,
    });
  });

  it("renders no inline style, which the CSP would refuse in the built container", () => {
    open();
    expect(document.body.innerHTML).not.toMatch(/\sstyle="/);
  });
});
