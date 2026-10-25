"use client";

import {
  CssBaseline,
  GlobalStyles,
  ThemeProvider,
  alpha,
  createTheme,
  type PaletteMode,
} from "@mui/material";
import { AppRouterCacheProvider } from "@mui/material-nextjs/v15-appRouter";
import * as React from "react";

type AdminThemeContextValue = {
  mode: PaletteMode;
  toggleMode: () => void;
  setMode: (mode: PaletteMode) => void;
};

const AdminThemeContext = React.createContext<AdminThemeContextValue | undefined>(undefined);

function buildTheme(mode: PaletteMode) {
  const isDark = mode === "dark";
  const primary = isDark ? "#ef3340" : "#df111b";
  const secondary = isDark ? "#d5d7da" : "#30343a";
  const backgroundDefault = isDark ? "#151615" : "#ffffff";
  const backgroundPaper = isDark ? "#1d1e1d" : "#ffffff";
  const textPrimary = isDark ? "#f4f4f3" : "#17191d";
  const textSecondary = isDark ? "#a8aaad" : "#62666c";

  return createTheme({
    palette: {
      mode,
      primary: { main: primary },
      secondary: { main: secondary },
      success: { main: isDark ? "#40c997" : "#0a8f68" },
      warning: { main: isDark ? "#fbbf24" : "#d97706" },
      error: { main: isDark ? "#fb7185" : "#dc2626" },
      background: {
        default: backgroundDefault,
        paper: backgroundPaper,
      },
      text: {
        primary: textPrimary,
        secondary: textSecondary,
      },
      divider: isDark ? "#343634" : "#dedfe1",
    },
    shape: {
      borderRadius: 4,
    },
    typography: {
      fontFamily: "var(--font-geist-sans), Inter, Arial, sans-serif",
      h1: { fontWeight: 600, letterSpacing: "-0.025em" },
      h2: { fontWeight: 600, letterSpacing: "-0.02em" },
      h3: { fontWeight: 600, letterSpacing: "-0.018em" },
      button: { fontWeight: 600, textTransform: "none", letterSpacing: "-0.01em" },
    },
    shadows: [
      "none",
      "0px 8px 20px rgba(15,23,42,0.08)",
      "0px 10px 24px rgba(15,23,42,0.10)",
      "0px 12px 28px rgba(15,23,42,0.12)",
      "0px 16px 36px rgba(15,23,42,0.14)",
      "0px 20px 44px rgba(15,23,42,0.16)",
      "0px 24px 52px rgba(15,23,42,0.18)",
      "0px 28px 60px rgba(15,23,42,0.20)",
      "0px 32px 68px rgba(15,23,42,0.22)",
      "0px 36px 76px rgba(15,23,42,0.24)",
      "0px 40px 84px rgba(15,23,42,0.26)",
      "0px 44px 92px rgba(15,23,42,0.28)",
      "0px 48px 100px rgba(15,23,42,0.30)",
      "0px 52px 108px rgba(15,23,42,0.32)",
      "0px 56px 116px rgba(15,23,42,0.34)",
      "0px 60px 124px rgba(15,23,42,0.36)",
      "0px 64px 132px rgba(15,23,42,0.38)",
      "0px 68px 140px rgba(15,23,42,0.40)",
      "0px 72px 148px rgba(15,23,42,0.42)",
      "0px 76px 156px rgba(15,23,42,0.44)",
      "0px 80px 164px rgba(15,23,42,0.46)",
      "0px 84px 172px rgba(15,23,42,0.48)",
      "0px 88px 180px rgba(15,23,42,0.50)",
      "0px 92px 188px rgba(15,23,42,0.52)",
      "0px 96px 196px rgba(15,23,42,0.54)",
    ],
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          "*, *::before, *::after": {
            boxSizing: "border-box",
          },
          html: {
            colorScheme: mode,
          },
          body: {
            minHeight: "100vh",
            background: backgroundDefault,
            color: textPrimary,
          },
          a: {
            color: "inherit",
            textDecoration: "none",
          },
        },
      },
      MuiAppBar: {
        styleOverrides: {
          root: {
            backgroundImage: "none",
            boxShadow: "none",
          },
        },
      },
      MuiDrawer: {
        styleOverrides: {
          paper: {
            backgroundImage: "none",
          },
        },
      },
      MuiPaper: {
        styleOverrides: {
          root: {
            backgroundImage: "none",
            border: `1px solid ${isDark ? "#343634" : "#dedfe1"}`,
            boxShadow: "none",
          },
        },
      },
      MuiCard: {
        styleOverrides: {
          root: {
            borderRadius: 4,
            transform: "translateZ(0)",
            transition: "border-color 160ms ease, background-color 160ms ease",
          },
        },
      },
      MuiButton: {
        defaultProps: {
          disableElevation: true,
        },
        styleOverrides: {
          root: {
            borderRadius: 4,
            paddingInline: 14,
            minHeight: 36,
          },
          containedPrimary: {
            backgroundImage: "none",
            boxShadow: "none",
          },
        },
      },
      MuiChip: {
        styleOverrides: {
          root: {
            borderRadius: 999,
            fontWeight: 600,
          },
        },
      },
      MuiTextField: {
        defaultProps: {
          variant: "outlined",
        },
      },
      MuiOutlinedInput: {
        styleOverrides: {
          root: {
            borderRadius: 4,
            backgroundImage: "none",
          },
        },
      },
      MuiTableCell: {
        styleOverrides: {
          root: {
            borderColor: isDark ? "#343634" : "#dedfe1",
          },
          head: {
            fontWeight: 650,
            color: textPrimary,
          },
        },
      },
    },
  });
}

export function useAdminTheme() {
  const context = React.useContext(AdminThemeContext);
  if (!context) {
    throw new Error("useAdminTheme must be used inside AdminThemeProvider");
  }
  return context;
}

export default function AdminThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = React.useState<PaletteMode>("light");
  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    const saved = window.localStorage.getItem("admin-theme-mode");
    if (saved === "light" || saved === "dark") {
      setMode(saved);
    } else {
      setMode(window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    }
    setReady(true);
  }, []);

  React.useEffect(() => {
    if (!ready) return;
    window.localStorage.setItem("admin-theme-mode", mode);
    document.documentElement.dataset.theme = mode;
  }, [mode, ready]);

  const theme = React.useMemo(() => buildTheme(mode), [mode]);
  const value = React.useMemo<AdminThemeContextValue>(() => ({
    mode,
    setMode,
    toggleMode: () => setMode((prev) => (prev === "light" ? "dark" : "light")),
  }), [mode]);

  return (
    <AppRouterCacheProvider options={{ enableCssLayer: true }}>
      <AdminThemeContext.Provider value={value}>
        <ThemeProvider theme={theme}>
          <CssBaseline />
          <GlobalStyles
            styles={{
              ":root": {
                "--admin-surface": theme.palette.background.paper,
                "--admin-surface-muted": alpha(theme.palette.background.paper, mode === "dark" ? 0.72 : 0.84),
                "--admin-border": alpha(theme.palette.divider, 0.9),
                "--admin-text": theme.palette.text.primary,
                "--admin-text-muted": theme.palette.text.secondary,
                "--admin-primary": theme.palette.primary.main,
                "--admin-accent": theme.palette.secondary.main,
              },
            }}
          />
          {children}
        </ThemeProvider>
      </AdminThemeContext.Provider>
    </AppRouterCacheProvider>
  );
}
