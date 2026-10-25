"use client";

import { Moon, Sun } from "lucide-react";
import { IconButton, Tooltip } from "@mui/material";
import { useAdminTheme } from "@/app/components/providers/AdminThemeProvider";

export default function ThemeModeToggle({ variant = "default" }: { variant?: "default" | "sidebar" }) {
  const { mode, toggleMode } = useAdminTheme();

  return (
    <Tooltip title={mode === "dark" ? "Switch to light mode" : "Switch to dark mode"}>
      <IconButton
        onClick={toggleMode}
        color={variant === "sidebar" ? "inherit" : "primary"}
        sx={{
          width: variant === "sidebar" ? 40 : undefined,
          height: variant === "sidebar" ? 40 : undefined,
          border: variant === "sidebar" ? 0 : "1px solid",
          borderColor: variant === "sidebar" ? "transparent" : "divider",
          borderRadius: variant === "sidebar" ? 0 : 1,
          bgcolor: "transparent",
          color: variant === "sidebar" ? "#c7c9c7" : "primary.main",
          boxShadow: "none",
          "&:hover": {
            bgcolor: variant === "sidebar" ? "rgba(255,255,255,0.07)" : "action.hover",
            color: variant === "sidebar" ? "#fff" : "primary.main",
          },
        }}
      >
        {mode === "dark" ? <Sun size={19} /> : <Moon size={19} />}
      </IconButton>
    </Tooltip>
  );
}
