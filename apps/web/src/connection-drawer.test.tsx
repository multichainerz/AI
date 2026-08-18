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
  it("renders a guided discovery flow without manual path overrides", () => {
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
      onLoadInferenceCatalogue={vi.fn(async () => null)}
      onUpdateMonitoring={vi.fn(async () => undefined)}
      onLoadRevisions={vi.fn(async () => undefined)}
      onRollback={vi.fn(async () => undefined)}
    />);

    expect(html).toContain("Connect a model server");
    expect(html).toContain("Local server");
    expect(html).toContain("OpenRouter");
    expect(html).toContain("Public endpoint");
    expect(html).toContain("role=\"radiogroup\"");
    expect(html).toContain("AI Inference address");
    expect(html).toContain("Discover server");
    expect(html).not.toContain("Enable after saving");
    expect(html).not.toContain("Advanced configuration");
    expect(html).not.toContain("Endpoint suggestion");
    expect(html).not.toContain("Serving implementation");
    expect(html).not.toContain("Health path");
    expect(html).not.toContain("Models path");
    expect(html).toContain("Agentic System");
    expect(html).not.toContain(">Hermes<");
    expect(html).not.toContain("Configuration history");
  });

  it("renders the inference editor in place when Setup embeds it", () => {
    const html = renderToStaticMarkup(<ConnectionDrawer
      {...props}
      initialKind="INFERENCE"
      embedded
    />);

    expect(html).toContain("AI Inference address");
    expect(html).toContain("Discover server");
    expect(html).toContain("id=\"connection-form\"");
    expect(html).not.toContain("role=\"dialog\"");
    expect(html).not.toContain("Agentic System");
    expect(html).not.toContain("Connect a model server");
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
  onLoadInferenceCatalogue: vi.fn(async () => null),
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

describe("OpenRouter endpoint mode", () => {
  it("hides local discovery and requires a key", () => {
    render(<ConnectionDrawer {...props} initialKind="INFERENCE" />);
    fireEvent.click(screen.getByRole("radio", { name: /Public endpoint/ }));

    expect(screen.queryByLabelText(/AI Inference address/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Discover server" })).toBeNull();
    expect(screen.getByLabelText(/OpenRouter API key/)).toBeTruthy();
    expect(screen.getByText(/leave this environment/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Verify key and load models" })).toHaveProperty("disabled", true);
    expect(screen.queryByText("Advanced configuration")).toBeNull();
    expect(screen.queryByText("Serving implementation")).toBeNull();
  });

  it("pins the OpenRouter origin and paths on save", async () => {
    const onSave = vi.fn<(draft: ConnectionDraft) => Promise<void>>(async () => undefined);
    render(<ConnectionDrawer
      {...props}
      initialKind="INFERENCE"
      onSave={onSave}
      onLoadInferenceCatalogue={vi.fn(async () => ({
        provider: "openrouter" as const,
        models: [
          { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4" },
          { id: "openai/gpt-5.6-sol" },
        ],
        key: { label: "pilot" },
      }))}
    />);

    fireEvent.click(screen.getByRole("radio", { name: /Public endpoint/ }));
    fireEvent.change(screen.getByLabelText(/OpenRouter API key/), { target: { value: "sk-or-v1-test" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify key and load models" }));
    await screen.findByText(/models available/);
    fireEvent.click(screen.getByRole("button", { name: "Activate AI Inference" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]![0]).toMatchObject({
      baseUrl: "https://openrouter.ai",
      enabled: true,
      configuration: {
        inferenceBackend: "CUSTOM_OPENAI_COMPATIBLE",
        modelsPath: "/api/v1/models",
        healthPath: "/api/v1/models",
        chatPath: "/api/v1/chat/completions",
        modelAlias: "anthropic/claude-sonnet-4",
      },
      secrets: { apiKey: "sk-or-v1-test" },
    });
  });

  it("updates the existing inference row rather than creating a second connection", async () => {
    const onSave = vi.fn<(draft: ConnectionDraft) => Promise<void>>(async () => undefined);
    render(<ConnectionDrawer
      {...props}
      initialKind="INFERENCE"
      connections={[liveInference]}
      onSave={onSave}
    />);

    fireEvent.click(screen.getByRole("radio", { name: /Public endpoint/ }));
    fireEvent.change(screen.getByLabelText(/OpenRouter API key/), { target: { value: "sk-or-v1-test" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]![0]).toMatchObject({
      existingId: liveInference.id,
      baseUrl: "https://openrouter.ai",
    });
  });

  it("keeps what the operator typed when the background poll re-delivers the same connection", () => {
    /*
     * The workspace re-reads connections every 15 seconds and hands down a
     * freshly parsed array, so the `.find()` that locates this connection
     * returned a new object every tick even when the row had not changed.
     * The seeding effect depended on that object, `Object.is` failed, and it
     * re-seeded twelve pieces of state under whoever was typing — blanking the
     * API key field, greying out "Verify key and load models" because it is
     * disabled on empty, and dropping any typed configuration back to defaults.
     * A rotated secret pasted in and not yet saved was simply gone.
     *
     * Re-rendering with an equal-but-not-identical array is exactly what the
     * poll does; the typed value has to survive it.
     */
    const { rerender } = render(<ConnectionDrawer
      {...props}
      initialKind="INFERENCE"
      connections={[liveInference]}
    />);
    fireEvent.click(screen.getByRole("radio", { name: /Public endpoint/ }));
    fireEvent.change(screen.getByLabelText(/OpenRouter API key/), { target: { value: "sk-or-v1-rotated" } });

    // One poll tick: same row, new array and new object identity.
    rerender(<ConnectionDrawer
      {...props}
      initialKind="INFERENCE"
      connections={[{ ...liveInference }]}
    />);

    // The secret survives, and so does the endpoint mode the operator chose --
    // the effect reset both.
    expect((screen.getByLabelText(/OpenRouter API key/) as HTMLInputElement).value).toBe("sk-or-v1-rotated");
  });

  it("re-seeds the form when the connection itself actually changed", () => {
    // The other half of the same behaviour: the effect must still fire when the
    // server reports the row changed, or the drawer would show a stale endpoint
    // after somebody else saved one.
    const { rerender } = render(<ConnectionDrawer
      {...props}
      initialKind="INFERENCE"
      connections={[liveInference]}
    />);
    expect((screen.getByLabelText(/AI Inference address/) as HTMLInputElement).value)
      .toBe(liveInference.baseUrl);

    rerender(<ConnectionDrawer
      {...props}
      initialKind="INFERENCE"
      connections={[{
        ...liveInference,
        baseUrl: "http://gpu-two.internal:8000/v1",
        updatedAt: "2026-08-15T00:00:00.000Z",
      }]}
    />);

    expect((screen.getByLabelText(/AI Inference address/) as HTMLInputElement).value)
      .toBe("http://gpu-two.internal:8000/v1");
  });
});

describe("local inference auto-configuration", () => {
  it("refuses to save a new local connection until discovery has read the server", async () => {
    const onSave = vi.fn<(draft: ConnectionDraft) => Promise<void>>(async () => undefined);
    render(<ConnectionDrawer {...props} initialKind="INFERENCE" onSave={onSave} />);

    fireEvent.change(screen.getByLabelText(/AI Inference address/), {
      target: { value: "http://gpu-server.internal:8000" },
    });
    expect(screen.getByRole("button", { name: "Create connection" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Create connection" }));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("writes discovered backend and paths on save instead of the form defaults", async () => {
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
    fireEvent.click(await screen.findByRole("button", { name: "Activate AI Inference" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]![0]).toMatchObject({
      baseUrl: "http://gpu-server.internal:8000/v1",
      configuration: {
        inferenceBackend: "VLLM",
        modelsPath: "/models",
        chatPath: "/chat/completions",
        modelAlias: "hermes-agent",
      },
    });
  });
});
