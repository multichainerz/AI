import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Alert, Button, EmptyState, Field, Input, LockedScreen, HeroBanner, Metric, PageHeader, Panel, PanelHeading, Select, StatusText } from "./index.js";

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
          <Metric label="Queue" value="7" caption="runs" tone="warn" />
          <StatusText tone="good">ready</StatusText>
          <Alert tone="error" onDismiss={vi.fn()}>Something failed</Alert>
          <EmptyState title="Nothing stored">No runs yet.</EmptyState>
          <Field label="Owner"><Input defaultValue="user:ada" /></Field>
          <Field label="Scope"><Select><option>STATIC</option></Select></Field>
        </Panel>
      </div>,
    );

    expect(html).not.toMatch(/\sstyle=/);
  });

  it("expresses a highlight's fill as a progress value, not a width", () => {
    // The width of a bar is data. An inline width is the obvious way to say it
    // and the one way the CSP forbids, so it is an attribute on <progress>.
    // The bar lives on HeroBanner: it belongs to a figure with a denominator,
    // and every such figure on this product is a screen's headline stat.
    const html = markup(<HeroBanner tone="plain" highlight={{ label: "Capacity", value: "412", fill: 0.65 }} metrics={[]} />);
    expect(html).toContain("<progress");
    expect(html).toContain('value="65"');
    expect(html).toContain('max="100"');
    expect(html).not.toMatch(/\sstyle=/);
  });

  it("clamps a fill outside 0-1 rather than emitting an out-of-range bar", () => {
    const bar = (fill: number) => markup(<HeroBanner tone="plain" highlight={{ label: "x", value: "1", fill }} metrics={[]} />);
    expect(bar(2.5)).toContain('value="100"');
    expect(bar(-3)).toContain('value="0"');
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
      <LockedScreen title="Prompts" mark="P" actionLabel="Open platform settings" onAction={vi.fn()} />,
    );
    expect(html).toContain("<h1");
    expect(html).toContain("Prompts");
    expect(html).toContain("Administrator session required");
    expect(html).toContain("Open platform settings");
  });

  it("says what it actually needs, which is not always an administrator", () => {
    // Session and Agents also serve enterprise identities. Telling an
    // employee an administrator session is required sends them to a person
    // instead of to the sign-in they are entitled to use.
    const html = markup(
      <LockedScreen
        title="Session"
        mark="SE"
        kicker="Enterprise session"
        headline="Sign in to use Session"
        actionLabel="Sign in with OrcaSynapse"
        onAction={vi.fn()}
      />,
    );
    expect(html).toContain("Sign in to use Session");
    expect(html).not.toContain("Administrator session required");
    expect(html).toContain("Enterprise session");
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

  it("sets its title at the page-title size rather than a stock Tailwind step", () => {
    /*
     * The locked screen is a whole screen, and its <h1> is that screen's page
     * title — the same role PageHeader's <h1> plays on the unlocked view it
     * stands in for. It was set in `text-xl`: 20px, the one stock font-size
     * utility left in the product, on no step of the OrcaNeuron scale, so
     * unlocking an area shifted the heading six pixels. Read off PageHeader
     * rather than written out here, so the two cannot drift apart again.
     */
    const titleSize = (html: string) =>
      // `\b` cannot close an arbitrary value: the character before the space is
      // `]`, which is not a word character, so there is no boundary to match.
      /\btext-(\[[^\]]+\]|xs|sm|base|lg|[2-9]?xl)(?![\w-])/.exec(/<h1[^>]*class="([^"]*)"/.exec(html)?.[1] ?? "")?.[1];

    const locked = markup(<LockedScreen title="Prompts" mark="P" actionLabel="Open" onAction={vi.fn()} />);
    expect(titleSize(locked)).toBeDefined();
    expect(titleSize(locked)).toBe(titleSize(markup(<PageHeader title="Prompts" />)));
  });
});

describe("Metric", () => {
  it("has one figure size, in a hero banner and standing on its own", () => {
    /*
     * `size` was a two-branch variant whose `lg` half no call site in the repo
     * ever reached, so every figure in the product rendered at the `md`
     * default. It is gone rather than wired: a KPI column set at the hero's
     * own step would flatten the banner's hierarchy against the 40px
     * highlight beside it, and a per-call size knob is exactly how the same
     * stat tile arrived at nine spellings before the revamp collapsed them.
     */
    const figureClass = (html: string) =>
      [...html.matchAll(/<strong class="([^"]*)"/g)].map(([, cls]) => cls).at(-1) ?? "";
    const sizeOf = (cls: string) => /\btext-(\[[^\]]+\]|figure|display|body)(?![\w-])/.exec(cls)?.[1];

    const alone = figureClass(markup(<Metric label="Queue" value="7" />));
    const inBanner = figureClass(
      markup(<HeroBanner tone="plain" highlight={{ label: "Total", value: "412" }} metrics={[{ label: "Queue", value: "7" }]} />),
    );
    expect(sizeOf(alone)).toBeDefined();
    expect(sizeOf(inBanner)).toBe(sizeOf(alone));

    // The knob is gone from the type as well as from the class list, so no
    // screen can step one column up on its own. With `size` still on the
    // component this directive is unused and the typecheck fails on it —
    // which is the half of this test that has teeth.
    // @ts-expect-error - Metric takes no `size`.
    markup(<Metric label="Queue" value="7" size="lg" />);
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
