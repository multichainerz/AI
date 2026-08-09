/**
 * Whether a streaming answer should keep scrolling itself into view.
 *
 * The transcript used to scroll on every message change, which during a
 * streaming turn is several times a second: scrolling up to re-read something
 * yanked the view back down before the sentence finished. Scrolling away is the
 * reader saying they want to be somewhere else, and the only correct response is
 * to stop following until they come back.
 *
 * A pure function of three numbers rather than a hook, because jsdom reports
 * every scroll metric as zero -- a component test therefore exercises exactly
 * one case and cannot tell a working rule from a missing one.
 */

/**
 * How far from the bottom still counts as being at the bottom, in pixels.
 *
 * Not zero: fractional scroll metrics rarely land exactly on the bottom, and a
 * reader who nudges the wheel a few pixels has not asked to stop following.
 * Wide enough to absorb both, narrow enough that a deliberate scroll away is
 * always respected.
 */
export const STICK_TO_BOTTOM_SLACK = 64;

export interface ScrollExtent {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

export function shouldStickToBottom({ scrollHeight, scrollTop, clientHeight }: ScrollExtent): boolean {
  return scrollHeight - scrollTop - clientHeight <= STICK_TO_BOTTOM_SLACK;
}
