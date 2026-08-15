import { useState } from "react";
import { Moon, Sun } from "lucide-react";
import { currentTheme, toggleTheme, type Theme } from "../theme.js";
import { Switch } from "../components/ui/switch.js";
import { cn } from "./cn.js";

export function ThemeToggle({ tone = "surface" }: { tone?: "surface" | "brand" }) {
  const [theme, setTheme] = useState<Theme>(() => currentTheme());
  const light = theme === "light";

  return (
    <Switch
      checked={light}
      aria-label="Light appearance"
      title={`Switch to the ${light ? "dark" : "light"} theme`}
      className={cn("theme-toggle__track", tone === "brand" && "theme-toggle--brand")}
      data-mode={theme}
      thumb={(
        <span className="theme-toggle__thumb">
          <span className="theme-toggle__moon"><Moon aria-hidden="true" /></span>
          <span className="theme-toggle__sun"><Sun aria-hidden="true" /></span>
        </span>
      )}
      onCheckedChange={() => setTheme(toggleTheme())}
    />
  );
}
