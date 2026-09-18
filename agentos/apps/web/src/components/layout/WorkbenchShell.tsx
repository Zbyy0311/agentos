'use client';

import { CSSProperties, ReactNode, useEffect, useRef, useState } from 'react';
import {
  UI_COLUMN_WIDTHS,
  UI_FONT_STACK,
  UI_RADIUS_TOKENS,
  UI_SPACING_BASE_PX,
  columnWidthPx,
  resolveLayoutMode,
  resolveMotionDuration,
  uiCssVariables,
  visibleColumns,
} from '../../lib/uiFoundation';
import type { UiColumn, UiTheme } from '../../lib/uiFoundation';

/**
 * Lite four-column workbench shell.
 *
 * Consumes the semantic token system from `lib/uiFoundation.ts` through a single
 * CSS-variable boundary; it hard-codes no color. Adaptive collapse follows the
 * frozen breakpoints, and panel collapse is client-only UI state — never a Runtime
 * Event (12-UI-Architecture.md section 6 + section 3 invariants).
 */

const COLUMN_META: Readonly<Record<UiColumn, { readonly label: string; readonly title: string; readonly role: 'navigation' | 'complementary' | 'main' }>> = Object.freeze({
  agents: Object.freeze({ label: 'Agents', title: '智能体', role: 'navigation' }),
  conversations: Object.freeze({ label: 'Conversations', title: '会话', role: 'complementary' }),
  canvas: Object.freeze({ label: 'Main Canvas', title: '对话画布', role: 'main' }),
  inspector: Object.freeze({ label: 'Inspector', title: '运行详情', role: 'complementary' }),
});

const COLUMN_ORDER: readonly UiColumn[] = ['agents', 'conversations', 'canvas', 'inspector'];

export interface WorkbenchShellProps {
  readonly theme: UiTheme;
  readonly viewportWidth: number;
  readonly reducedMotion?: boolean;
  readonly toolbar?: ReactNode;
  readonly agents: ReactNode;
  readonly conversations: ReactNode;
  readonly canvas: ReactNode;
  readonly inspector: ReactNode;
  /** Test seam: controlled collapsed set. Omit to manage internally (client UI state). */
  readonly collapsedColumns?: ReadonlySet<UiColumn>;
  readonly onToggleColumn?: (column: UiColumn) => void;
}

function columnStyle(column: UiColumn, mode: ReturnType<typeof resolveLayoutMode>, reducedMotion: boolean): CSSProperties {
  const width = columnWidthPx(column, mode);
  const compact = mode === 'compact';
  return {
    width: column === 'canvas' ? '100%' : compact && column === 'agents' ? UI_SPACING_BASE_PX * 16 : width,
    minWidth: column === 'canvas' ? compact ? 0 : UI_COLUMN_WIDTHS.canvas.min : compact && column === 'agents' ? UI_SPACING_BASE_PX * 16 : width,
    maxWidth: column === 'canvas' ? undefined : UI_COLUMN_WIDTHS[column].max,
    transition: `width ${resolveMotionDuration('panel', reducedMotion)}ms ease`,
  };
}

export function WorkbenchShell(props: WorkbenchShellProps) {
  const {
    theme, viewportWidth, reducedMotion = false, toolbar,
    agents, conversations, canvas, inspector,
    collapsedColumns, onToggleColumn,
  } = props;
  const [internalCollapsed, setInternalCollapsed] = useState<ReadonlySet<UiColumn>>(new Set());
  const [mobileDrawer, setMobileDrawer] = useState<UiColumn | null>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const collapsed = collapsedColumns ?? internalCollapsed;
  const toggleColumn = (column: UiColumn) => {
    if (mode !== undefined && mode !== 'wide' && column !== 'agents' && !visible.includes(column)) {
      setMobileDrawer(current => current === column ? null : column);
      return;
    }
    if (onToggleColumn !== undefined) {
      onToggleColumn(column);
      return;
    }
    setInternalCollapsed(previous => {
      const next = new Set(previous);
      if (next.has(column)) next.delete(column); else next.add(column);
      return next;
    });
  };
  const mode = resolveLayoutMode(viewportWidth);
  const visible = visibleColumns(mode);
  const content: Readonly<Record<UiColumn, ReactNode>> = Object.freeze({
    agents, conversations, canvas, inspector,
  });

  useEffect(() => {
    if (mobileDrawer === null) return;
    const previousActive = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const drawer = drawerRef.current;
    const focusableSelector = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const first = drawer?.querySelector<HTMLElement>(focusableSelector);
    first?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setMobileDrawer(null);
        return;
      }
      if (event.key !== 'Tab' || !drawer) return;
      const focusable = Array.from(drawer.querySelectorAll<HTMLElement>(focusableSelector)).filter(item => item.offsetParent !== null);
      if (focusable.length === 0) return;
      const firstFocusable = focusable[0];
      const lastFocusable = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === firstFocusable) { event.preventDefault(); lastFocusable.focus(); }
      else if (!event.shiftKey && document.activeElement === lastFocusable) { event.preventDefault(); firstFocusable.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      previousActive?.focus();
    };
  }, [mobileDrawer]);

  const shellStyle: CSSProperties = {
    ...uiCssVariables(theme),
    fontFamily: UI_FONT_STACK.ui,
    backgroundColor: 'var(--surface-base)',
    color: 'var(--text-primary)',
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    overflow: 'hidden',
  };

  return (
    <div data-agentos="workbench-shell" data-theme={theme} data-layout-mode={mode} style={shellStyle}>
      {toolbar === undefined ? null : (
        <div role="toolbar" aria-label="Workbench" style={{
          display: 'flex', alignItems: 'center', gap: UI_SPACING_BASE_PX * 2,
          padding: `${UI_SPACING_BASE_PX}px ${UI_SPACING_BASE_PX * 3}px`,
          backgroundColor: 'var(--surface-raised)', borderBottom: '1px solid var(--border-subtle)',
        }}>
          {toolbar}
        </div>
      )}
      <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {COLUMN_ORDER.map(column => {
          if (!visible.includes(column)) {
            // Collapsed to a slim affordance; the panel is not dropped permanently.
            return (
              <button
                key={column}
                type="button"
                aria-label={`Open ${COLUMN_META[column].label}`}
                aria-expanded={mobileDrawer === column ? 'true' : 'false'}
                onClick={() => toggleColumn(column)}
                style={{
                  width: UI_SPACING_BASE_PX * 7, flexShrink: 0, border: 'none',
                  borderRight: '1px solid var(--border-subtle)',
                  backgroundColor: 'var(--surface-subtle)', color: 'var(--text-secondary)',
                  cursor: 'pointer',
                }}
              >
                <span aria-hidden="true" style={{ writingMode: 'vertical-rl', fontSize: 11 }}>{COLUMN_META[column].label}</span>
              </button>
            );
          }
          if (collapsed.has(column) && column !== 'canvas') {
            return (
              <button
                key={column}
                type="button"
                aria-label={`Expand ${COLUMN_META[column].label}`}
                aria-expanded="false"
                onClick={() => toggleColumn(column)}
                style={{
                  width: UI_SPACING_BASE_PX * 7, flexShrink: 0, border: 'none',
                  borderRight: '1px solid var(--border-subtle)',
                  backgroundColor: 'var(--surface-subtle)', color: 'var(--text-secondary)',
                  cursor: 'pointer',
                }}
              >
                <span aria-hidden="true" style={{ writingMode: 'vertical-rl', fontSize: 11 }}>{COLUMN_META[column].label}</span>
              </button>
            );
          }
          const meta = COLUMN_META[column];
          return (
            <section
              key={column}
              role={meta.role}
              aria-label={meta.label}
              data-column={column}
              style={{
                ...columnStyle(column, mode, reducedMotion),
                flexShrink: column === 'canvas' ? 1 : 0,
                display: 'flex', flexDirection: 'column', minHeight: 0,
                backgroundColor: column === 'canvas' ? 'var(--surface-base)' : 'var(--surface-subtle)',
                borderRight: column === 'inspector' ? 'none' : '1px solid var(--border-subtle)',
                borderRadius: 0,
                overflow: 'hidden',
              }}
            >
              <header style={{
                padding: `${UI_SPACING_BASE_PX}px ${UI_SPACING_BASE_PX * 3}px`,
                borderBottom: '1px solid var(--border-subtle)',
                color: 'var(--text-secondary)',
                fontSize: 12, fontWeight: 600, letterSpacing: 0.2,
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              }}>
                <span>{meta.title}</span>
                {column !== 'canvas' ? (
                  <button
                    type="button"
                    aria-label={`Collapse ${meta.label}`}
                    aria-expanded="true"
                    onClick={() => toggleColumn(column)}
                    style={{ border: 'none', background: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', padding: UI_SPACING_BASE_PX }}
                  >
                    <span aria-hidden="true">‹</span>
                  </button>
                ) : null}
              </header>
              <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
                {content[column]}
              </div>
            </section>
          );
        })}
      </div>
      {mobileDrawer !== null && mode !== 'wide' && mobileDrawer !== 'agents' ? (
        <div className="runtime-mobile-drawer-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setMobileDrawer(null); }}>
          <section ref={drawerRef} tabIndex={-1} className="runtime-mobile-drawer" role="dialog" aria-modal="true" aria-label={COLUMN_META[mobileDrawer].label}>
            <header className="runtime-mobile-drawer-header"><span>{COLUMN_META[mobileDrawer].title}</span><button type="button" aria-label="关闭面板" onClick={() => setMobileDrawer(null)}>关闭</button></header>
            <div className="runtime-mobile-drawer-body">{content[mobileDrawer]}</div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
