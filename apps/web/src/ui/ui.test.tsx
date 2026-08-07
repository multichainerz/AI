import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Alert, Button, EmptyState, Field, Input, LockedScreen, Metric, Panel, PanelHeading, Select, StatusText } from "./index.js";

/**
 * The primitives, and the one property that cannot be allowed to regress.
 *
 * `deploy/nginx/default.conf` sets `style-src 'self'` with no `'unsafe-inline'`,
 * so any inline `style` attribute is refused by the browser — and the dev server
 * sends no CSP header, which means a violation is invisible until it reaches a
 * built container. A test is the only thing that catches it in between.
 */

const markup = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);

describe("CSP safety", () => {
  it("renders no inline style attribute anywhere in the primitive set", () => {
    const html = markup(
      <div>
        <Button variant="primary">Go</Button>
        <Panel>
          <PanelHeading kicker="Kicker" title="Title" description="Description" />
          <Metric label="Queue" value="7" caption="documents" fill={0.42} tone="warn" />
          <StatusText tone="good">ready</StatusText>
          <Alert tone="error" onDismiss={vi.fn()}>Something failed</Alert>
          <EmptyState title="Nothing stored">No memory yet.</EmptyState>
          <Field label="Owner"><Input defaultValue="user:ada" /></Field>
          <Field label="Scope"><Select><option>STATIC</option></Select></Field>
        </Panel>
      </div>,
    );

    expect(html).not.toMatch(/\sstyle=/);
  });

  it("expresses a metric's fill as a progress value, not a width", () => {
    // The width of a bar is data. An inline width is the obvious way to say it
    // and the one way the CSP forbids, so it is an attribute on <progress>.
    const html = markup(<Metric label="Capacity" value="412" fill={0.65} />);
    expect(html).toContain("<progress");
    expect(html).toContain('value="65"');
    expect(html).toContain('max="100"');
    expect(html).not.toMatch(/\sstyle=/);
  });

  it("clamps a fill outside 0-1 rather than emitting an out-of-range bar", () => {
    expect(markup(<Metric label="x" value="1" fill={2.5} />)).toContain('value="100"');
    expect(markup(<Metric label="x" value="1" fill={-3} />)).toContain('value="0"');
  });

  it("omits the bar entirely when there is no fill to show", () => {
    expect(markup(<Metric label="Policy" value="Default deny" />)).not.toContain("<progress");
  });
});

describe("Button", () => {
  it("defaults to type=button so it cannot submit a form it merely sits inside", () => {
    expect(markup(<Button>Cancel</Button>)).toContain('type="button"');
  });

  it("still allows an explicit submit", () => {
    expect(markup(<Button type="submit">Save</Button>)).toContain('type="submit"');
  });

  it("lets a caller override a utility rather than fighting it", () => {
    // twMerge keeps the later class; without it both survive and the winner is
    // decided by stylesheet order, so a call site could not adjust anything.
    const html = markup(<Button size="md" className="h-16" />);
    expect(html).toContain("h-16");
    expect(html).not.toContain("h-9");
  });
});

describe("LockedScreen", () => {
  it("names the area so governance screens stay distinguishable", () => {
    const html = markup(
      <LockedScreen title="Memory" mark="M" actionLabel="Open platform settings" onAction={vi.fn()} />,
    );
    expect(html).toContain("<h1");
    expect(html).toContain("Memory");
    expect(html).toContain("Administrator session required");
    expect(html).toContain("Open platform settings");
  });

  it("says what it actually needs, which is not always an administrator", () => {
    // Chat, Knowledge and Agents also serve enterprise identities. Telling an
    // employee an administrator session is required sends them to a person
    // instead of to the sign-in they are entitled to use.
    const html = markup(
      <LockedScreen
        title="Knowledge"
        mark="KN"
        kicker="Enterprise knowledge"
        headline="Sign in to use Knowledge"
        actionLabel="Sign in with OrcaSynapse"
        onAction={vi.fn()}
      />,
    );
    expect(html).toContain("Sign in to use Knowledge");
    expect(html).not.toContain("Administrator session required");
    expect(html).toContain("Enterprise knowledge");
  });

  it("shows the second route only when there is one", () => {
    const both = markup(
      <LockedScreen
        title="Agents"
        mark="HA"
        actionLabel="Enterprise sign in"
        onAction={vi.fn()}
        secondaryLabel="Administrator setup"
        onSecondary={vi.fn()}
      />,
    );
    expect(both).toContain("Enterprise sign in");
    expect(both).toContain("Administrator setup");

    // A label with no handler is a button that does nothing, so it is not drawn.
    const orphan = markup(
      <LockedScreen title="Agents" mark="HA" actionLabel="Administrator setup" onAction={vi.fn()} secondaryLabel="Enterprise sign in" />,
    );
    expect(orphan).not.toContain("Enterprise sign in");
  });
});

describe("Alert", () => {
  it("offers dismissal only when there is somewhere for it to go", () => {
    expect(markup(<Alert onDismiss={vi.fn()}>Failed</Alert>)).toContain("Dismiss");
    expect(markup(<Alert>Failed</Alert>)).not.toContain("Dismiss");
  });

  it("carries the alert role so it is announced", () => {
    expect(markup(<Alert>Failed</Alert>)).toContain('role="alert"');
  });
});
