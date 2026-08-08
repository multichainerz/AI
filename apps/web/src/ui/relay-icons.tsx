import type { SVGProps } from "react";
import { cn } from "./cn.js";

/**
 * The Relay icon set from the OrcaNeuron design system: soft duotone — a tint
 * fill at 14%, line work on top, and one solid "live node" accent per glyph.
 *
 * Adapted from the design project's RelayIcons.tsx for this product's
 * constraints: line and tint ride `currentColor`, so an icon takes its colour
 * from the text beside it like every other glyph in the system, and the node
 * dot is painted through the `fill-node` utility so it follows the theme (cyan
 * in dark, a deeper teal in light). The upstream file hard-coded all three,
 * which would have needed a recolor prop at every call site and still missed
 * the theme switch.
 *
 * Presentation attributes only — no inline `style`, per `style-src 'self'`.
 *
 * The set is complete rather than trimmed to what the product currently draws:
 * eleven of these are on screen today and the rest are not. They are kept
 * deliberately, because they cost users nothing — each icon is a separate
 * export with no side effects, so the bundler drops every unreferenced one.
 * Verified rather than assumed: distinctive path data from four unused icons
 * appears zero times in `dist/assets/*.js`. Deleting them would only mean
 * fetching them back from the design project the next time a screen needs one.
 */

export type IconProps = SVGProps<SVGSVGElement> & { size?: number | string };

function Svg({ size = 16, className, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn("shrink-0", className)}
      {...rest}
    >
      {children}
    </svg>
  );
}

/* Shorthand for the two recurring fills. */
const TINT = { fill: "currentColor", fillOpacity: 0.14, stroke: "none" } as const;
const NODE = { className: "fill-node", stroke: "none" } as const;

export function NodeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="3.4" fill="currentColor" fillOpacity={0.14} />
      <path d="M12 8.6V6.2M14.8 13.8 17.6 15.6M9.2 13.8 6.4 15.6" />
      <circle cx="18.4" cy="16.4" r="1.7" {...TINT} />
      <circle cx="5.6" cy="16.4" r="1.7" {...TINT} />
      <circle cx="12" cy="4.4" r="2" {...NODE} />
    </Svg>
  );
}

export function FederationIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 7 18 7 12 17.5Z" {...TINT} />
      <circle cx="6" cy="6.5" r="2.1" fill="currentColor" fillOpacity={0.14} />
      <circle cx="18" cy="6.5" r="2.1" fill="currentColor" fillOpacity={0.14} />
      <circle cx="12" cy="18" r="2.3" {...NODE} />
    </Svg>
  );
}

export function SyncIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="6.6" {...TINT} />
      <path d="M5 10.6A7.4 7.4 0 0 1 17.6 7" />
      <path d="M17.6 3.2 17.9 7 14.1 6.6" />
      <path d="M19 13.4A7.4 7.4 0 0 1 6.4 17" />
      <path d="M6.4 20.8 6.1 17 9.9 17.4" />
      <circle cx="12" cy="12" r="1.8" {...NODE} />
    </Svg>
  );
}

export function RegionIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.2" fill="currentColor" fillOpacity={0.14} />
      <path d="M3.8 12h16.4M12 3.8c2.5 2.4 2.5 14 0 16.4M12 3.8c-2.5 2.4-2.5 14 0 16.4" />
      <circle cx="16.2" cy="7.8" r="1.8" {...NODE} />
    </Svg>
  );
}

export function SecurityIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 2.8 5 5.8v5.4c0 4.2 3 6.9 7 8.6 4-1.7 7-4.4 7-8.6V5.8z" fill="currentColor" fillOpacity={0.14} />
      <path d="M8.8 11.8 11 14l4.2-4.4" className="stroke-node" strokeWidth={2.3} />
    </Svg>
  );
}

export function ContainerIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 2.6 20.4 7v10L12 21.4 3.6 17V7z" fill="currentColor" fillOpacity={0.14} />
      <path d="M3.6 7 12 11.5 20.4 7M12 11.5V21.4" />
      <circle cx="8.2" cy="13.4" r="1.6" {...NODE} />
    </Svg>
  );
}

export function NetworkIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="5" cy="18.5" r="2.1" fill="currentColor" fillOpacity={0.14} />
      <circle cx="19" cy="18.5" r="2.1" fill="currentColor" fillOpacity={0.14} />
      <path d="M12 7.8V12M5 16.4V12h14v4.4" />
      <circle cx="12" cy="5.5" r="2.3" {...NODE} />
    </Svg>
  );
}

export function IdentityIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="9" r="3.6" fill="currentColor" fillOpacity={0.14} />
      <path d="M5.4 19.6a6.6 6.6 0 0 1 13.2 0" fill="currentColor" fillOpacity={0.14} />
      <circle cx="17.6" cy="6.4" r="1.8" {...NODE} />
    </Svg>
  );
}

export function DeployIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 2.6c3 1.6 5 5.2 5 9.4L14.4 14.6H9.6L7 12c0-4.2 2-7.8 5-9.4z" fill="currentColor" fillOpacity={0.14} />
      <path d="M9.6 14.6 7.4 20M14.4 14.6 16.6 20" />
      <circle cx="12" cy="9.4" r="1.9" {...NODE} />
    </Svg>
  );
}

export function ScalingIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="9" y="9" width="6" height="6" rx="1.8" fill="currentColor" fillOpacity={0.14} />
      <path d="M4.5 4.5 8 8M19.5 4.5 16 8M4.5 19.5 8 16M19.5 19.5 16 16M4 8V4.5H7.5M20 8V4.5H16.5M4 16v3.5H7.5M20 16v3.5H16.5" />
      <circle cx="12" cy="12" r="1.5" {...NODE} />
    </Svg>
  );
}

export function StorageIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 6.2v11.6c0 1.7 3.1 3 7 3s7-1.3 7-3V6.2" fill="currentColor" fillOpacity={0.14} />
      <ellipse cx="12" cy="6.2" rx="7" ry="3" fill="currentColor" fillOpacity={0.14} />
      <path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3" />
      <circle cx="12" cy="6.2" r="1.5" {...NODE} />
    </Svg>
  );
}

export function ServerIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.6" y="4.5" width="16.8" height="6.4" rx="2" fill="currentColor" fillOpacity={0.14} />
      <rect x="3.6" y="13.1" width="16.8" height="6.4" rx="2" fill="currentColor" fillOpacity={0.14} />
      <circle cx="7" cy="7.7" r="1.4" {...NODE} />
      <circle cx="7" cy="16.3" r="1.4" {...NODE} />
    </Svg>
  );
}

export function CpuIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="6" y="6" width="12" height="12" rx="2.6" fill="currentColor" fillOpacity={0.14} />
      <rect x="9.3" y="9.3" width="5.4" height="5.4" rx="1.4" {...NODE} />
      <path d="M9 6V3.2M15 6V3.2M9 20.8V18M15 20.8V18M6 9H3.2M6 15H3.2M20.8 9H18M20.8 15H18" />
    </Svg>
  );
}

export function KeyIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="3.8" fill="currentColor" fillOpacity={0.14} />
      <path d="M10.7 10.7 19 19M15.6 16.6 18 14.2M13.2 19 15.2 17" />
      <circle cx="8" cy="8" r="1.4" {...NODE} />
    </Svg>
  );
}

export function LockIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4.8" y="10" width="14.4" height="10.2" rx="3" fill="currentColor" fillOpacity={0.14} />
      <path d="M8 10V6.8a4 4 0 0 1 8 0V10" />
      <circle cx="12" cy="14.8" r="1.7" {...NODE} />
    </Svg>
  );
}

export function ApiIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9 8 4.8 12 9 16M15 8l4.2 4-4.2 4" />
      <circle cx="12" cy="12" r="1.8" {...NODE} />
    </Svg>
  );
}

export function GatewayIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 20V9.5l8-5 8 5V20Z" fill="currentColor" fillOpacity={0.14} />
      <path d="M9 20v-5a3 3 0 0 1 6 0v5" className="fill-surface" />
      <circle cx="12" cy="8.4" r="1.6" {...NODE} />
    </Svg>
  );
}

export function BalancerIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="5" cy="19" r="2.1" fill="currentColor" fillOpacity={0.14} />
      <circle cx="12" cy="19" r="2.1" fill="currentColor" fillOpacity={0.14} />
      <circle cx="19" cy="19" r="2.1" fill="currentColor" fillOpacity={0.14} />
      <path d="M12 7.3v3.2M5 16.9v-3.4h14v3.4M12 13.5v3.4" />
      <circle cx="12" cy="5" r="2.3" {...NODE} />
    </Svg>
  );
}

export function SnapshotIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.2" fill="currentColor" fillOpacity={0.14} />
      <path d="M12 7.4V12l3.4 2" />
      <circle cx="12" cy="12" r="1.5" {...NODE} />
    </Svg>
  );
}

export function MonitorIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2.6" y="5" width="18.8" height="13" rx="3" fill="currentColor" fillOpacity={0.14} />
      <path d="M6 12h2.5l1.5-3.5L13 16l1.4-4H18" />
      <path d="M9 18v2.5h6V18" />
      <circle cx="18" cy="12" r="1.5" {...NODE} />
    </Svg>
  );
}

export function TagIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 4.5h7.2l8.3 8.3a2 2 0 0 1 0 2.8l-4.4 4.4a2 2 0 0 1-2.8 0L4 11.7z" fill="currentColor" fillOpacity={0.14} />
      <circle cx="8.4" cy="8.4" r="1.7" {...NODE} />
    </Svg>
  );
}

export function TerminalIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.4" y="5" width="17.2" height="14" rx="3" fill="currentColor" fillOpacity={0.14} />
      <path d="M7 10l3 2.6-3 2.6" />
      <path d="M12.8 15.6h4.4" className="stroke-node" strokeWidth={2.3} />
    </Svg>
  );
}

export function LinkIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 12l-2 2a3.6 3.6 0 0 0 5.1 5.1l2-2" fill="currentColor" fillOpacity={0.14} />
      <path d="M16 12l2-2a3.6 3.6 0 0 0-5.1-5.1l-2 2" fill="currentColor" fillOpacity={0.14} />
      <path d="M9.4 14.6 14.6 9.4" />
      <circle cx="12" cy="12" r="1.5" {...NODE} />
    </Svg>
  );
}

export function LayersIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3.2 3.2 8 12 12.8 20.8 8z" fill="currentColor" fillOpacity={0.14} />
      <path d="M3.2 12 12 16.8 20.8 12M3.2 16 12 20.8 20.8 16" />
      <circle cx="12" cy="8" r="1.6" {...NODE} />
    </Svg>
  );
}

export function AlertIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3.8 3 19.2h18z" fill="currentColor" fillOpacity={0.14} />
      <path d="M12 9.5v4.2" />
      <circle cx="12" cy="16.6" r="1.5" {...NODE} />
    </Svg>
  );
}

/** The settings gear from the design's header, in the same duotone voice. */
export function GearIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path
        d="M12 3.1h1.9l.5 2.4 2 .84 2.05-1.32 1.35 1.35-1.32 2.05.84 2 2.4.5v1.9l-2.4.5-.84 2 1.32 2.05-1.35 1.35-2.05-1.32-2 .84-.5 2.4h-1.9l-.5-2.4-2-.84-2.05 1.32-1.35-1.35 1.32-2.05-.84-2-2.4-.5v-1.9l2.4-.5.84-2L4.55 6.37 5.9 5.02 7.95 6.34l2-.84z"
        fill="currentColor"
        fillOpacity={0.14}
      />
      <circle cx="12" cy="12" r="3.1" />
      <circle cx="12" cy="12" r="1.4" {...NODE} />
    </Svg>
  );
}
