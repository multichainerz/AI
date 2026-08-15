// First, before styles or React: sets data-theme on <html> from storage, so the
// first painted frame is already in the operator's theme. CSP forbids the
// classic inline <head> snippet; the entry module is the earliest legal moment.
import "./theme.js";
import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./app.js";
import { DotGridField } from "./dot-grid-field.js";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("OrcaSynapse root element is missing.");

interface ApplicationErrorBoundaryState {
  error: Error | null;
}

class ApplicationErrorBoundary extends Component<{ children: ReactNode }, ApplicationErrorBoundaryState> {
  state: ApplicationErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ApplicationErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, details: ErrorInfo): void {
    console.error("OrcaSynapse dashboard render failed", error, details.componentStack);
  }

  /*
   * The recovery screen, drawn in the design system's own language: the Panel
   * surface, the Sivali mark on the accent-soft tile the empty states use, a
   * mono micro-label, and the primary Button's exact class list.
   *
   * Spelled out rather than composed from `ui/`: this renders only once React
   * has already thrown, and the module that failed may well be a sibling of
   * those primitives. The only shared rendering element is the inert synapse
   * drawing already loaded by the application; the recovery controls remain
   * plain elements and token classes. Class names, never `style` — `style-src
   * 'self'` blocks inline styles, and a CSP violation here would be silent.
   */
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="relative isolate flex min-h-screen items-center justify-center overflow-hidden bg-bg px-6 py-12" role="alert">
        <DotGridField className="dot-grid-field--boot" />
        <div className="relative z-[1] w-full max-w-[520px] rounded-card border border-border bg-surface p-7 shadow-card sm:p-9">
          <div aria-hidden="true" className="grid h-[46px] w-[46px] place-items-center rounded-pill bg-soft">
            <img src="/brand/sivali-mark.svg" alt="" width={28} height={28} className="block" />
          </div>
          <p className="mb-0 mt-5 font-mono text-micro font-medium uppercase text-faint">Dashboard recovery</p>
          <h1 className="mt-2 font-display text-[26px] font-semibold leading-[1.2] tracking-[-0.03em] text-text">
            OrcaSynapse could not render this workspace.
          </h1>
          <p className="mb-0 mt-3 break-words text-body leading-relaxed text-muted">
            {this.state.error.message || "An unexpected interface error occurred."}
          </p>
          <button
            type="button"
            className={
              "mt-7 inline-flex h-9 items-center justify-center gap-2 whitespace-nowrap rounded-pill border px-4 " +
              "text-body font-semibold text-onaccent border-accent bg-accent transition-colors duration-150 " +
              "hover:bg-accent-strong hover:border-accent-strong " +
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            }
            onClick={() => window.location.reload()}
          >
            Reload dashboard
          </button>
        </div>
      </main>
    );
  }
}

createRoot(root).render(
  <StrictMode>
    <ApplicationErrorBoundary><App /></ApplicationErrorBoundary>
  </StrictMode>,
);
