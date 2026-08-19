import * as React from "react";
import { cn } from "@/lib/utils";

/*
 * Square, like every other non-circular surface here.
 *
 * The switch was the last pill in the product: a fully rounded track with a
 * fully rounded thumb, which `DESIGN_SYSTEM.md` used to name as a deliberate
 * exception beside avatars and status dots. It is not one. An avatar and a
 * status dot are actually circles; a switch is a rectangle with a rectangle
 * sliding inside it, and drawing the execution kill switch as a capsule made
 * the most consequential control in the product look borrowed from a different
 * toolkit than the buttons beside it. Both radii resolve through
 * `--radius-component` now, so a deployment that changes that one variable
 * moves the switch with everything else.
 */

export const Switch = React.forwardRef<HTMLButtonElement, Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> & { checked?: boolean; onCheckedChange?: (checked: boolean) => void; thumb?: React.ReactNode }>(
  ({ className, checked = false, onCheckedChange, thumb, ...props }, ref) => (
    <button
      ref={ref}
      {...props}
      type="button"
      role="switch"
      aria-checked={checked}
      data-state={checked ? "checked" : "unchecked"}
      className={cn("group inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded border border-input bg-secondary p-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary", className)}
      onClick={(event) => { props.onClick?.(event); if (!event.defaultPrevented) onCheckedChange?.(!checked); }}
    >
      {thumb ?? (
        <span aria-hidden="true" className="block h-3.5 w-3.5 rounded bg-foreground shadow-sm transition-transform group-data-[state=checked]:translate-x-4 group-data-[state=checked]:bg-primary-foreground" />
      )}
    </button>
  ),
);
Switch.displayName = "Switch";
