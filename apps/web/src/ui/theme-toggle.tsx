import { useState } from "react";
import { currentTheme, toggleTheme, type Theme } from "../theme.js";
import { cn } from "./cn.js";

function MoonGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20.4 13.2A8.4 8.4 0 0 1 10.8 3.6a8.4 8.4 0 1 0 9.6 9.6z" fill="currentColor" fillOpacity="0.12" />
    </svg>
  );
}

function SunGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" fill="currentColor" fillOpacity="0.12" />
      <path d="M12 2.8v2.1M12 19.1v2.1M2.8 12h2.1M19.1 12h2.1M5.5 5.5 7 7M17 17l1.5 1.5M18.5 5.5 17 7M7 17l-1.5 1.5" />
    </svg>
  );
}

export function ThemeToggle({ tone = "surface" }: { tone?: "surface" | "brand" }) {
  const [theme, setTheme] = useState<Theme>(() => currentTheme());
  const light = theme === "light";

  return (
    <button
      type="button"
      role="switch"
      aria-checked={light}
      aria-label="Light appearance"
      title={`Switch to the ${light ? "dark" : "light"} theme`}
      className={cn("theme-toggle", tone === "brand" && "theme-toggle--brand")}
      data-mode={theme}
      onClick={() => setTheme(toggleTheme())}
    >
      <span className="theme-toggle__track" aria-hidden="true">
        <span className="theme-toggle__thumb">
          <span className="theme-toggle__moon"><MoonGlyph /></span>
          <span className="theme-toggle__sun"><SunGlyph /></span>
        </span>
      </span>
      <span className="theme-toggle__label">{light ? "Light" : "Dark"}</span>
    </button>
  );
}
