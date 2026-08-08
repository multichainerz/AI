import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "./button.js";
import { cn } from "./cn.js";
import { MicroLabel } from "./surface.js";

/**
 * Dialog and Drawer, written here rather than taken from Radix.
 *
 * Radix is what shadcn builds its overlays on, and it cannot be used in this
 * product: `deploy/nginx/default.conf` sets `style-src 'self'` with no
 * `'unsafe-inline'`, and Radix's Popper primitives write positioning transforms
 * into inline `style` attributes while Dialog pulls `react-remove-scroll`, which
 * injects a `<style>` element to lock body scroll. Both are refused by the
 * browser.
 *
 * The trap that matters — Tab cycling, Escape, scroll lock, focus restore — is
 * about forty lines, and a correct implementation already existed in
 * `connection-drawer.tsx`. This is that logic, extracted so all five overlays
 * share one copy instead of four of them having none.
 *
 * Note the failure mode this avoids is invisible in development: the dev server
 * sends no CSP header, so Radix overlays would work perfectly in `pnpm dev` and
 * break only in a built container.
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function useOverlayBehaviour(open: boolean, onClose: () => void) {
  const panel = useRef<HTMLDivElement>(null);
  // Held in a ref so the effect below depends only on `open`.
  //
  // Every call site passes an inline arrow, so `onClose` is a new function on
  // each render of the component owning the overlay -- and typing into a field
  // inside the overlay re-renders exactly that component. With `onClose` in the
  // dependency array the effect tore down and re-ran per keystroke: the cleanup
  // returned focus to whatever opened the dialog, and the new run pulled it to
  // the panel's first focusable. The result was that only the first character
  // of any value could be typed, and every dialog form in the product -- VM2
  // enrollment included -- was impossible to complete.
  const latestOnClose = useRef(onClose);
  useEffect(() => {
    latestOnClose.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        latestOnClose.current();
        return;
      }
      if (event.key !== "Tab" || !panel.current) return;
      const focusable = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    // Setting body.style directly is a DOM property write, not a CSP-relevant
    // inline style attribute in the markup, so it is permitted.
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);
    window.requestAnimationFrame(() => {
      panel.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    });
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [open]);

  return panel;
}

interface OverlayProps {
  open: boolean;
  onClose: () => void;
  title: string;
  kicker?: string;
  description?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}

function Backdrop(props: { onClose: () => void; children: ReactNode; align: string }) {
  return (
    <div
      className={cn("fixed inset-0 z-50 flex bg-backdrop/50 p-4 backdrop-blur-[3px]", props.align)}
      // Closing on mousedown rather than click so a drag that starts inside the
      // panel and ends on the backdrop does not dismiss the operator's work.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      {props.children}
    </div>
  );
}

function Chrome(props: OverlayProps & { panelClass: string }) {
  const panel = useOverlayBehaviour(props.open, props.onClose);
  if (!props.open) return null;
  return (
    <Backdrop onClose={props.onClose} align={props.panelClass.includes("h-full") ? "justify-end" : "items-center justify-center"}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        className={cn(
          "flex min-h-0 flex-col overflow-hidden border border-border bg-surface shadow-overlay",
          props.panelClass,
          props.className,
        )}
      >
        <header className="flex items-start justify-between gap-6 border-b border-border px-5 py-4">
          <div className="min-w-0">
            {props.kicker ? <MicroLabel className="mb-1.5 block text-accent">{props.kicker}</MicroLabel> : null}
            <h2 className="m-0 font-display text-[16px] font-semibold tracking-[-0.02em] text-text">{props.title}</h2>
            {props.description ? (
              <p className="mb-0 mt-1.5 max-w-[62ch] text-body text-muted">{props.description}</p>
            ) : null}
          </div>
          <Button variant="ghost" size="sm" onClick={props.onClose} aria-label="Close">
            Close
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{props.children}</div>
        {props.footer ? (
          <footer className="flex items-center justify-end gap-2 border-t border-border px-5 py-3.5">
            {props.footer}
          </footer>
        ) : null}
      </div>
    </Backdrop>
  );
}

/** Centred, for a decision or a short form. */
export function Dialog(props: OverlayProps) {
  return <Chrome {...props} panelClass="w-full max-w-[560px] max-h-[86vh] rounded-modal" />;
}

/** Edge-anchored, for the longer configuration forms. */
export function Drawer(props: OverlayProps) {
  return <Chrome {...props} panelClass="h-full w-full max-w-[560px]" />;
}
