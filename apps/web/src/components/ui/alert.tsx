import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const alertVariants = cva("relative w-full rounded-lg border p-4 text-body", {
  variants: {
    variant: {
      default: "border-border bg-card text-card-foreground",
      destructive: "border-destructive/40 bg-destructive/10 text-destructive",
      warning: "border-warning/40 bg-warning/10 text-warning",
      success: "border-success/40 bg-success/10 text-success",
    },
  },
  defaultVariants: { variant: "default" },
});

export interface AlertProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof alertVariants> {}

export const Alert = React.forwardRef<HTMLDivElement, AlertProps>(({ className, variant, ...props }, ref) => (
  <div ref={ref} role="alert" className={cn(alertVariants({ variant }), className)} {...props} />
));
Alert.displayName = "Alert";

export const AlertTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => <h5 ref={ref} className={cn("mb-1 font-display font-semibold leading-none tracking-tight", className)} {...props} />,
);
AlertTitle.displayName = "AlertTitle";

export const AlertDescription = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => <div ref={ref} className={cn("text-body leading-relaxed [&_p]:leading-relaxed", className)} {...props} />,
);
AlertDescription.displayName = "AlertDescription";
