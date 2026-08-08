/**
 * @vitest-environment jsdom
 *
 * jsdom rather than node because the slug case below has to be typed: a
 * keystroke-by-keystroke rewrite is invisible to static markup.
 */
import type { ComponentProps } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionDrawer } from "./connection-drawer.js";

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
    expect(html).not.toContain(">Supermemory<");
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
