import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * The shadcn class composer, extended with OrcaSynapse's named type, radius,
 * and shadow tokens so caller overrides remain deterministic.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["micro", "caption", "label", "body", "read", "figure", "display"] }],
      shadow: [{ shadow: ["overlay", "card"] }],
    },
    theme: { borderRadius: ["pill", "input", "card", "modal"] },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
