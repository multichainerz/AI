import { Button } from "./button.js";
import { cn } from "./cn.js";
import { Mark } from "./surface.js";

/**
 * The vertical step rail: an ordered run of markers joined by one spine, where
 * each row is both a progress readout and the way back into that step.
 *
 * Lifted from the governed-path column on the Dashboard
 * (`dashboard-hero.tsx`, `PipelineRow`): an `<ol>` with a 1px rule running
 * between stacked markers. That spine is vertical-only. A horizontal run puts
 * the title beside each marker, so the same rule rotated onto its side cut
 * through the step cells at the marker midline. Order in a row is the
 * ordinals; there is no empty corridor to put a connector in.
 *
 * Deliberately domain-free. It knows nothing about inference servers or agent
 * profiles; `setup-steps.ts` decides what the steps are and what blocks them,
 * and this decides what an ordered list of them looks like. That split is what
 * lets the rail be read without a database and the rules be tested without a
 * DOM.
 */
export type StepListStatus = "done" | "current" | "blocked";

export interface StepListItem {
  key: string;
  ordinal: number;
  title: string;
  /** One line beneath the title — what the step is for, or why it is waiting. */
  caption?: string;
  status: StepListStatus;
}

const statusLabel: Record<StepListStatus, string> = {
  done: "Done",
  current: "In progress",
  blocked: "Waiting",
};

export function StepList({
  items,
  activeKey,
  onSelect,
  label,
  className,
  orientation = "vertical",
}: {
  items: readonly StepListItem[];
  activeKey: string;
  onSelect: (key: string) => void;
  /** Names the rail for assistive technology; it is a navigation region. */
  label: string;
  className?: string;
  /**
   * `horizontal` lays the run across the top of whatever it introduces, one
   * equal column per step — and falls back to the vertical rail below `sm`,
   * where three titled columns cannot fit. Captions are a vertical-only
   * luxury for the same reason: in a row they made every cell as tall as the
   * wordiest blocker.
   */
  orientation?: "vertical" | "horizontal";
}) {
  const horizontal = orientation === "horizontal";
  return (
    <ol
      className={cn(
        "m-0 grid list-none gap-0 p-0",
        horizontal && "sm:grid-flow-col sm:auto-cols-fr sm:gap-3",
        className,
      )}
      aria-label={label}
    >
      {items.map((item, index) => {
        const active = item.key === activeKey;
        return (
          <li className="relative" key={item.key}>
            {/*
              The spine, drawn from beneath this marker to the top of the next
              one. `top-11` is the row's 12px of padding plus the 32px marker,
              `left-7` is that padding plus half the marker, and `-bottom-3`
              reaches across the next row's own padding — stopping at the row
              boundary left a 12px break in the chain, which reads as three
              markers that happen to be stacked rather than as one run.
              Measured rather than eyeballed: the marker's centre is at 335px
              and the rule lands at 334-335. Nothing is computed at runtime,
              because `style-src 'self'` refuses the inline offsets that would
              express it.
            */}
            {index < items.length - 1 && (
              <span
                aria-hidden="true"
                className={cn(
                  "absolute -bottom-3 left-7 top-11 w-px bg-border-strong",
                  horizontal && "sm:hidden",
                )}
              />
            )}
            <Button
              variant="ghost"
              size="auto"
              type="button"
              aria-current={active ? "step" : undefined}
              className={cn(
                "w-full items-start justify-start gap-3 rounded-md px-3 py-3 text-left hover:bg-raised hover:text-foreground",
                horizontal && "sm:px-2.5 sm:py-2",
                // Raised, not `bg-soft`. Soft is accent at 10–18%, so the open
                // row went lavender in light and purple in dark. Ghost hover
                // is the same token — override it or the rail flashes purple.
                active ? "border-border-strong bg-raised text-foreground" : null,
              )}
              onClick={() => onSelect(item.key)}
            >
              <Mark
                size="sm"
                className={cn(
                  // The marker carries the state, so the row does not need a
                  // second coloured element saying the same thing twice.
                  "relative z-[1] border",
                  item.status === "done"
                    ? "border-good/40 bg-good/10 text-good"
                    : item.status === "current"
                      ? "border-accent/50 bg-raised text-accent"
                      : "border-border-strong bg-raised text-faint",
                )}
              >
                {item.status === "done" ? "✓" : item.ordinal}
              </Mark>
              <span className="min-w-0 flex-1">
                <span className={cn("block truncate text-body font-semibold", active ? "text-text" : "text-muted")}>
                  {item.title}
                </span>
                <span
                  className={cn(
                    "mt-0.5 block text-micro font-semibold uppercase tabular-nums",
                    active ? "text-muted" : "text-faint",
                  )}
                >
                  {/*
                    Stated in words, not only in the marker's colour. The three
                    states differ by hue alone otherwise, which is the one thing
                    a readiness rail must not do.
                  */}
                  {statusLabel[item.status]}
                </span>
                {/*
                  The caption is for the rows that are *not* open. On the open
                  row the step body beside it already states the purpose and
                  every blocker in full, so repeating the first one here in
                  10px type is a second, worse copy of what the reader is
                  looking straight at.
                */}
                {item.caption && !active ? (
                  <span
                    className={cn(
                      "mt-1 block whitespace-normal text-micro font-normal normal-case leading-relaxed text-faint",
                      horizontal && "sm:hidden",
                    )}
                  >
                    {item.caption}
                  </span>
                ) : null}
              </span>
            </Button>
          </li>
        );
      })}
    </ol>
  );
}
