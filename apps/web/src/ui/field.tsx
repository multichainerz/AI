import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { cn } from "./cn.js";

/**
 * Form controls.
 *
 * `Select` is a native `<select>` on purpose, not a custom listbox. shadcn's
 * Select is Radix, which positions its popup with inline styles the CSP
 * refuses; the native element needs no JavaScript, no portal and no positioning,
 * and it is the only option that behaves correctly on a touch device.
 */

const control =
  "w-full rounded border border-border bg-bg px-2.5 text-body text-text " +
  "placeholder:text-faint " +
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent " +
  "disabled:cursor-not-allowed disabled:opacity-40";

export function Field(props: {
  label: string;
  hint?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("grid gap-1.5", props.className)} htmlFor={props.htmlFor}>
      <span className="font-mono text-micro uppercase text-faint">{props.label}</span>
      {props.children}
      {props.hint ? <small className="text-caption leading-relaxed text-muted">{props.hint}</small> : null}
    </label>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(control, "h-9", className)} {...rest} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(control, "min-h-[88px] resize-y py-2 leading-relaxed", className)} {...rest} />;
}

export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(control, "h-9", className)} {...rest} />;
}
