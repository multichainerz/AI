import * as React from "react";
import { cn } from "@/lib/utils";

export const Avatar = React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement>>(
  ({ className, ...props }, ref) => <span ref={ref} className={cn("relative flex h-9 w-9 shrink-0 overflow-hidden rounded-full", className)} {...props} />,
);
Avatar.displayName = "Avatar";

export const AvatarImage = React.forwardRef<HTMLImageElement, React.ImgHTMLAttributes<HTMLImageElement>>(
  ({ className, ...props }, ref) => <img ref={ref} className={cn("aspect-square h-full w-full object-cover", className)} {...props} />,
);
AvatarImage.displayName = "AvatarImage";

export const AvatarFallback = React.forwardRef<HTMLSpanElement, React.HTMLAttributes<HTMLSpanElement>>(
  ({ className, ...props }, ref) => <span ref={ref} className={cn("flex h-full w-full items-center justify-center rounded-full bg-soft text-caption font-semibold text-primary", className)} {...props} />,
);
AvatarFallback.displayName = "AvatarFallback";
