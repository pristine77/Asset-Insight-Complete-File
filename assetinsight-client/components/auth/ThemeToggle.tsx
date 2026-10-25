"use client";

import { Moon, Sun } from "lucide-react";
import { useColorMode } from "@/components/providers/ColorModeProvider";

export default function ThemeToggle() {
  const { resolvedTheme, setMode } = useColorMode();

  return (
    <div
      className="inline-flex h-11 items-center gap-1 rounded-[10px] border border-[var(--app-control-border)] bg-[var(--app-panel-alt)] p-1 shadow-[var(--app-shadow-control)]"
      role="group"
      aria-label="Color theme"
    >
      <button
        type="button"
        aria-label="Use light theme"
        aria-pressed={resolvedTheme === "light"}
        onClick={() => setMode("light")}
        className={`grid h-9 w-11 place-items-center rounded-md border transition-[border-color,background-color,color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)] ${
          resolvedTheme === "light"
            ? "border-[var(--app-info-border)] bg-[var(--app-panel)] text-[var(--app-accent)] shadow-[var(--app-shadow-control)]"
            : "border-transparent text-[var(--app-text-muted)] hover:bg-[var(--app-panel)] hover:text-[var(--app-text)]"
        }`}
      >
        <Sun className="h-[18px] w-[18px]" strokeWidth={1.8} />
      </button>
      <button
        type="button"
        aria-label="Use dark theme"
        aria-pressed={resolvedTheme === "dark"}
        onClick={() => setMode("dark")}
        className={`grid h-9 w-11 place-items-center rounded-md border transition-[border-color,background-color,color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)] ${
          resolvedTheme === "dark"
            ? "border-[var(--app-info-border)] bg-[var(--app-panel)] text-[var(--app-accent)] shadow-[var(--app-shadow-control)]"
            : "border-transparent text-[var(--app-text-muted)] hover:bg-[var(--app-panel)] hover:text-[var(--app-text)]"
        }`}
      >
        <Moon className="h-[18px] w-[18px]" strokeWidth={1.8} />
      </button>
    </div>
  );
}
