import type { Config } from "tailwindcss";

/**
 * Tailwind reads its palette from the CSS custom properties in `styles.css`
 * rather than carrying its own.
 *
 * One source of truth matters here because the stylesheet and the utility
 * classes coexist for the whole migration: views move onto primitives one
 * release at a time, so a token changed in one place has to move both. Two
 * palettes would drift within a release.
 *
 * Config lives under `apps/web/` deliberately. `Dockerfile.web` copies an
 * explicit allowlist of root files, so a config at the repo root would never
 * reach the builder and Tailwind would emit an unconfigured stylesheet.
 */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  corePlugins: {
    /*
     * Preflight is off for the migration.
     *
     * Tailwind's reset unstyles headings, lists and form controls, and the
     * 2,000 lines in `styles.css` were written against browser defaults. Turning
     * it on now would restyle every view that has not been rebuilt yet. It goes
     * on in the release that migrates the last view.
     */
    preflight: false,
  },
  theme: {
    extend: {
      /*
       * Every colour is the `rgb(<channels> / <alpha-value>)` template, and that
       * form is required rather than stylistic: given a plain `var(--bad)`
       * holding a hex, Tailwind has nothing to split and emits **no rule at all**
       * for `bg-bad/10`. Twenty-five tinted backgrounds and borders were missing
       * that way — the class present in the DOM, the declaration absent from the
       * stylesheet. `ui/tokens.test.ts` fails if a colour is added in the short
       * form.
       */
      colors: {
        bg: "rgb(var(--bg-rgb) / <alpha-value>)",
        surface: "rgb(var(--surface-rgb) / <alpha-value>)",
        raised: "rgb(var(--raised-rgb) / <alpha-value>)",
        border: "rgb(var(--border-rgb) / <alpha-value>)",
        "border-strong": "rgb(var(--border-strong-rgb) / <alpha-value>)",
        text: "rgb(var(--text-rgb) / <alpha-value>)",
        muted: "rgb(var(--muted-rgb) / <alpha-value>)",
        faint: "rgb(var(--faint-rgb) / <alpha-value>)",
        accent: "rgb(var(--accent-rgb) / <alpha-value>)",
        "accent-strong": "rgb(var(--accent-strong-rgb) / <alpha-value>)",
        good: "rgb(var(--good-rgb) / <alpha-value>)",
        warn: "rgb(var(--warn-rgb) / <alpha-value>)",
        bad: "rgb(var(--bad-rgb) / <alpha-value>)",
      },
      fontFamily: {
        sans: "var(--sans)",
        mono: "var(--mono)",
      },
      fontSize: {
        // A micro-label names a figure without competing with it: small, tracked
        // and set in mono so a column of them lines up.
        micro: ["9px", { lineHeight: "1.4", letterSpacing: "0.11em" }],
        caption: ["10px", { lineHeight: "1.5" }],
        body: ["11px", { lineHeight: "1.6" }],
        figure: ["26px", { lineHeight: "1.1", letterSpacing: "-0.02em" }],
      },
      borderRadius: {
        // Brutalist: edges are sharp. Nothing here is softer than 4px, and the
        // pill radius exists only for the one control that must read as round.
        none: "0",
        DEFAULT: "4px",
        md: "4px",
        lg: "6px",
        pill: "999px",
      },
      boxShadow: {
        // Depth is expressed by border contrast, not by shadow. Overlays get the
        // single exception because they must detach from the page behind them.
        none: "none",
        overlay: "0 16px 48px rgba(0, 0, 0, .6)",
      },
    },
  },
  plugins: [],
} satisfies Config;
