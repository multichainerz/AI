/**
 * @vitest-environment jsdom
 *
 * The surviving descendant of the drawer's deleted sign-in form, and the only
 * way an enterprise employee reaches administrator scope without leaving the
 * workspace. Both cases below are promises the component makes in its own
 * description string and did not keep.
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminSignInDialog } from "./admin-sign-in-dialog.js";

const handlers = () => ({
  onClose: vi.fn(),
  onLogin: vi.fn(async () => true),
  onStartRecovery: vi.fn(async () => true),
});

afterEach(cleanup);

describe("elevating to administrator from inside the shell", () => {
  it("sends the typed credentials and closes on success", async () => {
    const user = userEvent.setup();
    const on = handlers();
    render(<AdminSignInDialog open busy={false} error={null} {...on} />);

    await user.type(screen.getByLabelText(/^password$/i), "a-long-enough-password");
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));

    expect(on.onLogin).toHaveBeenCalledWith("admin", "a-long-enough-password");
    expect(on.onClose).toHaveBeenCalled();
  });

  it("keeps no typed secret in state once it closes", async () => {
    /*
     * The dialog is unmounted by `open={false}`, not by React, so its state
     * survives a close — the password an operator typed stayed in memory for
     * the life of the page, and reopening the dialog re-displayed it. A
     * credential should not outlive the form that collected it.
     */
    const user = userEvent.setup();
    const on = handlers();
    const view = render(<AdminSignInDialog open busy={false} error={null} {...on} />);

    await user.type(screen.getByLabelText(/^password$/i), "a-long-enough-password");
    view.rerender(<AdminSignInDialog open={false} busy={false} error={null} {...on} />);
    view.rerender(<AdminSignInDialog open busy={false} error={null} {...on} />);

    expect(screen.getByLabelText(/^password$/i)).toHaveProperty("value", "");
  });

  it("warns before recovery, because recovery ends the workspace session", async () => {
    /*
     * An Installation Key session carries `passwordChangeRequired`, and the app
     * routes any such session to the front page — so the recovery path inside
     * this dialog evicts the very shell its description promises to preserve.
     * Stating that up front is the difference between a considered decision and
     * a surprise.
     */
    const user = userEvent.setup();
    render(<AdminSignInDialog open busy={false} error={null} {...handlers()} />);

    await user.click(screen.getByRole("button", { name: /use offline recovery key/i }));

    expect(screen.getByText(/leave this workspace|sign you out|return to the sign-in page/i)).toBeTruthy();
  });
});
