import type { LiquidGlassElementOptions } from 'apple-liquid-glass-webgl';

export type GlassTheme = 'dark' | 'light';

export type GlassSurfaceKind = 'composer' | 'chat-header' | 'page-header' | 'modal' | 'toast';

export interface GlassSurfaceSpec {
  /** Milky tint opacity, 0 (clear) to 1.5. */
  tint: number;
  /** Backdrop blur as a ratio of the short side, 0 to 1. */
  frost: number;
  /** Refraction strength passed to the V2 material. */
  refraction: number;
}

/**
 * Per-surface, per-theme liquid glass tokens. tintTone always follows the
 * active theme: dark chrome gets a dark milky layer, light chrome a light one.
 */
export const GLASS_SURFACE_SPECS: Record<GlassSurfaceKind, Record<GlassTheme, GlassSurfaceSpec>> = {
  composer: {
    dark: { tint: 0.55, frost: 0.3, refraction: 70 },
    light: { tint: 0.45, frost: 0.3, refraction: 70 },
  },
  'chat-header': {
    dark: { tint: 0.66, frost: 0.55, refraction: 55 },
    light: { tint: 0.58, frost: 0.55, refraction: 55 },
  },
  'page-header': {
    dark: { tint: 0.62, frost: 0.5, refraction: 55 },
    light: { tint: 0.52, frost: 0.5, refraction: 55 },
  },
  modal: {
    dark: { tint: 0.65, frost: 0.4, refraction: 50 },
    light: { tint: 0.55, frost: 0.4, refraction: 50 },
  },
  toast: {
    dark: { tint: 0.6, frost: 0.35, refraction: 55 },
    light: { tint: 0.5, frost: 0.35, refraction: 55 },
  },
};

export function glassOptionsFor(
  kind: GlassSurfaceKind,
  theme: GlassTheme,
  extra?: Pick<LiquidGlassElementOptions, 'targets'>,
): LiquidGlassElementOptions {
  const spec = GLASS_SURFACE_SPECS[kind][theme];
  return {
    tint: spec.tint,
    tintTone: theme === 'dark' ? 'dark' : 'light',
    frost: spec.frost,
    material: { refraction: spec.refraction },
    fallback: 'css',
    live: 'auto',
    maxDpr: 2,
    respectReducedTransparency: true,
    zIndex: -1,
    ...extra,
  };
}
