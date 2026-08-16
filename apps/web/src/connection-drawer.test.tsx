/**
 * @vitest-environment jsdom
 *
 * jsdom rather than node because the slug case below has to be typed: a
 * keystroke-by-keystroke rewrite is invisible to static markup.
 */
import type { ComponentProps } from "react";
import type { InferenceDiscoveryResult, ServiceConnectionSummary } from "@orcasynapse/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionDrawer, type ConnectionDraft } from "./connection-drawer.js";

describe("ConnectionDrawer inference endpoint", () => {
  it("renders a guided discovery flow and keeps manual fields behind an advanced control", () => {
    const html = renderToStaticMarkup(<ConnectionDrawer
      busy={false}
      connections={[]}
      monitoring={null}
      error={null}
      diagnostic={null}
      initialKind="INFERENCE"
      open
      revisionConnectionId={null}
      revisionHistory={null}
      onClose={vi.fn()}
      onOpenAgenticSystem={vi.fn()}
      onSave={vi.fn(async () => undefined)}
      onTest={vi.fn(async () => undefined)}
      onDiscoverInference={vi.fn(async () => null)}
      onUpdateMonitoring={vi.fn(async () => undefined)}
      onLoadRevisions={vi.fn(async () => undefined)}
      onRollback={vi.fn(async () => undefined)}
    />);

    expect(html).toContain("Connect a model server");
    expect(html).toContain("AI Inference address");
    expect(html).toContain("Discover server");
    expect(html).not.toContain("Enable after saving");
    expect(html).toContain("Advanced configuration");
    expect(html).not.toContain("Endpoint suggestion");
    expect(html).not.toContain("Serving implementation");
    expect(html).toContain("Agentic System");
    expect(html).not.toContain(">Hermes<");
    expect(html).not.toContain("Configuration history");
  });
});

const props: Omit<ComponentProps<typeof ConnectionDrawer>, "initialKind"> = {
  busy: false,
  connections: [],
  monitoring: null,
  error: null,
  diagnostic: null,
  open: true,
  revisionConnectionId: null,
  revisionHistory: null,
  onClose: vi.fn(),
  onOpenAgenticSystem: vi.fn(),
  onSave: vi.fn(async () => undefined),
  onTest: vi.fn(async () => undefined),
  onDiscoverInference: vi.fn(async () => null),
  onUpdateMonitoring: vi.fn(async () => undefined),
  onLoadRevisions: vi.fn(async () => undefined),
  onRollback: vi.fn(async () => undefined),
};

/**
 * Types one character at a time, which is the only way a keystroke-by-keystroke
 * rewrite can be observed. Setting the whole string at once hides it.
 */
function typeInto(input: HTMLElement, text: string) {
  const control = input as HTMLInputElement;
  for (const character of text) {
    fireEvent.change(control, { target: { value: control.value + character } });
  }
}

function slugField(): HTMLElement {
  render(<ConnectionDrawer {...props} initialKind="OIDC" />);
  const slug = screen.getByLabelText("Slug");
  fireEvent.change(slug, { target: { value: "" } });
  return slug;
}

afterEach(cleanup);

/** A production inference connection that is up and admitted right now. */
const liveInference: ServiceConnectionSummary = {
  id: "0f8b1f4c-4a2e-4a4a-9d3c-2f6c1a5b7e90",
  slug: "vllm-primary",
  displayName: "AI Inference Primary",
  kind: "INFERENCE",
  environment: "PRODUCTION",
  baseUrl: "http://gpu-server.internal:8000/v1",
  enabled: true,
  status: "HEALTHY",
  configuration: { inferenceBackend: "VLLM", modelAlias: "hermes-agent" },
  activeRevision: 3,
  secretFieldNames: ["apiKey"],
  lastHealthcheckAt: "2026-08-14T00:00:00.000Z",
  lastHealthcheckMessage: "Answering within budget.",
  updatedAt: "2026-08-14T00:00:00.000Z",
};

/** A probe that came back with something less than a clean bill of health. */
const partialDiscovery: InferenceDiscoveryResult = {
  status: "PARTIAL",
  message: "The model list answered; the health path did not.",
  normalizedBaseUrl: "http://gpu-server.internal:8000/v1",
  backend: "VLLM",
  backendConfidence: "HIGH",
  backendEvidence: ["Server header names vLLM."],
  models: [{ id: "hermes-agent" }],
  recommended: {
    baseUrl: "http://gpu-server.internal:8000/v1",
    inferenceBackend: "VLLM",
    healthPath: null,
    modelsPath: "/models",
    chatPath: "/chat/completions",
    modelAlias: "hermes-agent",
  },
  probes: [{
    key: "health", label: "Health", path: "/health", status: "FAILED",
    httpStatus: null, latencyMs: 8_000, message: "No response.",
  }],
};

describe("discovering an endpoint that is already live", () => {
  it("does not disable a working connection because one probe failed", async () => {
    /*
     * The whole path: `Discover server` used to assign `enabled` from the
     * discovery status, so a PARTIAL, AUTH_REQUIRED or UNREACHABLE result set
     * it false on a connection that was serving chat a second earlier. Saving
     * then took `app.tsx`'s inactive branch -- write `enabled: false`, skip the
     * test-and-reactivate entirely -- and INFERENCE has no `enabled` control on
     * this form, so nothing on screen said what had happened or offered a way
     * back short of a HEALTHY "Test & activate".
     *
     * A probe is evidence about a moment; admission is a decision. Discovery
     * may raise one, never lower it.
     */
    // Typed, so `mock.calls[0][0]` is the draft rather than an empty tuple: an
    // untyped `vi.fn` has no parameters to index into and the assertion below
    // would not compile.
    const onSave = vi.fn<(draft: ConnectionDraft) => Promise<void>>(async () => undefined);
    render(<ConnectionDrawer
      {...props}
      initialKind="INFERENCE"
      connections={[liveInference]}
      onSave={onSave}
      onDiscoverInference={vi.fn(async () => partialDiscovery)}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Discover server" }));
    // The result is on screen, so the submit below is the one that follows a
    // completed discovery rather than one that raced it.
    await screen.findByText("The model list answered; the health path did not.");

    fireEvent.click(screen.getByRole("button", { name: /Save changes|Activate AI Inference/ }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]![0]).toMatchObject({ existingId: liveInference.id, enabled: true });
  });

  it("still turns a new connection on when discovery comes back ready", async () => {
    // The other half of "raise, never lower": a never-admitted endpoint that
    // answers everything is exactly what the guided flow exists to activate.
    // Typed, so `mock.calls[0][0]` is the draft rather than an empty tuple: an
    // untyped `vi.fn` has no parameters to index into and the assertion below
    // would not compile.
    const onSave = vi.fn<(draft: ConnectionDraft) => Promise<void>>(async () => undefined);
    render(<ConnectionDrawer
      {...props}
      initialKind="INFERENCE"
      onSave={onSave}
      onDiscoverInference={vi.fn(async () => ({ ...partialDiscovery, status: "READY" as const }))}
    />);

    fireEvent.change(screen.getByLabelText(/AI Inference address/), {
      target: { value: "http://gpu-server.internal:8000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Discover server" }));
    const submit = await screen.findByRole("button", { name: "Activate AI Inference" });

    fireEvent.click(submit);
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]![0]).toMatchObject({ enabled: true });
  });
});

describe("naming a connection", () => {
  it("lets a hyphen be typed into the slug, because the seeded slug has one", () => {
    // Trimming the trailing hyphen on each keystroke deletes the separator
    // before the next character arrives, so 'enterpriseaccess-primary' would be
    // unreachable by typing.
    const slug = slugField();
    typeInto(slug, "enterpriseaccess-primary");
    expect(slug).toHaveProperty("value", "enterpriseaccess-primary");
  });

  it("trims a half-typed trailing hyphen when the field is left", () => {
    const slug = slugField();
    typeInto(slug, "enterpriseaccess-");
    fireEvent.blur(slug);
    expect(slug).toHaveProperty("value", "enterpriseaccess");
  });

  it("sends a valid slug even when the operator left a trailing hyphen", () => {
    const slug = slugField();
    typeInto(slug, "enterpriseaccess-primary-");
    fireEvent.submit(slug.closest("form")!);
    expect(props.onSave).toHaveBeenCalledWith(expect.objectContaining({
      slug: "enterpriseaccess-primary",
    }));
  });
});
