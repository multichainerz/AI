# OrcaSynapse web design system

The web application uses the shadcn local-source model on top of Tailwind CSS. It is not a second theme layered over the product: shadcn components consume the existing OrcaSynapse semantic variables, light/dark theme attribute, typography, and single sharp radius.

“Pure shadcn” is not a migration target. shadcn is the source-ownership model
for reusable controls; Tailwind remains the layout and composition language,
and complex OrcaSynapse surfaces remain deliberately product-specific.

## Source boundaries

- `src/components/ui/` contains canonical, reusable controls: alert, avatar, badge, button, card, dialog, input, label, native-select, separator, sheet, skeleton, switch, table, and textarea. (This list named a non-existent `select` — the file is `native-select.tsx`, exporting `NativeSelect` — and omitted `label`, which exists and is consumed by `src/ui/field.tsx`.)
- `src/ui/` contains product-level compositions such as readiness panels, metrics, locked states, and temporary compatibility exports. These compose `components/ui`; they must not create competing control styles.
- Route files may use Tailwind for layout and domain-specific presentation, but interactive controls must come from `components/ui` or an OrcaSynapse composition built from them.
- Lucide supplies functional interface icons. The Sivali orca and synapse artwork remain product assets.

## Token contract

`src/styles.css` owns the palette and maps it to shadcn semantic names (`background`, `foreground`, `card`, `primary`, `secondary`, `muted`, `destructive`, `input`, and `ring`). `[data-theme="light"]` overrides the same channel variables; components never branch on theme colors.

All non-circular surfaces resolve to `--radius-component` (`0`). `rounded-full` is reserved for true circles such as avatars, status dots, and switch thumbs.

Status is carried by words — a badge, a labelled fact, or the sentence itself —
and colour only reinforces text that already says the same thing. The 2px left
tone stripe (`border-l-2` with `border-l-good|warn|bad|accent`, usually over
`px-1 py-0.5`) that opened seven route views has been removed and should not
come back: every one of those banners already stated its state in prose, so the
stripe was a second vocabulary for a fact the reader had just read, and on a
resolved incident the two disagreed. The blockquote rule in `styles.css` stays —
a left rule on quoted text is typography, not a status signal.

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

Import it from its own module — `@/components/ui/<name>` — the way all sixteen
existing consumers do. **Do not add it to `src/components/ui/index.ts`.** That
barrel re-exports all fifteen modules and has no importers at all: this document
instructed contributors to maintain an export nobody consumes. Leaving it out
costs nothing, and a barrel is actively wrong for this app, whose views are code
split per route — one import through it would pull the whole control kit into
every chunk that touches a single button. The file itself should be deleted.

```bash
pnpm --filter @orcasynapse/web build
pnpm --filter @orcasynapse/web test
bash scripts/test-csp-closure.sh
```
