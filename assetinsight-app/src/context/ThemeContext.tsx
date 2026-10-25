import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';

const THEME_STORAGE_KEY = '@asset-insight:color-theme';

export type AppThemeMode = 'light' | 'dark' | 'system';

export type AppThemeColors = {
  background: string;
  surface: string;
  surfaceRaised: string;
  surfaceMuted: string;
  text: string;
  textSecondary: string;
  textMuted: string;
  border: string;
  borderStrong: string;
  accent: string;
  accentPressed: string;
  accentSoft: string;
  accentText: string;
  graphite: string;
  graphiteSoft: string;
  success: string;
  successSoft: string;
  warning: string;
  warningSoft: string;
  danger: string;
  dangerSoft: string;
  info: string;
  infoSoft: string;
  shadow: string;
  overlay: string;
};

export type AppTheme = {
  isDark: boolean;
  colors: AppThemeColors;
};

const lightColors: AppThemeColors = {
  background: '#F3F5F8',
  surface: '#FFFFFF',
  surfaceRaised: '#FFFFFF',
  surfaceMuted: '#EEF1F5',
  text: '#111827',
  textSecondary: '#475569',
  textMuted: '#7C8798',
  border: '#E0E5EC',
  borderStrong: '#CDD4DE',
  accent: '#E11D48',
  accentPressed: '#BE123C',
  accentSoft: '#FFF1F2',
  accentText: '#FFFFFF',
  graphite: '#15181D',
  graphiteSoft: '#252A32',
  success: '#07875F',
  successSoft: '#E6F7F0',
  warning: '#B76408',
  warningSoft: '#FFF4DB',
  danger: '#D62F3F',
  dangerSoft: '#FFF0F1',
  info: '#2563EB',
  infoSoft: '#EAF1FF',
  shadow: '#1F2937',
  overlay: 'rgba(9, 12, 18, 0.56)',
};

const darkColors: AppThemeColors = {
  background: '#0C0F13',
  surface: '#15191F',
  surfaceRaised: '#1B2027',
  surfaceMuted: '#232932',
  text: '#F7F9FC',
  textSecondary: '#C2CBD8',
  textMuted: '#8792A3',
  border: '#2A313B',
  borderStrong: '#39424E',
  accent: '#FB4F72',
  accentPressed: '#E11D48',
  accentSoft: '#3A1822',
  accentText: '#FFFFFF',
  graphite: '#080A0D',
  graphiteSoft: '#20252C',
  success: '#4AD3A2',
  successSoft: '#12352B',
  warning: '#F6B84A',
  warningSoft: '#3A2B12',
  danger: '#FF6B78',
  dangerSoft: '#3C191F',
  info: '#78A7FF',
  infoSoft: '#17294B',
  shadow: '#000000',
  overlay: 'rgba(0, 0, 0, 0.72)',
};

type ThemeContextValue = AppTheme & {
  mode: AppThemeMode;
  setMode: (mode: AppThemeMode) => void;
  toggleTheme: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemScheme = useColorScheme();
  const [mode, setModeState] = useState<AppThemeMode>('system');

  useEffect(() => {
    AsyncStorage.getItem(THEME_STORAGE_KEY)
      .then((storedMode) => {
        if (storedMode === 'light' || storedMode === 'dark' || storedMode === 'system') {
          setModeState(storedMode);
        }
      })
      .catch(() => {
        // A storage error should never prevent the app from using the system theme.
      });
  }, []);

  const setMode = useCallback((nextMode: AppThemeMode) => {
    setModeState(nextMode);
    void AsyncStorage.setItem(THEME_STORAGE_KEY, nextMode).catch(() => undefined);
  }, []);

  const resolvedMode = mode === 'system' ? (systemScheme === 'dark' ? 'dark' : 'light') : mode;
  const isDark = resolvedMode === 'dark';

  const toggleTheme = useCallback(() => {
    setMode(isDark ? 'light' : 'dark');
  }, [isDark, setMode]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      mode,
      isDark,
      colors: isDark ? darkColors : lightColors,
      setMode,
      toggleTheme,
    }),
    [isDark, mode, setMode, toggleTheme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useAppTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useAppTheme must be used inside ThemeProvider');
  }
  return context;
}
