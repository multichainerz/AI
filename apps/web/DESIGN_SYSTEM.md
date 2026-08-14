# OrcaSynapse web design system

The web application uses the shadcn local-source model on top of Tailwind CSS. It is not a second theme layered over the product: shadcn components consume the existing OrcaSynapse semantic variables, light/dark theme attribute, typography, and single semi-rounded radius.

## Source boundaries

- `src/components/ui/` contains canonical, reusable controls: button, card, input, textarea, select, switch, dialog, sheet, alert, badge, avatar, separator, skeleton, and table.
- `src/ui/` contains product-level compositions such as readiness panels, metrics, locked states, and temporary compatibility exports. These compose `components/ui`; they must not create competing control styles.
- Route files may use Tailwind for layout and domain-specific presentation, but interactive controls must come from `components/ui` or an OrcaSynapse composition built from them.
- Lucide supplies functional interface icons. The Sivali orca and synapse artwork remain product assets.

## Token contract

`src/styles.css` owns the palette and maps it to shadcn semantic names (`background`, `foreground`, `card`, `primary`, `secondary`, `muted`, `destructive`, `input`, and `ring`). `[data-theme="light"]` overrides the same channel variables; components never branch on theme colors.

All non-circular surfaces resolve to `--radius-component`. `rounded-full` is reserved for true circles such as avatars, status dots, and switch thumbs.

## Security and accessibility

- Production keeps `style-src 'self'`; components must not inject stylesheets or JSX `style` attributes.
- Dialogs trap focus, close on Escape or backdrop activation, restore focus, and lock document scrolling.
- Controls require accessible names, visible keyboard focus, and semantic disabled states.
- Self-hosted fonts and same-origin assets are the only allowed visual dependencies.

## Adding a component

Use shadcn conventions, adapt colors to the semantic RGB variables, export it from `src/components/ui/index.ts`, and add focused interaction/SSR coverage. Run the web build, web test suite, and CSP closure check before handoff.
