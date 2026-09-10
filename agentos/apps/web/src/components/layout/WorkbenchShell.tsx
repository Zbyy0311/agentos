'use client';

import { CSSProperties, ReactNode, useState } from 'react';
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
} from '../../lib/uiFoundation.js';
import type { UiColumn, UiTheme } from '../../lib/uiFoundation.js';

/**
 * Lite four-column workbench shell.
 *
 * Consumes the semantic token system from `lib/uiFoundation.ts` through a single
 * CSS-variable boundary; it hard-codes no color. Adaptive collapse follows the
 * frozen breakpoints, and panel collapse is client-only UI state — never a Runtime
 * Event (12-UI-Architecture.md section 6 + section 3 invariants).
 */

const COLUMN_META: Readonly<Record<UiColumn, { readonly label: string; readonly role: 'navigation' | 'complementary' | 'main' }>> = Object.freeze({
  agents: Object.freeze({ label: 'Agents', role: 'navigation' }),
  conversations: Object.freeze({ label: 'Conversations', role: 'complementary' }),
  canvas: Object.freeze({ label: 'Main Canvas', role: 'main' }),
  inspector: Object.freeze({ label: 'Inspector', role: 'complementary' }),
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
  return {
    width: column === 'canvas' ? '100%' : width,
    minWidth: column === 'canvas' ? UI_COLUMN_WIDTHS.canvas.min : width,
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
  const collapsed = collapsedColumns ?? internalCollapsed;
  const toggleColumn = (column: UiColumn) => {
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
                <span>{meta.label}</span>
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
    </div>
  );
}
