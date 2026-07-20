'use client';

import { useTheme } from './ThemeProvider';

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const nextTheme = theme === 'dark' ? 'light' : 'dark';
  return <button type="button" onClick={toggleTheme} className="theme-toggle" aria-label={`切换到${nextTheme === 'dark' ? '深色' : '浅色'}主题`} title={`切换到${nextTheme === 'dark' ? '深色' : '浅色'}主题`}>
    <span aria-hidden="true">{theme === 'dark' ? '☼' : '◐'}</span>
    <span className="theme-toggle-label">{theme === 'dark' ? '深色' : '浅色'}</span>
  </button>;
}
