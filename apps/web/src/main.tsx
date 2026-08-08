// First, before styles or React: sets data-theme on <html> from storage, so the
// first painted frame is already in the operator's theme. CSP forbids the
// classic inline <head> snippet; the entry module is the earliest legal moment.
import "./theme.js";
import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./app.js";
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

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="application-failure" role="alert">
        <div className="brand-mark" aria-hidden="true">OS</div>
        <p className="page-kicker">Dashboard recovery</p>
        <h1>OrcaSynapse could not render this workspace</h1>
        <p>{this.state.error.message || "An unexpected interface error occurred."}</p>
        <button className="primary-button" type="button" onClick={() => window.location.reload()}>Reload dashboard</button>
      </main>
    );
  }
}

createRoot(root).render(
  <StrictMode>
    <ApplicationErrorBoundary><App /></ApplicationErrorBoundary>
  </StrictMode>,
);
