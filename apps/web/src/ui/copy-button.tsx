import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, type ButtonProps } from "./button.js";
import { cn } from "./cn.js";

/**
 * The one way anything in this product copies text.
 *
 * Seven screens wrote `void navigator.clipboard.writeText(...)` by hand, and
 * every one of them was broken twice over. `navigator.clipboard` exists only
 * in a secure context, and an on-premise dashboard is routinely read over
 * plain HTTP on a LAN address — where the API is `undefined`, the promise
 * throws into a `void`, and the button does nothing without saying so. And
 * even over HTTPS, none of the seven reported success: the operator pasted to
 * find out.
 *
 * This composition fixes both once. The write goes through the modern API
 * when the context allows it and falls back to a selection-and-execCommand
 * copy when it does not — deprecated, but the only path an insecure context
 * has, and these are exactly the deployments that need the enrollment
 * command copied. The outcome is stated on the control itself: a check and
 * "Copied" for two seconds, or "Copy failed" when both paths refused, so
 * silence always means "not pressed yet".
 */

function legacyCopy(text: string): boolean {
  const surface = document.createElement("textarea");
  surface.value = text;
  // Off-screen, not display:none — a hidden element cannot hold a selection.
  surface.setAttribute("readonly", "");
  surface.className = "fixed -left-[9999px] top-0";
  document.body.appendChild(surface);
  const selection = document.getSelection();
  const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  surface.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  surface.remove();
  // A copy control must not eat the text selection the operator had.
  if (previous && selection) {
    selection.removeAllRanges();
    selection.addRange(previous);
  }
  return copied;
}

export async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission refused or the document lost focus mid-write; the legacy
      // path below still has a chance.
    }
  }
  return legacyCopy(text);
}

type CopyState = "idle" | "copied" | "failed";

const FEEDBACK_MS = 2_000;

export function CopyButton({
  value,
  children = "Copy",
  iconSize = 16,
  className,
  ...rest
}: Omit<ButtonProps, "onClick" | "value" | "children"> & {
  /** What to copy — a string, or a function when composing it is not free. */
  value: string | (() => string);
  /** The idle label. Omit `children` for an icon-only control (set aria-label). */
  children?: ReactNode;
  iconSize?: number;
}) {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const iconOnly = children === null;

  return (
    <Button
      {...rest}
      type="button"
      className={cn(state === "failed" && "text-bad", className)}
      title={state === "copied" ? "Copied" : rest.title}
      onClick={() => {
        void copyToClipboard(typeof value === "function" ? value() : value).then((copied) => {
          setState(copied ? "copied" : "failed");
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setState("idle"), FEEDBACK_MS);
        });
      }}
    >
      {state === "copied"
        ? <Check size={iconSize} className="text-good" aria-hidden="true" />
        : <Copy size={iconSize} aria-hidden="true" />}
      {iconOnly ? null : state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : children}
      {/* The outcome, said aloud as well as drawn, for readers who cannot see
          the check appear. */}
      <span aria-live="polite" className="sr-only">
        {state === "copied" ? "Copied to the clipboard" : state === "failed" ? "The copy failed" : ""}
      </span>
    </Button>
  );
}
