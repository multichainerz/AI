import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * Joins class names and lets a later utility win over an earlier one.
 *
 * Without the merge, `cn("px-3", props.className)` keeps both when the caller
 * passes `px-6` and the browser picks by stylesheet order rather than by intent
 * — so a component could not be adjusted at its call site. This is the one
 * helper every primitive depends on.
 *
 * It has to be told about the theme, because a merge that does not know a token
 * does not ignore it — it guesses, and a wrong guess deletes a class silently.
 * `text-*` is the whole problem: tailwind-merge's colour group matches any
 * `text-` class, so every custom size in `tailwind.config.ts` was being read as
 * a colour and dropped by the colour beside it. `text-micro text-faint` came out
 * as `text-faint`, `text-[#0a0a0b] text-body` as `text-body` — which is to say
 * the entire type scale was inert and the primary button had no text colour,
 * everywhere, with nothing in the markup to show for it.
 *
 * Registering the four sizes under `font-size` puts them in front of the colour
 * matcher, which is the only thing that separates the two.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      // The scale from `tailwind.config.ts`. Adding one there means adding it
      // here, and `cn.test.ts` fails if the two drift apart.
      "font-size": [{ text: ["micro", "caption", "label", "body", "figure", "display"] }],
      shadow: [{ shadow: ["overlay", "card"] }],
    },
    theme: { borderRadius: ["pill", "input", "card", "modal"] },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
