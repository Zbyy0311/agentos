'use client';

import { useCallback, useEffect, useRef, useState, type RefCallback } from 'react';
import type { LiquidGlass, LiquidGlassElementOptions } from 'apple-liquid-glass-webgl';
import { glassOptionsFor, type GlassSurfaceKind, type GlassTheme } from '../../lib/glass';

/** Max simultaneous WebGL contexts this app budgeted for glass surfaces. */
export const GLASS_CONTEXT_BUDGET = 6;

const activeInstances = new Set<LiquidGlass>();
let budgetWarned = false;

function readTheme(): GlassTheme {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export interface UseLiquidGlassOptions {
  /** Render several descendants as glass on one shared canvas (one WebGL context). */
  targets?: LiquidGlassElementOptions['targets'];
  /** Set false to keep the element plain (no glass, no fallback attribute). */
  enabled?: boolean;
}

/**
 * Attaches an apple-liquid-glass-webgl surface to the referenced element.
 * The library is imported lazily inside an effect, so SSR and tests that
 * render to static markup never touch WebGL. Without WebGL2 the library
 * applies its CSS backdrop-filter fallback and marks the element with
 * data-liquid-glass="fallback"; styles must stay legible for both modes.
 */
export function useLiquidGlass<T extends HTMLElement>(
  kind: GlassSurfaceKind,
  options?: UseLiquidGlassOptions,
): RefCallback<T> {
  const [element, setElement] = useState<T | null>(null);
  const ref = useCallback<RefCallback<T>>(node => setElement(node), []);
  const targetsRef = useRef(options?.targets);
  targetsRef.current = options?.targets;
  const enabled = options?.enabled !== false;

  useEffect(() => {
    if (!element || !enabled) return undefined;
    let cancelled = false;
    let instance: LiquidGlass | null = null;
    let observer: MutationObserver | null = null;

    const buildOptions = () =>
      glassOptionsFor(kind, readTheme(), targetsRef.current ? { targets: targetsRef.current } : undefined);

    import('apple-liquid-glass-webgl')
      .then(mod => {
        if (cancelled || !element.isConnected) return;
        instance = new mod.LiquidGlass(element, buildOptions());
        activeInstances.add(instance);
        if (!budgetWarned && activeInstances.size > GLASS_CONTEXT_BUDGET && process.env.NODE_ENV !== 'production') {
          budgetWarned = true;
          console.warn(`[liquid-glass] ${activeInstances.size} active surfaces exceed budget ${GLASS_CONTEXT_BUDGET}`);
        }
        observer = new MutationObserver(() => {
          instance?.update(buildOptions());
        });
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      })
      .catch(() => {
        // Chunk load or unexpected WebGL failure: keep the CSS fallback look.
      });

    return () => {
      cancelled = true;
      observer?.disconnect();
      if (instance) {
        activeInstances.delete(instance);
        instance.destroy();
      }
    };
  }, [element, enabled, kind]);

  return ref;
}
