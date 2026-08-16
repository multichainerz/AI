import type { ReactNode } from "react";
import {
  Dialog as DialogRoot,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.js";
import { Button } from "./button.js";
import { cn } from "./cn.js";
import { MicroLabel } from "./surface.js";

/**
 * Compatibility composition for existing feature screens. Its behavior comes
 * from the canonical CSP-safe shadcn Dialog implementation; no Radix overlay,
 * Popper positioning, or runtime stylesheet injection reaches production.
 */
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

function OverlayChrome(props: OverlayProps & { drawer?: boolean }) {
  return (
    <DialogRoot open={props.open} onOpenChange={(open) => { if (!open) props.onClose(); }}>
      <DialogContent
        showCloseButton={false}
        className={cn(
          // Flex, not grid: DialogContent is a grid whose rows size to content,
          // so a long form plus overflow-hidden clipped the footer below 86vh.
          // A column with a shrinking middle keeps header and actions on screen.
          "flex max-h-[86vh] flex-col gap-0 overflow-hidden p-0",
          props.drawer ? "fixed inset-y-0 right-0 h-full max-h-none max-w-[560px] rounded-none border-y-0 border-r-0" : "max-w-[560px]",
          props.className,
        )}
      >
        <DialogHeader className="shrink-0 flex-row items-start justify-between gap-6 border-b border-border px-5 py-4 pr-5">
          <div className="min-w-0">
            {props.kicker ? <MicroLabel className="mb-1.5 block text-primary">{props.kicker}</MicroLabel> : null}
            <DialogTitle>{props.title}</DialogTitle>
            {props.description ? <DialogDescription className="mb-0 mt-1.5 max-w-[62ch]">{props.description}</DialogDescription> : null}
          </div>
          <Button variant="ghost" size="sm" onClick={props.onClose} aria-label="Close">Close</Button>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{props.children}</div>
        {props.footer ? <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-5 py-3.5">{props.footer}</footer> : null}
      </DialogContent>
    </DialogRoot>
  );
}

export function Dialog(props: OverlayProps) {
  return <OverlayChrome {...props} />;
}

export function Drawer(props: OverlayProps) {
  return <OverlayChrome {...props} drawer />;
}
