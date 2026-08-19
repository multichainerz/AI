/**
 * @vitest-environment jsdom
 *
 * The two ways every hand-rolled copy control was broken: over plain HTTP
 * `navigator.clipboard` does not exist, so the write threw into a void and
 * the button did nothing silently — and even where it worked, nothing on the
 * screen said so. This composition exists to make both impossible; these
 * cases hold it to that.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CopyButton } from "./copy-button.js";

afterEach(cleanup);

const writeText = vi.fn();
const execCommand = vi.fn();

/*
 * jsdom's navigator.clipboard is getter-only, and userEvent.setup() installs
 * a stub of its own — so each case pins the API state it means to test AFTER
 * setup, through defineProperty, or the assertion measures the wrong mock.
 */
function setClipboard(value: { writeText: typeof writeText } | undefined) {
  Object.defineProperty(navigator, "clipboard", { value, configurable: true });
}

beforeEach(() => {
  writeText.mockReset();
  execCommand.mockReset();
  document.execCommand = execCommand as never;
});

describe("CopyButton", () => {
  it("says Copied on the control itself once the write lands", async () => {
    writeText.mockResolvedValue(undefined);
    const user = userEvent.setup();
    setClipboard({ writeText });
    render(<CopyButton value="orcasynapse-agent update">Copy command</CopyButton>);

    await user.click(screen.getByRole("button", { name: "Copy command" }));

    expect(await screen.findByRole("button", { name: /Copied/ })).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith("orcasynapse-agent update");
    // And returns to its idle label rather than saying Copied forever.
    await waitFor(() => expect(screen.getByRole("button", { name: "Copy command" })).toBeTruthy(), { timeout: 3_000 });
  });

  it("still copies where navigator.clipboard does not exist, which is every plain-HTTP dashboard", async () => {
    // The exact state of an on-premise deployment read over http://<ip>: the
    // API is absent, not rejecting.
    execCommand.mockReturnValue(true);
    const user = userEvent.setup();
    setClipboard(undefined);
    render(<CopyButton value={() => "the claim"}>Copy claim</CopyButton>);

    await user.click(screen.getByRole("button", { name: "Copy claim" }));

    expect(await screen.findByRole("button", { name: /Copied/ })).toBeTruthy();
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("falls back to the legacy path when the modern write is refused", async () => {
    writeText.mockRejectedValue(new Error("Document is not focused."));
    execCommand.mockReturnValue(true);
    const user = userEvent.setup();
    setClipboard({ writeText });
    render(<CopyButton value="text">Copy</CopyButton>);

    await user.click(screen.getByRole("button", { name: "Copy" }));

    expect(await screen.findByRole("button", { name: /Copied/ })).toBeTruthy();
  });

  it("admits failure on the control when both paths refuse, instead of staying silent", async () => {
    execCommand.mockReturnValue(false);
    const user = userEvent.setup();
    setClipboard(undefined);
    render(<CopyButton value="text">Copy</CopyButton>);

    await user.click(screen.getByRole("button", { name: "Copy" }));

    expect(await screen.findByRole("button", { name: /Copy failed/ })).toBeTruthy();
  });

  it("keeps an icon-only control icon-only, with the outcome spoken for assistive tech", async () => {
    writeText.mockResolvedValue(undefined);
    const user = userEvent.setup();
    setClipboard({ writeText });
    render(<CopyButton value="the response" aria-label="Copy response" children={null} />);

    const control = screen.getByRole("button", { name: "Copy response" });
    await user.click(control);

    await waitFor(() => expect(control.textContent).toContain("Copied to the clipboard"));
    // The visible surface stays an icon: the status lives in the sr-only region.
    expect(control.querySelector(".sr-only")?.textContent).toBe("Copied to the clipboard");
  });
});
