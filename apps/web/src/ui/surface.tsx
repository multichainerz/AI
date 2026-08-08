import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "./cn.js";
import type { Tone } from "./feedback.js";

/**
 * Panels, headings, micro-labels and figures — the four things every screen is
 * built from.
 *
 * These existed as twelve bespoke heading blocks and nine copies of the same
 * stat-tile markup. Consolidating them is most of what makes the dashboard read
 * as one product rather than twelve.
 */

export function Panel({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={cn("rounded-card border border-border bg-surface p-5 shadow-card", className)}
      {...rest}
    />
  );
}

/**
 * Uppercase, tracked, tabular, quiet — it names a thing without competing.
 * Sans with tabular-nums rather than mono, per the design system: the numerals
 * still column-align, and the label reads as part of the type family instead of
 * as code.
 */
export function MicroLabel({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cn("text-micro font-semibold uppercase tabular-nums text-faint", className)} {...rest} />
  );
}

/**
 * The band at the top of every screen: where you are, what it is, what you can
 * do about it.
 *
 * Twelve views wrote this by hand as `.topbar` + `.page-heading`, which is why
 * the heading level, the description width and the action alignment differ
 * slightly on every one of them.
 */
export function PageHeader(props: {
  kicker?: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("mb-7 flex items-start justify-between gap-7", props.className)}>
      <div className="min-w-0 max-w-[72ch]">
        {props.kicker ? <MicroLabel className="mb-2 block">{props.kicker}</MicroLabel> : null}
        <h1 className="m-0 font-display text-[26px] font-semibold leading-[1.15] tracking-[-0.03em] text-text">{props.title}</h1>
        {props.description ? (
          <p className="mb-0 mt-2.5 text-[12.5px] leading-relaxed text-muted">{props.description}</p>
        ) : null}
      </div>
      {props.actions ? <div className="flex shrink-0 items-center gap-2.5 pt-1">{props.actions}</div> : null}
    </header>
  );
}

export function PanelHeading(props: {
  kicker?: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("mb-4 flex items-start justify-between gap-6", props.className)}>
      <div className="min-w-0">
        {props.kicker ? <MicroLabel className="mb-1.5 block">{props.kicker}</MicroLabel> : null}
        <h2 className="m-0 font-display text-[17px] font-semibold tracking-[-0.02em] text-text">{props.title}</h2>
        {props.description ? (
          <p className="mb-0 mt-1.5 max-w-[68ch] text-body text-muted">{props.description}</p>
        ) : null}
      </div>
      {props.actions ? <div className="flex shrink-0 items-center gap-2">{props.actions}</div> : null}
    </header>
  );
}

/*
 * Space Grotesk for every figure, per the design: the display face is what
 * makes the number read as a stat rather than as large body text.
 *
 * One size, and no prop to change it. There was a second `lg` step at
 * `text-figure`, and no call site in the repo ever reached it, so every Metric
 * in the product has always rendered at 19px. Wiring it into HeroBanner's KPI
 * columns was the alternative and is the wrong answer: the columns sit beside
 * a 40px highlight whose whole job is to dominate them, and the same Metric
 * also stands alone in six MetricRows where nothing would justify the larger
 * step — so the size would have said "which container am I in", not "how
 * important is this number". 19px stays a deliberate one-off between body and
 * `figure`; `figure` remains the hero's own step.
 */
const figure = cva("block font-display text-[19px] font-semibold tabular-nums tracking-[-0.02em]", {
  variants: {
    tone: {
      neutral: "text-text",
      good: "text-good",
      warn: "text-warn",
      bad: "text-bad",
      accent: "text-accent",
    },
  },
  defaultVariants: { tone: "neutral" },
});

export interface MetricProps extends VariantProps<typeof figure> {
  label: string;
  value: ReactNode;
  caption?: ReactNode;
  className?: string;
}

/**
 * A labelled figure.
 *
 * Tabular numerals are not cosmetic here: without them a column of values
 * aligns on nothing and a figure that updates shifts its neighbours sideways.
 */
export function Metric({ label, value, caption, tone, className }: MetricProps) {
  return (
    <article className={cn("min-w-0", className)}>
      <MicroLabel className="block">{label}</MicroLabel>
      <strong className={cn(figure({ tone }), "mt-1.5")}>{value}</strong>
      {caption ? <small className="mt-1 block text-caption text-muted">{caption}</small> : null}
    </article>
  );
}

/**
 * The surface inside a Panel: a row, a sub-card, an item in a list.
 *
 * Written by hand forty-three times as
 * `rounded border border-border bg-raised p-3` and its near-variants, which is
 * how the same semantic element ended up at three paddings and two
 * backgrounds across the product. `Panel` is the outer surface; this is what
 * sits within one, one step down in radius and one step up in fill.
 *
 * `interactive` adds the hover treatment a clickable row needs — several
 * screens grew their own, all slightly different.
 */
export function Tile({
  className,
  interactive,
  pad = "md",
  strong,
  as: Element = "div",
  ...rest
}: HTMLAttributes<HTMLDivElement> & {
  interactive?: boolean;
  /** The three paddings the product actually uses; `md` is by far the common one. */
  pad?: "sm" | "md" | "lg";
  /** The heavier border, for a tile that has to separate from a busy neighbour. */
  strong?: boolean;
  /**
   * The element to render. `article` for a repeating item that stands on its
   * own — a policy row, a component, a sign-off — which is what most of these
   * were before adopting this primitive. Hardcoding `div` silently stripped
   * the implicit ARIA role from eleven such lists.
   */
  as?: "div" | "article";
}) {
  return (
    <Element
      className={cn(
        "rounded bg-raised",
        strong ? "border border-border-strong" : "border border-border",
        pad === "sm" ? "p-2.5" : pad === "lg" ? "p-3.5" : "p-3",
        interactive ? "text-left transition-colors hover:border-border-strong" : null,
        className,
      )}
      {...rest}
    />
  );
}

/**
 * The square-ish initials tile: a layer's two letters, an agent's mark, the
 * locked screen's badge.
 *
 * Hand-rolled eight times at four box sizes and five type sizes, and the
 * design system's own answer in `LockedScreen` disagreed with all of them on
 * both shape and face. One shape, stated once: accent-soft fill, pill radius,
 * display face — the same treatment the chat avatar uses.
 */
export function Mark({
  size = "md",
  className,
  ...rest
}: HTMLAttributes<HTMLSpanElement> & { size?: "sm" | "md" | "lg" }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "grid shrink-0 place-items-center rounded-pill bg-soft font-display font-semibold text-accent",
        size === "sm" ? "h-8 w-8 text-caption" : size === "lg" ? "h-11 w-11 text-[15px]" : "h-9 w-9 text-label",
        className,
      )}
      {...rest}
    />
  );
}

export function MetricRow({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "grid grid-cols-2 gap-x-8 gap-y-5 border-b border-border pb-5 md:grid-cols-4 lg:grid-cols-5",
        className,
      )}
      {...rest}
    />
  );
}

export interface HeroBannerProps extends HTMLAttributes<HTMLElement> {
  /**
   * The screen's one number. `accent` draws it on the violet block with the
   * soft circle decorations; `plain` sets it large on the card itself — the
   * design uses the block where the figure is an achievement and the plain
   * form where it is simply a count.
   *
   * `fill` (0–1) draws the bar beneath it. A figure with a denominator is the
   * only kind that earns one, and omitting it here is how the readiness bar
   * left the product in ai-v1.88.0 without a single test noticing.
   */
  highlight: { label: string; value: ReactNode; caption?: ReactNode; fill?: number | undefined; tone?: Tone | undefined };
  tone?: "accent" | "plain";
  metrics: MetricProps[];
}

/**
 * The bar under a highlighted figure, drawn through `<progress>` for the same
 * reason `Metric` does: the width is data, and `style-src 'self'` refuses the
 * inline width that would express it. On the accent block it needs its own
 * painting, since the stylesheet's track and value colours are tuned for a
 * page surface and vanish against violet.
 */
function HighlightBar({
  fill,
  tone,
  onAccent,
}: {
  fill?: number | undefined;
  tone?: Tone | undefined;
  onAccent?: boolean;
}) {
  if (fill === undefined) return null;
  return (
    <progress
      // On the violet block the bar states its own colours; elsewhere it takes
      // the figure's tone, so a readiness fraction reads good or warn at a
      // glance rather than as a neutral rule.
      className={cn(
        "metric-progress mt-3 block h-0.5 w-full",
        // Tone wins where it says something the figure does not. On the accent
        // block a good/warn fill still reads against violet, and `on-accent`
        // is only the fallback for a bar with nothing to report — the first
        // version put `on-accent` first, which discarded every tone Home
        // computed and left the .is-* rules with no consumer at all.
        tone ? `is-${tone}` : onAccent ? "on-accent" : null,
      )}
      value={Math.round(Math.max(0, Math.min(1, fill)) * 100)}
      max={100}
    />
  );
}

/**
 * The stat banner every main screen opens with: one highlighted figure, then a
 * row of KPI columns split by hairlines. White on the accent block is the
 * design's choice in both themes — the block, unlike the primary button, sets
 * display-sized type that carries the lighter dark-mode violet.
 *
 * Rest props reach the Panel: several screens name this region with an
 * aria-label their tests address it by.
 */
export function HeroBanner({ highlight, tone = "accent", metrics, className, ...rest }: HeroBannerProps) {
  return (
    <Panel className={cn("flex flex-wrap items-stretch gap-y-5 p-5 sm:p-6", className)} {...rest}>
      {tone === "accent" ? (
        <div className="relative -my-1.5 mr-6 min-w-[240px] overflow-hidden rounded-lg bg-accent px-5 py-4 text-white">
          <span aria-hidden="true" className="absolute -right-8 -top-8 h-28 w-28 rounded-pill bg-white/10" />
          <span aria-hidden="true" className="absolute -bottom-10 right-1.5 h-24 w-24 rounded-pill bg-white/[0.07]" />
          <div className="relative">
            <MicroLabel className="block text-white/70">{highlight.label}</MicroLabel>
            <strong className="mt-2 block font-display text-display font-semibold">{highlight.value}</strong>
            {highlight.caption ? (
              <small className="mt-2 block text-caption text-white/80">{highlight.caption}</small>
            ) : null}
            <HighlightBar fill={highlight.fill} tone={highlight.tone} onAccent />
          </div>
        </div>
      ) : (
        <div className="mr-8 min-w-[220px]">
          <MicroLabel className="block">{highlight.label}</MicroLabel>
          <strong className="mt-2 block font-display text-display font-semibold text-text">{highlight.value}</strong>
          {highlight.caption ? (
            <small className="mt-2 block text-caption text-muted">{highlight.caption}</small>
          ) : null}
          <HighlightBar fill={highlight.fill} tone={highlight.tone} />
        </div>
      )}
      <div className="flex min-w-[280px] flex-1 flex-wrap items-stretch gap-y-4 border-border sm:border-l">
        {metrics.map((metric) => (
          <Metric
            key={metric.label}
            {...metric}
            className={cn("flex-1 basis-36 border-r border-border/60 px-5 last:border-r-0", metric.className)}
          />
        ))}
      </div>
    </Panel>
  );
}
