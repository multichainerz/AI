import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "./cn.js";

/**
 * Panels, headings, micro-labels and figures — the four things every screen is
 * built from.
 *
 * These existed as twelve bespoke heading blocks and nine copies of the same
 * stat-tile markup. Consolidating them is most of what makes the dashboard read
 * as one product rather than twelve.
 */

export function Panel({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return <section className={cn("rounded border border-border bg-surface p-5", className)} {...rest} />;
}

/** Uppercase, tracked, monospace, quiet — it names a thing without competing. */
export function MicroLabel({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn("font-mono text-micro uppercase text-faint", className)} {...rest} />;
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
        <h2 className="m-0 text-[15px] font-semibold tracking-[-0.01em] text-text">{props.title}</h2>
        {props.description ? (
          <p className="mb-0 mt-1.5 max-w-[68ch] text-body text-muted">{props.description}</p>
        ) : null}
      </div>
      {props.actions ? <div className="flex shrink-0 items-center gap-2">{props.actions}</div> : null}
    </header>
  );
}

const figure = cva("block font-semibold tabular-nums tracking-[-0.02em]", {
  variants: {
    tone: {
      neutral: "text-text",
      good: "text-good",
      warn: "text-warn",
      bad: "text-bad",
      accent: "text-accent",
    },
    size: { md: "text-[19px]", lg: "text-figure" },
  },
  defaultVariants: { tone: "neutral", size: "md" },
});

export interface MetricProps extends VariantProps<typeof figure> {
  label: string;
  value: ReactNode;
  caption?: ReactNode;
  /** 0–1. Renders the thin rule the reference puts under a capacity figure. */
  fill?: number;
  className?: string;
}

/**
 * A labelled figure.
 *
 * Tabular numerals are not cosmetic here: without them a column of values
 * aligns on nothing and a figure that updates shifts its neighbours sideways.
 */
export function Metric({ label, value, caption, fill, tone, size, className }: MetricProps) {
  return (
    <article className={cn("min-w-0", className)}>
      <MicroLabel className="block">{label}</MicroLabel>
      <strong className={cn(figure({ tone, size }), "mt-1.5")}>{value}</strong>
      {caption ? <small className="mt-1 block text-caption text-muted">{caption}</small> : null}
      {fill === undefined ? null : (
        /*
         * A real <progress>, not a styled div.
         *
         * The bar's width is data, and the obvious way to express it — an inline
         * `style` — is blocked outright by `style-src 'self'`. `<progress>`
         * carries its value as an *attribute*, so it needs no inline style at
         * all, and it comes with the right semantics and screen-reader
         * behaviour for free. Its track and value are painted from `styles.css`,
         * since the ::-webkit-progress-* pseudo-elements cannot be reached by a
         * utility class.
         */
        <progress
          className={cn("metric-progress mt-2.5 block h-0.5 w-full", tone ? `is-${tone}` : null)}
          value={Math.round(Math.max(0, Math.min(1, fill)) * 100)}
          max={100}
        />
      )}
    </article>
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
