'use client';

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { readStoredTheme, THEME_STORAGE_KEY, type Theme } from './themePreference';

interface ThemeContextValue {
  theme: Theme;
  setTheme(theme: Theme): void;
  toggleTheme(): void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>('dark');
  const hasLoadedPreference = useRef(false);

  useEffect(() => {
    if (!hasLoadedPreference.current) {
      hasLoadedPreference.current = true;
      const savedTheme = readStoredTheme(window.localStorage);
      document.documentElement.dataset.theme = savedTheme;
      window.localStorage.setItem(THEME_STORAGE_KEY, savedTheme);
      setTheme(savedTheme);
      return;
    }

    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  return <ThemeContext.Provider value={{ theme, setTheme, toggleTheme: () => setTheme(current => current === 'dark' ? 'light' : 'dark') }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside ThemeProvider');
  return context;
}
