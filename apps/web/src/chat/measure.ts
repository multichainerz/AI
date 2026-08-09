/**
 * The one column the chat thread is read in.
 *
 * Four different widths used to decide where a line ended: 940px on the
 * assistant row, 720px on the empty state, 600px on the user bubble and 940px
 * again on the composer. Nothing lined up, so the eye had to re-find the left
 * edge on every turn -- and a reply and the box it was typed into disagreed
 * about where the column was.
 *
 * Plain string constants rather than a Tailwind token, and that is deliberate:
 * tailwind-merge v2 has no `maxWidth` theme key, so a registered `max-w-measure`
 * could never be overridden at a call site and `ui/cn.test.ts` would not catch
 * it. An arbitrary `max-w-[46rem]` merges correctly.
 */

/**
 * The reading column. 46rem is roughly 75-85 characters at the transcript's
 * body size, which is where prose stops being a wall and starts being lines.
 *
 * Applied identically to the thread, the error banner, the composer and the
 * status strip beneath it, so all four share one left and right edge.
 */
export const THREAD_MEASURE = "mx-auto w-full max-w-[46rem]";

/**
 * The scrolling viewport the thread lives in.
 *
 * This replaces the `.chat-messages` stylesheet rule outright, so it has to
 * re-supply everything that rule provided: `min-height: 0` (without it the grid
 * row refuses to shrink and the composer is pushed off-screen), `overflow-y`,
 * the horizontal padding -- including the tighter figure the narrow-viewport
 * override used to hand back -- and the reserved scrollbar gutter, which is what
 * stops the column shifting sideways the moment an answer grows tall enough to
 * scroll.
 *
 * Mobile-first, so the tight padding is the base and the roomier one is the
 * `sm` step: the old rule needed a media query to say the same thing twice.
 */
export const THREAD_SCROLLER =
  "min-h-0 overflow-y-auto px-4 pb-6 pt-7 sm:px-6 [scrollbar-gutter:stable]";

/**
 * The band the composer sits in.
 *
 * Same horizontal padding and same reserved gutter as the thread above it, or
 * the message and the box it was typed into disagree about where the column
 * ends -- which is visible as a step every time the transcript starts scrolling.
 */
export const COMPOSER_ZONE =
  "border-t border-border bg-surface px-4 pb-3.5 pt-2.5 sm:px-6 [scrollbar-gutter:stable]";
