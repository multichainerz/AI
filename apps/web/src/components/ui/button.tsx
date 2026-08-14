import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md border text-body font-semibold transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "border-primary bg-primary text-primary-foreground hover:border-accent-strong hover:bg-accent-strong",
        destructive: "border-destructive/50 bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline: "border-input bg-background text-foreground hover:border-border-strong hover:bg-secondary",
        secondary: "border-secondary bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "border-transparent bg-transparent text-muted-foreground hover:bg-soft hover:text-foreground",
        link: "border-transparent bg-transparent p-0 text-primary underline-offset-4 hover:underline",
        // Transitional aliases keep product behavior stable while route files
        // move from the former primitive layer onto shadcn naming.
        primary: "border-primary bg-primary text-primary-foreground hover:border-accent-strong hover:bg-accent-strong",
        danger: "border-destructive/40 bg-destructive/10 text-destructive hover:border-destructive hover:bg-destructive/20",
      },
      size: {
        default: "h-9 px-4",
        sm: "h-7 rounded-md px-3 text-caption",
        lg: "h-11 rounded-md px-5 text-[14px]",
        icon: "h-9 w-9 p-0",
        md: "h-9 px-4",
      },
    },
    defaultVariants: { variant: "outline", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, type, ...props }, ref) => {
    const Component = asChild ? Slot : "button";
    return (
      <Component
        ref={ref}
        type={asChild ? undefined : (type ?? "button")}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";
