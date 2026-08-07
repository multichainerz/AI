/**
 * @vitest-environment jsdom
 *
 * The VM2 installer generator. This panel was the one file the design-system
 * migration missed: its layout lived in `.setup-evidence-editor` and
 * `.setup-empty`, both deleted when styles.css was cut from 2,020 lines to 700,
 * and nothing here caught it because the file had no test at all.
 *
 * `VIEW_PREVIEW_OUT` dumps the rendered markup, as elsewhere.
 */
import type { HermesRuntimeNode } from "@orcasynapse/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const nodes: HermesRuntimeNode[] = [];

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<typeof import("./api.js")>("./api.js");
  return { ...actual, getHermesRuntimeNodes: vi.fn(async () => ({ items: nodes })) };
});

const { RuntimeNodesPanel } = await import("./runtime-nodes-panel.js");

async function panel(inferenceReady = true) {
  render(
    <main>
      <RuntimeNodesPanel
        targetEnvironment="DEVELOPMENT"
        inferenceReady={inferenceReady}
        onConfigureInference={vi.fn()}
        onSessionExpired={vi.fn()}
      />
    </main>,
  );
  await waitFor(() => screen.getByText(/Install the Agentic System on VM2|AI Inference must be ready first/));
  if (process.env.VIEW_PREVIEW_OUT) {
    writeFileSync(process.env.VIEW_PREVIEW_OUT, document.body.innerHTML, "utf8");
  }
}

afterEach(cleanup);

describe("the fresh-install state", () => {
  it("offers the installer once inference is ready", async () => {
    await panel();
    expect(screen.getByRole("button", { name: "Generate VM2 installer" })).toBeTruthy();
  });

  it("sends the operator to inference first when it is not", async () => {
    await panel(false);
    expect(screen.getByRole("button", { name: "Configure AI Inference" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Generate VM2 installer" })).toBeNull();
  });
});

describe("the installer generator", () => {
  async function open() {
    await panel();
    fireEvent.click(screen.getByRole("button", { name: "Generate VM2 installer" }));
    const dialog = await screen.findByRole("dialog");
    if (process.env.VIEW_PREVIEW_DIALOG_OUT) {
      writeFileSync(process.env.VIEW_PREVIEW_DIALOG_OUT, document.body.innerHTML, "utf8");
    }
    return dialog;
  }

  it("opens as a real dialog rather than a bare section", async () => {
    // The hand-rolled backdrop had no role, no focus trap and no Escape. Its
    // width and padding came from a stylesheet rule that no longer exists.
    const dialog = await open();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(within(dialog).getByText("Generate the VM2 installer")).toBeTruthy();
  });

  it("labels the address field so it cannot collide with its own input", async () => {
    const dialog = await open();
    const address = within(dialog).getByLabelText(/VM2 private address/);
    expect(address).toHaveProperty("tagName", "INPUT");
    expect(address).toHaveProperty("required", true);
  });

  it("keeps the submit reachable from the dialog footer", async () => {
    // The button moved out of the form into Drawer's footer, so it now needs
    // the form attribute to submit anything at all.
    const dialog = await open();
    const submit = within(dialog).getByRole("button", { name: "Generate install command" });
    expect(submit.getAttribute("form")).toBe("vm2-installer-form");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("closes on Escape, which the hand-rolled modal never did", async () => {
    const dialog = await open();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("renders no inline style, which the CSP would refuse in the built container", async () => {
    await open();
    expect(document.body.innerHTML).not.toMatch(/\sstyle="/);
  });
});
