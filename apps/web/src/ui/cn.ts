import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Joins class names and lets a later utility win over an earlier one.
 *
 * Without the merge, `cn("px-3", props.className)` keeps both when the caller
 * passes `px-6` and the browser picks by stylesheet order rather than by intent
 * — so a component could not be adjusted at its call site. This is the one
 * helper every primitive depends on.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
