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
  /*
   * Preflight is on as of ai-v1.65.0.
   *
   * It was off for the whole migration so Tailwind's reset could not restyle
   * the views still on the old stylesheet. Every view is now built from the
   * primitive set, so the reset is what the design system wants: consistent
   * box sizing, no inherited heading sizes, and — the one that mattered —
   * `border-style: solid` on every element, which the hand-written rule in
   * `styles.css` was standing in for.
   */

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
        // The violet used *behind white text*. Distinct from `accent` because
        // that one is tuned to read against a dark surface, and white over it
        // measures 3.40:1 — below AA at any opacity.
        "accent-fill": "rgb(var(--accent-fill-rgb) / <alpha-value>)",
        // Text set on an accent fill. Near-black in dark (the design's violet is
        // light enough to carry it), white in light — a token, because guessing
        // per call site is how one theme ends up illegible.
        onaccent: "rgb(var(--onaccent-rgb) / <alpha-value>)",
        // The accent-soft fill for chips, chat bubbles and avatars — a solid
        // computed against the surface, so it reads identically everywhere.
        soft: "rgb(var(--soft-rgb) / <alpha-value>)",
        good: "rgb(var(--good-rgb) / <alpha-value>)",
        warn: "rgb(var(--warn-rgb) / <alpha-value>)",
        bad: "rgb(var(--bad-rgb) / <alpha-value>)",
        // The cyan "live node" — one dot of it per composition, never more.
        node: "rgb(var(--node-rgb) / <alpha-value>)",
        // The deep-violet brand panel behind the sidebar and the login hero.
        // Identical in both themes; content on it is always white-on-violet.
        brand: "rgb(var(--brand-rgb) / <alpha-value>)",
        // Overlay backdrops, always used with an alpha modifier (bg-backdrop/50).
        backdrop: "rgb(var(--backdrop-rgb) / <alpha-value>)",
      },
      fontFamily: {
        sans: "var(--sans)",
        display: "var(--display)",
        mono: "var(--mono)",
      },
      fontSize: {
        // A micro-label names a figure without competing with it: small,
        // uppercase, tracked, tabular.
        micro: ["10px", { lineHeight: "1.4", letterSpacing: "0.08em" }],
        caption: ["11px", { lineHeight: "1.5" }],
        // The step the scale was missing. Written as `text-[12px]` forty times
        // across the views before it existed — the size a dense row label wants
        // when caption is too quiet and body too loud.
        label: ["12px", { lineHeight: "1.5" }],
        body: ["13px", { lineHeight: "1.55" }],
        // Chat is the one screen the product asks people to read prose on, and
        // console density is wrong for prose: the answer text was 12px in a
        // 940px column, about 130 characters a line. This is the reading step —
        // used by the transcript and nothing else, so the dense tables in
        // Operations keeps `body` and does not reflow.
        read: ["15.5px", { lineHeight: "1.65" }],
        // KPI-column value and hero stat number, both Space Grotesk.
        figure: ["22px", { lineHeight: "1.1", letterSpacing: "-0.02em" }],
        display: ["40px", { lineHeight: "1.05", letterSpacing: "-0.03em" }],
      },
      borderRadius: {
        /*
         * One semi-rounded silhouette for every interactive control and
         * container. The aliases stay because they describe component roles,
         * but they deliberately resolve to one token so a modal, card, input,
         * chip and button cannot drift into separate visual systems again.
         * `rounded-full` remains Tailwind's semantic escape hatch for actual
         * circles such as avatars, status dots and switch thumbs.
         */
        DEFAULT: "var(--radius-component)",
        sm: "var(--radius-component)",
        md: "var(--radius-component)",
        lg: "var(--radius-component)",
        xl: "var(--radius-component)",
        "2xl": "var(--radius-component)",
        "3xl": "var(--radius-component)",
        input: "var(--radius-component)",
        card: "var(--radius-component)",
        modal: "var(--radius-component)",
        pill: "var(--radius-component)",
      },
      boxShadow: {
        // Themed through variables: dark separates by border contrast and casts
        // nothing; light carries the design's soft card shadow.
        card: "var(--shadow-card)",
        overlay: "var(--shadow-overlay)",
      },
    },
  },
  plugins: [],
} satisfies Config;
