import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "./cn.js";

/**
 * The one button.
 *
 * Six ad-hoc classes did this job before — `primary-button`, `secondary-button`,
 * `danger-button`, `text-button`, `stop-button`, `send-button` — applied by hand
 * across the views, each with its own padding and hover treatment. A variant
 * table makes the set closed: there is no seventh kind of button without adding
 * one here on purpose.
 *
 * Brutalist reading: square edges, a real border on every variant, no shadow, no
 * gradient. Emphasis comes from fill and border weight alone.
 */
const button = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded font-medium " +
    "border transition-colors duration-150 " +
    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent " +
    "disabled:cursor-not-allowed disabled:opacity-40",
  {
    variants: {
      variant: {
        primary: "text-[#0a0a0b] border-accent bg-accent hover:bg-accent-strong hover:border-accent-strong",
        secondary: "text-text border-border-strong bg-raised hover:border-faint",
        ghost: "text-muted border-transparent bg-transparent hover:text-text hover:bg-raised",
        danger: "text-bad border-bad/40 bg-bad/10 hover:bg-bad/20 hover:border-bad",
      },
      size: {
        sm: "h-7 px-2.5 text-[10px]",
        md: "h-9 px-3.5 text-body",
        lg: "h-11 px-5 text-[12px]",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof button> {
  children?: ReactNode;
}

export function Button({ className, variant, size, type, ...rest }: ButtonProps) {
  return (
    // Defaulted to "button": an unspecified type inside a form submits it, which
    // is never what a control rendered mid-form intends.
    <button type={type ?? "button"} className={cn(button({ variant, size }), className)} {...rest} />
  );
}
