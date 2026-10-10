'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { readStoredTheme, THEME_STORAGE_KEY, type Theme } from './themePreference';

interface ThemeContextValue {
  theme: Theme;
  setTheme(theme: Theme): void;
  toggleTheme(): void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);
const THEME_TRANSITION_WINDOW_MS = 260;

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>('dark');
  const hasLoadedPreference = useRef(false);

  // Pure sync of state -> DOM/storage. The transition window is only opened
  // by an explicit toggle; a sync effect must not open it, otherwise dev
  // StrictMode remounts and stored-preference loads would animate on load.
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

  const toggleTheme = useCallback(() => {
    const root = document.documentElement;
    root.classList.add('theme-animating');
    window.setTimeout(() => root.classList.remove('theme-animating'), THEME_TRANSITION_WINDOW_MS);
    setTheme(current => current === 'dark' ? 'light' : 'dark');
  }, []);

  return <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside ThemeProvider');
  return context;
}
