/**
 * Application-level design compositions.
 *
 * Canonical controls live under `components/ui`, following shadcn's local
 * source model. This module keeps OrcaSynapse-specific compositions (metrics,
 * readiness states and locked screens) together while route imports migrate
 * without creating a second primitive system.
 */
export { cn } from "./cn.js";
export { Button, type ButtonProps } from "./button.js";
export { HeroBanner, Mark, Metric, MetricRow, MicroLabel, PageHeader, Panel, PanelHeading, Tile, type HeroBannerProps, type MetricProps } from "./surface.js";
export { Alert, EmptyState, LockedScreen, StatusText, toneFor, type Tone } from "./feedback.js";
export { Dialog, Drawer } from "./overlay.js";
export { StepList, type StepListItem, type StepListStatus } from "./step-list.js";
export { Field, Input, Select, Textarea } from "./field.js";
