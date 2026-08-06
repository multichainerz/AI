import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes, ReactNode } from "react";
import { Button } from "./button.js";
import { cn } from "./cn.js";
import { MicroLabel, Panel } from "./surface.js";

/**
 * Status, alerts, empty states and the locked screen.
 *
 * The locked screen is the biggest consolidation in the set: nine views each
 * wrote their own, so a person who lost their session saw nine slightly
 * different explanations of the same thing.
 */

const status = cva("inline-flex items-center font-mono text-micro uppercase", {
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
       * A square, and a small one. Four stylesheet rules drew this dot as a
       * circle at four different sizes; one shape stated once is the whole point
       * of the set, and square is what the rest of the system is.
       */}
      {dot ? <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 bg-current" /> : null}
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
      <strong className="text-[13px] font-semibold text-text">{props.title}</strong>
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
  /** Chat is the one locked area an employee reaches, so it is not "Administration". */
  kicker?: string;
}) {
  return (
    <div className="grid gap-4">
      <header>
        <MicroLabel className="mb-1.5 block">{props.kicker ?? "Administration"}</MicroLabel>
        <h1 className="m-0 text-xl font-semibold tracking-[-0.02em] text-text">{props.title}</h1>
      </header>
      {/*
        * Three columns only once there is room for them. At 375px the auto
        * columns take what they need and the explanation is squeezed into a
        * four-word ribbon, so below `sm` the mark and the copy share a row and
        * the action takes the one beneath it.
        */}
      <Panel className="mx-auto my-16 grid max-w-[680px] grid-cols-[auto_minmax(0,1fr)] items-center gap-4 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
        <span
          aria-hidden="true"
          className="grid h-11 w-11 place-items-center rounded border border-border-strong bg-raised font-mono text-[15px] font-bold text-accent"
        >
          {props.mark}
        </span>
        <div className="min-w-0">
          <strong className="block text-[13px] font-semibold text-text">Administrator session required</strong>
          <p className="mb-0 mt-1 text-body text-muted">
            {props.reason ?? "Unlock OrcaSynapse to review and change this area."}
          </p>
        </div>
        <Button variant="primary" className="col-span-2 sm:col-span-1" onClick={props.onAction}>
          {props.actionLabel}
        </Button>
      </Panel>
    </div>
  );
}
