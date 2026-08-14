import type { ReactNode } from "react";
import { Input } from "../components/ui/input.js";
import { Label } from "../components/ui/label.js";
import { NativeSelect as Select } from "../components/ui/native-select.js";
import { Textarea } from "../components/ui/textarea.js";
import { cn } from "./cn.js";

/**
 * Form controls.
 *
 * `Select` is a native `<select>` on purpose, not a custom listbox. shadcn's
 * Select is Radix, which positions its popup with inline styles the CSP
 * refuses; the native element needs no JavaScript, no portal and no positioning,
 * and it is the only option that behaves correctly on a touch device.
 */

export function Field(props: {
  label: string;
  hint?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Label className={cn("grid gap-1.5", props.className)} htmlFor={props.htmlFor}>
      <span className="text-micro font-semibold uppercase tabular-nums text-faint">{props.label}</span>
      {props.children}
      {props.hint ? <small className="text-caption leading-relaxed text-muted">{props.hint}</small> : null}
    </Label>
  );
}

export { Input, Select, Textarea };
