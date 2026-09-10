'use client';

import { UI_FONT_STACK, UI_SPACING_BASE_PX, UI_RADIUS_TOKENS, uiCssVariables } from '../../lib/uiFoundation';
import type { UiTheme } from '../../lib/uiFoundation';
import {
  HISTORY_KINDS,
  groupHistoryByKind,
  historyReferenceTarget,
  type HistoryEntry,
  type HistoryKind,
  type HistorySearchFilters,
} from '../../lib/historySearch';

/**
 * Agent History + Search view (Lite 09 §13, 12 §16).
 *
 * Unified Agent History across Provider changes: filters by kind/status/conversation/
 * task/run/provider/time plus a label search, results grouped by kind, each linking to
 * its canonical source record. No content search and no raw-transcript surface: secrets
 * and Provider-native transcripts are never indexed.
 */

export interface HistorySearchViewProps {
  readonly theme: UiTheme;
  readonly filters: HistorySearchFilters;
  readonly entries: readonly HistoryEntry[];
  readonly loading: boolean;
  readonly error?: string;
  readonly onFiltersChange: (next: HistorySearchFilters) => void;
  readonly onOpenReference: (entry: HistoryEntry) => void;
}

const KIND_LABELS: Readonly<Record<HistoryKind, string>> = Object.freeze({
  conversation: 'Conversations',
  message: 'Messages',
  turn: 'Turns',
  task: 'Tasks',
  run: 'Runs',
  memory: 'Memory',
  'context-snapshot': 'Context Snapshots',
  'turn-context': 'Turn Contexts',
  artifact: 'Artifacts',
});

function FilterInput(props: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly type?: string;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11, color: 'var(--text-tertiary)' }}>
      {props.label}
      <input
        type={props.type ?? 'text'}
        aria-label={props.label}
        data-filter={props.label}
        value={props.value}
        placeholder={props.placeholder ?? ''}
        onChange={event => props.onChange(event.target.value)}
        style={{
          border: '1px solid var(--border-default)', borderRadius: UI_RADIUS_TOKENS.input,
          backgroundColor: 'var(--surface-raised)', color: 'var(--text-primary)',
          padding: `${UI_SPACING_BASE_PX}px ${UI_SPACING_BASE_PX * 2}px`, fontFamily: 'inherit', fontSize: 12,
        }}
      />
    </label>
  );
}

export function HistorySearchView(props: HistorySearchViewProps) {
  const { theme, filters, entries, loading, error, onFiltersChange, onOpenReference } = props;
  const groups = groupHistoryByKind(entries);

  const set = (patch: Partial<HistorySearchFilters>) => onFiltersChange({ ...filters, ...patch });
  const clear = (key: keyof HistorySearchFilters) => {
    const next = { ...filters } as Record<string, unknown>;
    delete next[key];
    onFiltersChange(next as unknown as HistorySearchFilters);
  };

  return (
    <div
      data-agentos="history-search-view"
      style={{
        ...uiCssVariables(theme),
        fontFamily: UI_FONT_STACK.ui,
        backgroundColor: 'var(--surface-base)',
        color: 'var(--text-primary)',
        padding: UI_SPACING_BASE_PX * 3,
        overflow: 'auto', height: '100%',
      }}
    >
      <div style={{ display: 'flex', gap: UI_SPACING_BASE_PX * 2, flexWrap: 'wrap', marginBottom: UI_SPACING_BASE_PX * 3 }}>
        <FilterInput label="agent" value={filters.agentId} onChange={value => set({ agentId: value })} />
        <FilterInput label="q" value={filters.q ?? ''} placeholder="titles only" onChange={value => (value ? set({ q: value }) : clear('q'))} />
        <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11, color: 'var(--text-tertiary)' }}>
          kind
          <select
            aria-label="kind"
            data-filter="kind"
            value={filters.kind ?? ''}
            onChange={event => (event.target.value ? set({ kind: event.target.value as HistoryKind }) : clear('kind'))}
            style={{
              border: '1px solid var(--border-default)', borderRadius: UI_RADIUS_TOKENS.input,
              backgroundColor: 'var(--surface-raised)', color: 'var(--text-primary)', padding: UI_SPACING_BASE_PX,
            }}
          >
            <option value="">all</option>
            {HISTORY_KINDS.map(kind => <option key={kind} value={kind}>{kind}</option>)}
          </select>
        </label>
        <FilterInput label="status" value={filters.status ?? ''} onChange={value => (value ? set({ status: value }) : clear('status'))} />
        <FilterInput label="conversationId" value={filters.conversationId ?? ''} onChange={value => (value ? set({ conversationId: value }) : clear('conversationId'))} />
        <FilterInput label="taskId" value={filters.taskId ?? ''} onChange={value => (value ? set({ taskId: value }) : clear('taskId'))} />
        <FilterInput label="runId" value={filters.runId ?? ''} onChange={value => (value ? set({ runId: value }) : clear('runId'))} />
        <FilterInput label="providerConfigId" value={filters.providerConfigId ?? ''} onChange={value => (value ? set({ providerConfigId: value }) : clear('providerConfigId'))} />
        <FilterInput label="from" type="datetime-local" value={filters.from ?? ''} onChange={value => (value ? set({ from: value }) : clear('from'))} />
        <FilterInput label="to" type="datetime-local" value={filters.to ?? ''} onChange={value => (value ? set({ to: value }) : clear('to'))} />
      </div>

      <div aria-live="polite" style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: UI_SPACING_BASE_PX * 2 }}>
        {loading ? 'Loading…' : `${entries.length} result${entries.length === 1 ? '' : 's'}`}
      </div>

      {error === undefined ? null : (
        <div role="alert" style={{ color: 'var(--status-danger)', fontSize: 12, marginBottom: UI_SPACING_BASE_PX * 2 }}>{error}</div>
      )}

      {!loading && entries.length === 0 ? (
        <p style={{ margin: 0, color: 'var(--text-tertiary)', fontSize: 12 }}>
          No history for this Agent with the current filters.
        </p>
      ) : null}

      {groups.map(group => (
        <section key={group.kind} data-history-group={group.kind} style={{ marginBottom: UI_SPACING_BASE_PX * 3 }}>
          <h3 style={{ margin: `0 0 ${UI_SPACING_BASE_PX}px 0`, fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>
            {KIND_LABELS[group.kind]} ({group.entries.length})
          </h3>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {group.entries.map(entry => {
              const target = historyReferenceTarget(entry);
              return (
                <li key={`${entry.kind}:${entry.id}`} data-history-entry={entry.kind} style={{
                  display: 'flex', justifyContent: 'space-between', gap: UI_SPACING_BASE_PX,
                  padding: `${UI_SPACING_BASE_PX}px 0`, borderBottom: '1px solid var(--border-subtle)', fontSize: 12,
                }}>
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {entry.label ?? entry.id}
                  </span>
                  <span style={{ color: 'var(--text-tertiary)', flexShrink: 0 }}>
                    {entry.status ?? ''} {entry.at}
                  </span>
                  {target.id === null ? null : (
                    <button
                      type="button"
                      data-history-reference={target.kind}
                      onClick={() => onOpenReference(entry)}
                      style={{
                        border: 'none', background: 'none', color: 'var(--accent-default)',
                        cursor: 'pointer', fontSize: 12, flexShrink: 0, padding: 0,
                      }}
                    >
                      open
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
