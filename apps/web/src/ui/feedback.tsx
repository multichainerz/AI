import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes, ReactNode } from "react";
import { Button } from "./button.js";
import { cn } from "./cn.js";
import { Mark, MicroLabel, Panel } from "./surface.js";

/**
 * Status, alerts, empty states and the locked screen.
 *
 * The locked screen is the biggest consolidation in the set: nine views each
 * wrote their own, so a person who lost their session saw nine slightly
 * different explanations of the same thing.
 */

export type Tone = "neutral" | "good" | "warn" | "bad" | "accent";

/**
 * The connection vocabulary is wider than the palette on purpose: six readiness
 * tones, plus the ones individual screens add for a locked session or an
 * untested route, collapse to four colours. Anything unrecognised reads as
 * neutral rather than inventing a fifth.
 *
 * Shared because every view that shows a service, a route or a policy has to
 * make the same mapping, and three private copies would drift.
 */
export function toneFor(value: string): Tone {
  if (value === "ready" || value === "healthy" || value === "active") return "good";
  if (value === "degraded" || value === "validation" || value === "not_tested" || value === "draft") return "warn";
  if (value === "blocked" || value === "unreachable" || value === "failed") return "bad";
  return "neutral";
}

const status = cva("inline-flex items-center text-micro font-semibold uppercase tabular-nums", {
  variants: {
    tone: {
      neutral: "text-faint",
      good: "text-good",
      warn: "text-warn",
      bad: "text-bad",
      accent: "text-accent",
    },
  },
  defaultVariants: { tone: "neutral" },
});

/**
 * State as coloured text, not a filled pill.
 *
 * A row of pills reads as a row of buttons and invites a click that does
 * nothing. Bare text states a fact and lets the colour carry the severity.
 */
export function StatusText({
  className,
  tone,
  dot,
  children,
  ...rest
}: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof status> & { dot?: boolean }) {
  return (
    <span className={cn(status({ tone }), dot ? "gap-2" : null, className)} {...rest}>
      {/*
       * Round and breathing, per the design's live indicator. The pulse is a
       * class from styles.css so prefers-reduced-motion can stop the whole
       * family in one rule.
       */}
      {dot ? <span aria-hidden="true" className="anim-live h-1.5 w-1.5 shrink-0 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}

const alert = cva("flex items-start justify-between gap-4 rounded border px-3.5 py-3 text-body", {
  variants: {
    tone: {
      error: "border-bad/40 bg-bad/10 text-bad",
      warn: "border-warn/40 bg-warn/10 text-warn",
      good: "border-good/40 bg-good/10 text-good",
      info: "border-border-strong bg-raised text-muted",
    },
  },
  defaultVariants: { tone: "error" },
});

export function Alert({
  children,
  onDismiss,
  tone,
  className,
}: VariantProps<typeof alert> & {
  children: ReactNode;
  onDismiss?: () => void;
  className?: string;
}) {
  return (
    <div className={cn(alert({ tone }), className)} role="alert">
      <span className="min-w-0">{children}</span>
      {onDismiss ? (
        <Button variant="ghost" size="sm" onClick={onDismiss} className="-my-1 shrink-0">
          Dismiss
        </Button>
      ) : null}
    </div>
  );
}

export function EmptyState(props: { title: string; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "grid justify-items-start gap-1.5 rounded border border-dashed border-border px-4 py-7",
        props.className,
      )}
    >
      <strong className="text-body font-semibold text-text">{props.title}</strong>
      {props.children ? <span className="max-w-[62ch] text-body text-muted">{props.children}</span> : null}
      {props.action ? <div className="mt-2">{props.action}</div> : null}
    </div>
  );
}

/**
 * One locked screen for every governed area.
 *
 * `title` names the area so the four Platform screens stay distinguishable —
 * `admin-access.test.tsx` asserts exactly that, having previously asserted it
 * through a class-name regex that a utility class would have broken.
 */
export function LockedScreen(props: {
  title: string;
  mark: string;
  reason?: ReactNode;
  actionLabel: string;
  onAction: () => void;
  /**
   * Not every locked area wants an administrator. Chat, Knowledge and Agents
   * also serve enterprise identities, so they state what they actually need
   * and offer the enterprise route as a second action.
   */
  headline?: string;
  secondaryLabel?: string;
  onSecondary?: () => void;
  /** Chat is the one locked area an employee reaches, so it is not "Administration". */
  kicker?: string;
}) {
  return (
    <div className="grid gap-4">
      <header>
        <MicroLabel className="mb-1.5 block">{props.kicker ?? "Administration"}</MicroLabel>
        {/*
         * PageHeader's exact one-off, deliberately, rather than a step of the
         * scale: a kicker over an <h1> naming the area is precisely what
         * PageHeader draws, and this header stands in for the one the area
         * shows once it opens. Set at 20px it was the only stock Tailwind
         * font size left in the product — on no step of the OrcaNeuron scale
         * — and it made the title jump six pixels at the moment of unlocking,
         * the one moment a person is looking straight at it.
         */}
        <h1 className="m-0 font-display text-[26px] font-semibold leading-[1.15] tracking-[-0.03em] text-text">
          {props.title}
        </h1>
      </header>
      {/*
        * Three columns only once there is room for them. At 375px the auto
        * columns take what they need and the explanation is squeezed into a
        * four-word ribbon, so below `sm` the mark and the copy share a row and
        * the action takes the one beneath it.
        */}
      <Panel className="mx-auto my-16 grid max-w-[680px] grid-cols-[auto_minmax(0,1fr)] items-center gap-4 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
        <Mark size="lg">{props.mark}</Mark>
        <div className="min-w-0">
          <strong className="block text-body font-semibold text-text">
            {props.headline ?? "Administrator session required"}
          </strong>
          <p className="mb-0 mt-1 text-body text-muted">
            {props.reason ?? "Unlock OrcaSynapse to review and change this area."}
          </p>
        </div>
        <div className="col-span-2 flex flex-col gap-2 sm:col-span-1 sm:flex-row sm:items-center">
          <Button variant="primary" onClick={props.onAction}>
            {props.actionLabel}
          </Button>
          {props.secondaryLabel && props.onSecondary ? (
            <Button variant="ghost" onClick={props.onSecondary}>
              {props.secondaryLabel}
            </Button>
          ) : null}
        </div>
      </Panel>
    </div>
  );
}
