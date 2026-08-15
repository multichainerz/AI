import { useEffect, useRef } from "react";
import { cn } from "./ui/cn.js";

/**
 * The animated dot grid behind the sign-in and boot screens.
 *
 * Reimplemented from a WebGL reference rather than lifted from it. The original
 * ran the same effect as a GLSL fragment shader through Three.js, loaded from a
 * CDN at runtime — neither of which can ship here:
 *
 * - This product installs on-premise and is often air-gapped, and the container
 *   serves `script-src 'self'`. A `<script src="https://cdnjs…">` is refused by
 *   the browser, and the page would render with no background and no error an
 *   operator could see.
 * - The reference styles every element inline. `scripts/test-csp-closure.sh`
 *   fails the build on `style={{`, because the container serves
 *   `style-src 'self'` and the dev server sends no CSP header at all — so that
 *   class of break is invisible until it reaches a customer.
 *
 * A 2D canvas draws the same thing: a lattice of squares, each holding one of
 * ten opacities, each re-rolling on its own offset every few seconds, revealed
 * outward from the centre on mount. It costs no dependency and no network.
 *
 * Atmosphere, not information: `aria-hidden`, never focusable, and it stops
 * entirely under `prefers-reduced-motion`.
 */

/** Cell pitch and dot size, in CSS pixels — the reference's 20 and 6. */
const CELL = 20;
const DOT = 6;
/** Seconds a cell holds one opacity before re-rolling. */
const FREQUENCY = 5;
/** How fast the intro sweep travels outward from the centre. */
const REVEAL_SPEED = 3;
const OPACITIES: readonly number[] = [0.3, 0.3, 0.3, 0.5, 0.5, 0.5, 0.8, 0.8, 0.8, 1];

/**
 * A stable value in [0,1) for a cell.
 *
 * Deterministic on purpose. `Math.random()` per frame would make every cell
 * strobe; the reference gets its texture from each cell having a *fixed* phase,
 * so the same coordinates must always produce the same number.
 */
export function hash(x: number, y: number): number {
  const value = Math.sin(x * 127.1 + y * 311.7) * 43_758.545_3;
  return value - Math.floor(value);
}

export function DotGridField({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    let frame = 0;
    let width = 0;
    let height = 0;
    const started = performance.now();

    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const bounds = canvas.getBoundingClientRect();
      width = Math.max(1, Math.floor(bounds.width));
      height = Math.max(1, Math.floor(bounds.height));
      // Attributes, not CSS: the element's size comes from the stylesheet, and
      // writing `.style.` here is the exact thing the CSP gate forbids.
      canvas.width = Math.floor(width * ratio);
      canvas.height = Math.floor(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    const draw = (elapsed: number) => {
      context.clearRect(0, 0, width, height);
      const columns = Math.ceil(width / CELL);
      const rows = Math.ceil(height / CELL);
      const centreX = columns / 2;
      const centreY = rows / 2;
      const sweep = elapsed * REVEAL_SPEED;

      for (let column = 0; column < columns; column += 1) {
        for (let row = 0; row < rows; row += 1) {
          const phase = hash(column, row);
          // The reveal reaches a cell later the further it sits from the
          // centre, with a little jitter so the edge is a scatter and not a
          // clean expanding disc.
          const distance = Math.hypot(centreX - column, centreY - row);
          const arrival = distance * 0.01 + phase * 0.15;
          if (sweep < arrival) continue;

          const step = reduced ? 0 : Math.floor(elapsed / FREQUENCY + phase + FREQUENCY);
          const roll = hash(column * (step + 1), row * (step + 1));
          let alpha = OPACITIES[Math.floor(roll * OPACITIES.length)] ?? 0.3;
          // The brief overshoot as the sweep passes, which is what stops the
          // reveal reading as a wipe.
          if (sweep < arrival + 0.1) alpha = Math.min(1, alpha * 1.25);

          context.globalAlpha = alpha;
          context.fillRect(column * CELL, row * CELL, DOT, DOT);
        }
      }
      context.globalAlpha = 1;
    };

    // The dot colour comes from the stylesheet so both themes control it in one
    // place, and is re-read on resize rather than cached: a theme can change
    // under a mounted canvas.
    const paint = () => {
      context.fillStyle = getComputedStyle(canvas).color;
      draw((performance.now() - started) / 1000);
    };

    const onResize = () => { resize(); paint(); };
    resize();

    if (reduced) {
      // One frame, fully revealed, no loop.
      context.fillStyle = getComputedStyle(canvas).color;
      draw(Number.MAX_SAFE_INTEGER);
    } else {
      const loop = () => {
        paint();
        frame = window.requestAnimationFrame(loop);
      };
      loop();
    }

    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  return <canvas aria-hidden="true" className={cn("dot-grid-field", className)} ref={canvasRef} />;
}
