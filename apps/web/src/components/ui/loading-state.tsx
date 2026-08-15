import { useEffect, useState } from "react";
import { cn } from "../../lib/utils.js";

/**
 * A pixel-grid loader for work that outlasts a spinner's welcome.
 *
 * Three variants: `drive` runs a chevron wavefront across square cells on a
 * cycle shorter than the sweep, so two fronts are always in flight; `dots` is
 * the same wavefront with round cells; `orbit` laps a single comet around the
 * grid's perimeter.
 *
 * Everything visual lives in `styles.css` under `.pixel-grid` and
 * `.shimmer-label`. The upstream component carried its animation delays, its
 * shimmer gradient and its per-cell opacity as `style={{…}}` props, which the
 * container's `style-src 'self'` refuses outright — a CSP that blocks inline
 * style *attributes*, unlike the CSSOM writes elsewhere in this tree. Rendered
 * under that policy the grid would have drawn nine identical static squares.
 * The delays are `nth-child` rules instead, so the pattern survives the policy.
 */

export type LoadingStateVariant = "drive" | "dots" | "orbit";

/** Ten cells' worth of tick, for a caller that has no clock of its own. */
function useElapsedMs(enabled: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Date.now() - started), 100);
    return () => clearInterval(timer);
  }, [enabled]);
  return elapsed;
}

/**
 * `1.4s`, `2m 09.4s` — one decimal throughout so the figure never changes
 * width mid-run, which is the whole reason the readout is tabular.
 */
export function formatElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, elapsedMs) / 1_000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const remainder = seconds % 60;
  return `${Math.floor(seconds / 60)}m ${remainder < 10 ? "0" : ""}${remainder.toFixed(1)}s`;
}

export interface LoadingStateProps {
  label: string;
  variant?: LoadingStateVariant;
  /**
   * Elapsed milliseconds, when the caller already measures them.
   *
   * Chat does: the turn's clock starts when the stream opens and has to keep
   * its value across a reconnect. Left undefined, this component runs its own
   * interval from mount — correct for a standalone loader, wrong for anything
   * whose work began before it rendered.
   */
  elapsedMs?: number;
  /** Replaces the timer outright, for a state where elapsed time is a lie. */
  trailing?: string;
  className?: string;
}

export function LoadingState({
  label,
  variant = "drive",
  elapsedMs,
  trailing,
  className,
}: LoadingStateProps) {
  const ownElapsed = useElapsedMs(elapsedMs === undefined);
  const shown = elapsedMs ?? ownElapsed;

  return (
    <div className={cn("flex w-fit min-w-0 items-center gap-2.5", className)}>
      <span aria-hidden="true" className="pixel-grid" data-variant={variant}>
        {Array.from({ length: 9 }, (_, cell) => <span key={cell} className="pixel-grid__cell" />)}
      </span>
      <span className="shimmer-label min-w-0 truncate text-caption font-medium">{label}</span>
      <span className="ml-auto shrink-0 font-mono text-micro tabular-nums text-faint">
        {trailing ?? formatElapsed(shown)}
      </span>
    </div>
  );
}
