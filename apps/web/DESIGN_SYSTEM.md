# OrcaSynapse web design system

The web application uses the shadcn local-source model on top of Tailwind CSS. It is not a second theme layered over the product: shadcn components consume the existing OrcaSynapse semantic variables, light/dark theme attribute, typography, and single sharp radius.

“Pure shadcn” is not a migration target. shadcn is the source-ownership model
for reusable controls; Tailwind remains the layout and composition language,
and complex OrcaSynapse surfaces remain deliberately product-specific.

## Source boundaries

- `src/components/ui/` contains canonical, reusable controls: alert, avatar, badge, button, card, dialog, input, label, loading-state, native-select, separator, sheet, skeleton, switch, table, and textarea. Import each from its own module (`@/components/ui/<name>`); the directory deliberately has no barrel — the views are code-split per route, and one import through a barrel would pull the whole control kit into every chunk that touches a single button.
- `src/ui/` contains product-level compositions. The load-bearing set lives in `surface.tsx` and is what every screen is built from: `Panel` (the outer card), `Tile` (the surface inside one — a row, an item), `PageHeader` / `PanelHeading` / `MicroLabel` (the three heading weights), `Metric` / `MetricRow` / `HeroBanner` (figures), `Mark` (the initials/glyph tile), and `WorkspaceIntro` / `WorkspaceDock` (the title card and filter dock on viewport-locked workspaces). These compose `components/ui`; they must not create competing control styles, and a screen must not hand-roll markup these already provide.
- Route files may use Tailwind for layout and domain-specific presentation, but interactive controls must come from `components/ui` or an OrcaSynapse composition built from them.
- Lucide supplies functional interface icons. Refresh is always `RefreshCw` — one action, one glyph, product-wide. The Sivali orca and synapse artwork remain product assets.

## Token contract

`src/styles.css` owns the palette and maps it to shadcn semantic names (`background`, `foreground`, `card`, `primary`, `secondary`, `muted`, `destructive`, `input`, and `ring`). `[data-theme="light"]` overrides the same channel variables; components never branch on theme colors.

All non-circular surfaces resolve to `--radius-component` (`0`). `rounded-full` is reserved for true circles such as avatars and status dots. The switch used to be listed here too — its track and thumb are rectangles, not circles, and drawing the execution kill switch as a capsule made the product's most consequential control look borrowed from another toolkit.

Status is carried by words — a badge, a labelled fact, or the sentence itself —
and colour only reinforces text that already says the same thing. The 2px left
tone stripe (`border-l-2` with `border-l-good|warn|bad|accent`, usually over
`px-1 py-0.5`) that opened seven route views has been removed and should not
come back: every one of those banners already stated its state in prose, so the
stripe was a second vocabulary for a fact the reader had just read, and on a
resolved incident the two disagreed. The blockquote rule in `styles.css` stays —
a left rule on quoted text is typography, not a status signal.

## Figures and honesty

Every stat is Space Grotesk (`font-display`) with `tabular-nums`, over a
`MicroLabel` kicker and above a caption one step down — the hierarchy `Metric`
encodes. Figures obey four rules the code enforces in several places and this
document now states once:

- A figure names the window it covers ("/ 24h", "all time", "now" for a live
  state). A count without a period is not a fact.
- A value the deployment has not produced renders as "—", never as `0`. Absence
  and zero are different claims.
- A proportion bar draws only when its denominator exists. An empty track under
  a dash says "nothing is ready" when the truth is "nothing has happened".
- Panels never mix windows without labelling each cell; prefer one window per
  region, stated once.

## Texture

The dot-grid field (`workspace-intro-field`) belongs to a title row and to
nothing else. It is texture behind a name, never behind working controls,
figures, or content — running it under a switch or a metric row was the
mistake that produced this rule.

## Vocabulary

Operator-facing copy says "session", not "run", for the things people execute
and read back. Internal identifiers and contracts keep their names; the rename
is for prose the operator reads.

## Security and accessibility

- Production keeps `style-src 'self'`; components must not inject stylesheets or JSX `style` attributes.
- Dialogs trap focus, close on Escape or backdrop activation, restore focus, and lock document scrolling.
- Controls require accessible names, visible keyboard focus, and semantic disabled states.
- Self-hosted fonts and same-origin assets are the only allowed visual dependencies.
- The dependency-free crash boundary in `src/main.tsx` may use a native button because it must render even when the application component graph cannot load.

## Current exceptions

- Native elements inside canonical primitives are implementation details, not a second design system.
- `NativeSelect` deliberately uses the platform `<select>` instead of a custom popover so keyboard behavior and the production CSP stay predictable.
- Dialog and Switch follow shadcn composition and accessibility conventions but are local CSP-safe implementations. Radix Slot is allowed; Popper-style primitives that inject positioning styles are not.
- `src/ui` remains while routes consume OrcaSynapse domain compositions. Remove an export only when its callers have moved or the composition itself is obsolete; do not mechanically flatten domain UI into route files.

## Adding a component

Use shadcn conventions, adapt colors to the semantic RGB variables, and add focused interaction/SSR coverage. Run the web build, web test suite, and CSP closure check before handoff.

Import it from its own module — `@/components/ui/<name>` — the way every
existing consumer does. Do not create a `components/ui` barrel; the one that
existed re-exported every module and had no importers, and it has been deleted.
(`src/ui/index.js` is a different thing — a consumed composition barrel — and
stays.)

```bash
pnpm --filter @orcasynapse/web build
pnpm --filter @orcasynapse/web test
bash scripts/test-csp-closure.sh
```
