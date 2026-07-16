export type Theme = 'dark' | 'light';

export const THEME_STORAGE_KEY = 'agentos-theme';

export function readStoredTheme(storage?: Pick<Storage, 'getItem'>): Theme {
  try {
    const saved = storage?.getItem(THEME_STORAGE_KEY);
    return saved === 'light' || saved === 'dark' ? saved : 'dark';
  } catch {
    return 'dark';
  }
}
