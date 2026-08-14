import * as React from "react";
import { X } from "lucide-react";
import { Slot } from "@radix-ui/react-slot";
import { cn } from "@/lib/utils";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface DialogContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  titleId: string;
  descriptionId: string;
}

const DialogContext = React.createContext<DialogContextValue | null>(null);

function useDialog() {
  const context = React.useContext(DialogContext);
  if (!context) throw new Error("Dialog components must be used inside Dialog");
  return context;
}

export function Dialog({ open, defaultOpen = false, onOpenChange, children }: { open?: boolean; defaultOpen?: boolean; onOpenChange?: (open: boolean) => void; children: React.ReactNode }) {
  const [internalOpen, setInternalOpen] = React.useState(defaultOpen);
  const onOpenChangeRef = React.useRef(onOpenChange);
  const titleId = React.useId();
  const descriptionId = React.useId();
  const controlled = open !== undefined;
  const resolvedOpen = open ?? internalOpen;
  React.useEffect(() => {
    onOpenChangeRef.current = onOpenChange;
  }, [onOpenChange]);
  const setOpen = React.useCallback((next: boolean) => {
    if (!controlled) setInternalOpen(next);
    onOpenChangeRef.current?.(next);
  }, [controlled]);
  return <DialogContext.Provider value={{ open: resolvedOpen, setOpen, titleId, descriptionId }}>{children}</DialogContext.Provider>;
}

export function DialogTrigger({ asChild = false, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { asChild?: boolean }) {
  const { setOpen } = useDialog();
  const Component = asChild ? Slot : "button";
  return <Component {...props} type={asChild ? undefined : "button"} onClick={(event) => { props.onClick?.(event); if (!event.defaultPrevented) setOpen(true); }}>{children}</Component>;
}

export function DialogClose({ asChild = false, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { asChild?: boolean }) {
  const { setOpen } = useDialog();
  const Component = asChild ? Slot : "button";
  return <Component {...props} type={asChild ? undefined : "button"} onClick={(event) => { props.onClick?.(event); if (!event.defaultPrevented) setOpen(false); }}>{children}</Component>;
}

export function DialogPortal({ children }: { children: React.ReactNode }) {
  // This shell has no transformed stacking ancestor, so fixed dialog layers
  // can stay in-tree. Keeping the node stable also makes SSR and keyboard
  // focus ownership deterministic instead of remounting after hydration.
  return <>{children}</>;
}

export const DialogOverlay = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn("fixed inset-0 z-50 bg-backdrop/55 backdrop-blur-[3px]", className)} {...props} />,
);
DialogOverlay.displayName = "DialogOverlay";

export const DialogContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & { showCloseButton?: boolean }>(
  ({ className, children, showCloseButton = true, ...props }, forwardedRef) => {
    const { open, setOpen, titleId, descriptionId } = useDialog();
    const localRef = React.useRef<HTMLDivElement>(null);
    React.useImperativeHandle(forwardedRef, () => localRef.current as HTMLDivElement);

    React.useEffect(() => {
      if (!open) return;
      const previousFocus = document.activeElement as HTMLElement | null;
      const previousOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          event.preventDefault();
          setOpen(false);
          return;
        }
        if (event.key !== "Tab" || !localRef.current) return;
        const focusable = Array.from(localRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
        const first = focusable[0];
        const last = focusable.at(-1);
        if (!first || !last) return;
        if (!localRef.current.contains(event.target as Node)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
          return;
        }
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      };
      const containFocus = (event: FocusEvent) => {
        if (!localRef.current || localRef.current.contains(event.target as Node)) return;
        localRef.current.querySelector<HTMLElement>(FOCUSABLE)?.focus();
      };
      document.addEventListener("keydown", onKeyDown);
      document.addEventListener("focusin", containFocus);
      // Focus synchronously once the content mounts. Deferring through rAF can
      // leave the trigger active for a full frame, which makes rapid keyboard
      // navigation escape the modal before the trap owns focus.
      localRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
      return () => {
        document.body.style.overflow = previousOverflow;
        document.removeEventListener("keydown", onKeyDown);
        document.removeEventListener("focusin", containFocus);
        previousFocus?.focus();
      };
    }, [open, setOpen]);

    if (!open) return null;
    return (
      <DialogPortal>
        <DialogOverlay onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }} />
        <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center p-4">
          <div
            ref={localRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            className={cn("pointer-events-auto relative grid max-h-[86vh] w-full max-w-[560px] gap-4 overflow-y-auto rounded-lg border border-border bg-card p-5 text-card-foreground shadow-overlay", className)}
            {...props}
          >
            {children}
            {showCloseButton ? (
              <button type="button" aria-label="Close" onClick={() => setOpen(false)} className="absolute right-4 top-4 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <X className="h-4 w-4" />
              </button>
            ) : null}
          </div>
        </div>
      </DialogPortal>
    );
  },
);
DialogContent.displayName = "DialogContent";

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) { return <div className={cn("flex flex-col gap-1.5 pr-8 text-left", className)} {...props} />; }
export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) { return <div className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...props} />; }
export const DialogTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(({ className, ...props }, ref) => { const { titleId } = useDialog(); return <h2 ref={ref} id={titleId} className={cn("font-display text-[17px] font-semibold tracking-[-0.02em]", className)} {...props} />; });
DialogTitle.displayName = "DialogTitle";
export const DialogDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(({ className, ...props }, ref) => { const { descriptionId } = useDialog(); return <p ref={ref} id={descriptionId} className={cn("text-body leading-relaxed text-muted-foreground", className)} {...props} />; });
DialogDescription.displayName = "DialogDescription";
