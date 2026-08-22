import * as React from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * CSP-safe select. The browser owns popup positioning, so no runtime style is injected.
 *
 * `appearance-none` plus a long `<option>` list sizes the closed control to
 * its min-content height on several engines, so a catalogue select paints as
 * an in-page listbox and the viewport-locked workspace crops whatever sits
 * under it. `max-h-9 overflow-hidden` keeps the closed row at one line; the
 * native popup is a separate layer and is not clipped.
 */
export const NativeSelect = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <span className="relative block w-full">
      <select
        ref={ref}
        className={cn("h-9 max-h-9 min-h-9 w-full appearance-none overflow-hidden rounded-md border border-input bg-background px-3 pr-9 text-body text-foreground shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50", className)}
        {...props}
      >
        {children}
      </select>
      <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
    </span>
  ),
);
NativeSelect.displayName = "NativeSelect";
