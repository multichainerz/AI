import * as React from "react";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "./dialog";
import { cn } from "@/lib/utils";

export { Dialog as Sheet, DialogTrigger as SheetTrigger, DialogClose as SheetClose, DialogHeader as SheetHeader, DialogTitle as SheetTitle, DialogDescription as SheetDescription };

export const SheetContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & { side?: "top" | "right" | "bottom" | "left" }>(
  ({ side = "right", className, children, ...props }, ref) => {
    const sideClass = side === "right"
      ? "inset-y-0 right-0 h-full w-[min(560px,100%)] border-l"
      : side === "left"
        ? "inset-y-0 left-0 h-full w-[min(560px,100%)] border-r"
        : side === "top"
          ? "inset-x-0 top-0 w-full border-b"
          : "inset-x-0 bottom-0 w-full border-t";
    return <DialogContent ref={ref} className={cn("fixed max-h-none max-w-none gap-4 overflow-y-auto rounded-none p-5", sideClass, className)} {...props}>{children}</DialogContent>;
  },
);
SheetContent.displayName = "SheetContent";

export function SheetFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) { return <div className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)} {...props} />; }
