/**
 * Lite UI Foundation — semantic design tokens and adaptive layout.
 *
 * Pure, framework-agnostic contracts for the four-column workbench. These
 * mirror `docs/Runtime-Specification lite/12-UI-Architecture.md` §6–§9:
 *
 *   - semantic token families (surface/text/border/accent/status);
 *   - a Windows-first typography scale;
 *   - a 4 px spacing scale and bounded radii;
 *   - four-column width guidance and adaptive collapse modes;
 *   - dark/light contrast targets and status-not-color-only rules;
 *   - reduced-motion behavior.
 *
 * This module contains no React, no DOM, and no fetch. It is the shared
 * vocabulary the UI layer consumes, so the token system can be verified
 * independently of a browser.
 */

// ---------------------------------------------------------------------------
// Semantic color tokens
// ---------------------------------------------------------------------------

export const UI_THEMES = ['light', 'dark'] as const;
export type UiTheme = (typeof UI_THEMES)[number];

/** Semantic status families; never a bare hue. */
export const UI_STATUS_TOKENS = [
  'neutral',
  'running',
  'waiting',
  'success',
  'warning',
  'danger',
  'paused',
] as const;
export type UiStatusToken = (typeof UI_STATUS_TOKENS)[number];

export interface UiColorTokens {
  readonly surfaceBase: string;
  readonly surfaceSubtle: string;
  readonly surfaceRaised: string;
  readonly surfaceOverlay: string;
  readonly surfaceSelected: string;
  readonly textPrimary: string;
  readonly textSecondary: string;
  readonly textTertiary: string;
  readonly textDisabled: string;
  readonly borderSubtle: string;
  readonly borderDefault: string;
  readonly borderStrong: string;
  readonly focusRing: string;
  readonly accentDefault: string;
  readonly accentHover: string;
  readonly accentPressed: string;
  readonly status: Readonly<Record<UiStatusToken, string>>;
}

/**
 * Both themes derive from the same semantic names. Values are intentionally
 * opaque hex so contrast can be computed deterministically.
 */
export const UI_COLOR_TOKENS: Readonly<Record<UiTheme, UiColorTokens>> = Object.freeze({
  dark: Object.freeze({
    surfaceBase: '#0f1214',
    surfaceSubtle: '#161a1d',
    surfaceRaised: '#1d2326',
    surfaceOverlay: '#242b2f',
    surfaceSelected: '#2b3338',
    textPrimary: '#f2f0ea',
    textSecondary: '#c3c0b8',
    textTertiary: '#96999a',
    textDisabled: '#6b7073',
    borderSubtle: '#252b2f',
    borderDefault: '#333b40',
    borderStrong: '#4a555c',
    focusRing: '#e0834f',
    accentDefault: '#d2673b',
    accentHover: '#e0834f',
    accentPressed: '#b45232',
    status: Object.freeze({
      neutral: '#9aa3a7',
      running: '#5fa8d3',
      waiting: '#d3a15d',
      success: '#8fbf7f',
      warning: '#e0b062',
      danger: '#e07a6a',
      paused: '#a89ad6',
    }),
  }),
  light: Object.freeze({
    surfaceBase: '#f5f3ee',
    surfaceSubtle: '#ece9e2',
    surfaceRaised: '#ffffff',
    surfaceOverlay: '#ffffff',
    surfaceSelected: '#e2ded5',
    textPrimary: '#1c2326',
    textSecondary: '#495255',
    textTertiary: '#6b7376',
    textDisabled: '#9aa0a2',
    borderSubtle: '#e0dcd4',
    borderDefault: '#cdc8be',
    borderStrong: '#a9a49a',
    focusRing: '#b45232',
    accentDefault: '#b45232',
    accentHover: '#9c4527',
    accentPressed: '#7f381f',
    status: Object.freeze({
      neutral: '#5f676a',
      running: '#2f6f96',
      waiting: '#8a6417',
      success: '#3f6b32',
      warning: '#8a6417',
      danger: '#a33b2a',
      paused: '#5b4b8a',
    }),
  }),
});

// ---------------------------------------------------------------------------
// Contrast
// ---------------------------------------------------------------------------

const HEX_DIGITS = '0123456789abcdefABCDEF';

/** Parse an opaque `#rrggbb` color into channel values, or throw. */
function parseHexColor(hex: string): { r: number; g: number; b: number } {
  const trimmed = hex.trim();
  if (trimmed.length !== 7 || trimmed.charAt(0) !== '#') throw new Error('UI_TOKEN_INVALID_COLOR');
  const body = trimmed.slice(1);
  for (const char of body) {
    if (!HEX_DIGITS.includes(char)) throw new Error('UI_TOKEN_INVALID_COLOR');
  }
  const value = Number.parseInt(body, 16);
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}

function channel(value: number): number {
  const normalized = value / 255;
  return normalized <= 0.03928 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance for an opaque `#rrggbb` color. */
export function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHexColor(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two opaque colors (order-independent). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Minimum body-text contrast required by the Lite spec (§8). */
export const UI_BODY_CONTRAST_MIN = 4.5;

/**
 * Verify the body-text pairs of a theme meet the contrast target. Returns the
 * failing pairs so a test can name the exact token.
 */
export function findContrastViolations(
  theme: UiTheme,
  minimum = UI_BODY_CONTRAST_MIN,
): readonly string[] {
  const tokens = UI_COLOR_TOKENS[theme];
  const pairs: Array<[string, string]> = [
    ['textPrimary', tokens.surfaceBase],
    ['textPrimary', tokens.surfaceRaised],
    ['textSecondary', tokens.surfaceBase],
    ['textSecondary', tokens.surfaceRaised],
  ];
  return pairs
    .filter(([name, background]) => contrastRatio(tokens[name as 'textPrimary'], background) < minimum)
    .map(([name, background]) => `${theme}:${name}:${background}`);
}

// ---------------------------------------------------------------------------
// Typography and spacing
// ---------------------------------------------------------------------------

export const UI_TYPE_SCALE = Object.freeze({
  display: Object.freeze({ sizePx: 32, weight: 600 }),
  title: Object.freeze({ sizePx: 24, weight: 600 }),
  heading: Object.freeze({ sizePx: 18, weight: 600 }),
  body: Object.freeze({ sizePx: 14, weight: 400 }),
  dense: Object.freeze({ sizePx: 13, weight: 400 }),
  caption: Object.freeze({ sizePx: 12, weight: 400 }),
  micro: Object.freeze({ sizePx: 11, weight: 500 }),
  code: Object.freeze({ sizePx: 13, weight: 400 }),
} as const);
export type UiTypeToken = keyof typeof UI_TYPE_SCALE;

/** Windows-first system UI stack; code uses Cascadia Code with a monospace fallback. */
export const UI_FONT_STACK = Object.freeze({
  ui: '"Segoe UI", system-ui, -apple-system, "Noto Sans", sans-serif',
  code: '"Cascadia Code", "Cascadia Mono", Consolas, ui-monospace, monospace',
} as const);

/** 4 px base spacing scale. */
export const UI_SPACING_BASE_PX = 4;
export const UI_SPACING_SCALE = Object.freeze([0, 1, 2, 3, 4, 5, 6, 8, 10, 12] as const);
export function spacingPx(step: number): number {
  if (!Number.isSafeInteger(step) || step < 0 || step > 12) {
    throw new Error('UI_SPACING_STEP_INVALID');
  }
  return step * UI_SPACING_BASE_PX;
}

/** Radii stay small for rows/inputs and medium for cards; no uniform oversizing. */
export const UI_RADIUS_TOKENS = Object.freeze({
  input: 4,
  row: 6,
  card: 10,
  panel: 12,
  overlay: 16,
} as const);
export type UiRadiusToken = keyof typeof UI_RADIUS_TOKENS;

// ---------------------------------------------------------------------------
// Adaptive four-column layout
// ---------------------------------------------------------------------------

export const UI_COLUMNS = ['agents', 'conversations', 'canvas', 'inspector'] as const;
export type UiColumn = (typeof UI_COLUMNS)[number];

export interface UiColumnWidth {
  readonly min: number;
  readonly max: number;
}

/** Width guidance from `12-UI-Architecture.md` §6. */
export const UI_COLUMN_WIDTHS: Readonly<Record<UiColumn, UiColumnWidth>> = Object.freeze({
  agents: Object.freeze({ min: 220, max: 300 }),
  conversations: Object.freeze({ min: 240, max: 320 }),
  canvas: Object.freeze({ min: 560, max: Number.POSITIVE_INFINITY }),
  inspector: Object.freeze({ min: 300, max: 400 }),
});

export const UI_LAYOUT_MODES = ['wide', 'standard', 'compact'] as const;
export type UiLayoutMode = (typeof UI_LAYOUT_MODES)[number];

/** Minimum viewport width at which each mode applies. */
export const UI_LAYOUT_BREAKPOINTS = Object.freeze({
  wide: 1600,
  standard: 1120,
  compact: 0,
} as const);

/** Deterministic adaptive mode selection from a viewport width. */
export function resolveLayoutMode(viewportWidth: number): UiLayoutMode {
  if (!Number.isFinite(viewportWidth) || viewportWidth < 0) {
    throw new Error('UI_VIEWPORT_INVALID');
  }
  if (viewportWidth >= UI_LAYOUT_BREAKPOINTS.wide) return 'wide';
  if (viewportWidth >= UI_LAYOUT_BREAKPOINTS.standard) return 'standard';
  return 'compact';
}

/**
 * Columns visible in each mode. The Canvas is always present; narrower modes
 * collapse panels into overlay/sheet rather than dropping them permanently.
 */
export function visibleColumns(mode: UiLayoutMode): readonly UiColumn[] {
  switch (mode) {
    case 'wide': return ['agents', 'conversations', 'canvas', 'inspector'];
    case 'standard': return ['agents', 'conversations', 'canvas'];
    default: return ['agents', 'canvas'];
  }
}

/** The Canvas must never be squeezed below its minimum width. */
export function canvasWidthFor(viewportWidth: number): number {
  const mode = resolveLayoutMode(viewportWidth);
  const others = visibleColumns(mode)
    .filter(column => column !== 'canvas')
    .reduce((total, column) => total + UI_COLUMN_WIDTHS[column].min, 0);
  return Math.max(UI_COLUMN_WIDTHS.canvas.min, viewportWidth - others);
}

// ---------------------------------------------------------------------------
// Motion and reduced motion
// ---------------------------------------------------------------------------

export const UI_MOTION_TOKENS = Object.freeze({
  press: 90,
  micro: 140,
  crossfade: 180,
  panel: 240,
} as const);
export type UiMotionToken = keyof typeof UI_MOTION_TOKENS;

/**
 * Reduced motion replaces springs/translation with crossfade and disables
 * parallax, overshoot, and loops while preserving status feedback.
 */
export function resolveMotionDuration(token: UiMotionToken, reducedMotion: boolean): number {
  if (!reducedMotion) return UI_MOTION_TOKENS[token];
  // Crossfade is the only remaining transition; all movement collapses to 0.
  return token === 'crossfade' ? UI_MOTION_TOKENS.crossfade : 0;
}

export function shouldAnimateTransform(reducedMotion: boolean): boolean {
  return !reducedMotion;
}

/**
 * Flatten the semantic tokens of one theme into CSS custom properties, so the
 * four-column shell and any component consume tokens through a single boundary
 * rather than hard-coding colors. Framework-agnostic and deterministic.
 */
export function uiCssVariables(theme: UiTheme): Record<string, string> {
  const tokens = UI_COLOR_TOKENS[theme];
  const out: Record<string, string> = {
    '--surface-base': tokens.surfaceBase,
    '--surface-subtle': tokens.surfaceSubtle,
    '--surface-raised': tokens.surfaceRaised,
    '--surface-overlay': tokens.surfaceOverlay,
    '--surface-selected': tokens.surfaceSelected,
    '--text-primary': tokens.textPrimary,
    '--text-secondary': tokens.textSecondary,
    '--text-tertiary': tokens.textTertiary,
    '--text-disabled': tokens.textDisabled,
    '--border-subtle': tokens.borderSubtle,
    '--border-default': tokens.borderDefault,
    '--border-strong': tokens.borderStrong,
    '--focus-ring': tokens.focusRing,
    '--accent-default': tokens.accentDefault,
    '--accent-hover': tokens.accentHover,
    '--accent-pressed': tokens.accentPressed,
  };
  for (const [status, color] of Object.entries(tokens.status)) {
    out[`--status-${status}`] = color;
  }
  return out;
}

/** Column pixel width for a resolved layout, clamped to the token guidance. */
export function columnWidthPx(column: UiColumn, mode: UiLayoutMode): number {
  if (!UI_COLUMNS.includes(column)) throw new Error('UI_COLUMN_INVALID');
  if (!UI_LAYOUT_MODES.includes(mode)) throw new Error('UI_LAYOUT_MODE_INVALID');
  if (!visibleColumns(mode).includes(column)) return 0;
  return UI_COLUMN_WIDTHS[column].min;
}

// ---------------------------------------------------------------------------
// Accessibility rules
// ---------------------------------------------------------------------------

/** Status is never communicated by color alone. */
export const UI_STATUS_REQUIRES = Object.freeze({
  icon: true,
  text: true,
  accessibleName: true,
  colorOnly: false,
} as const);

/** Focus must remain visible and logical. */
export const UI_FOCUS_RULES = Object.freeze({
  visibleRing: true,
  logicalOrder: true,
  restoreAfterClose: true,
  streamStealsFocus: false,
  modalTrapOnlyForBlocking: true,
} as const);
