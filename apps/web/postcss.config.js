/**
 * Tailwind v3 on the PostCSS pipeline, deliberately not v4.
 *
 * v4's `@tailwindcss/oxide` ships a native binary and needs a postinstall
 * script, and `pnpm-workspace.yaml` allows build scripts only for `esbuild`.
 * pnpm would skip it silently and the binary would never be wired up. v3 is
 * pure JavaScript and needs no allowlist change.
 */
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
