'use client';

import type { ReactNode } from 'react';
import { UI_FONT_STACK, UI_SPACING_BASE_PX, UI_RADIUS_TOKENS, uiCssVariables } from '../../lib/uiFoundation.js';
import type { UiTheme } from '../../lib/uiFoundation.js';

/**
 * Lite Runtime Inspector view (13-Runtime-Inspector.md).
 *
 * Progressive disclosure over the merged Inspector projection: overview, stages,
 * processes, events, memory. Every fact references a canonical record; the Inspector
 * renders state and never decides outcomes, and no section failure breaks the page.
 */

export interface InspectorRunOverviewDto {
  readonly runId: string;
  readonly taskId: string;
  readonly status: string;
  readonly reason: string;
  readonly origin: string;
  readonly attempt: number | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly durationMs: number | null;
  readonly lastEventSequence: number;
}

export interface InspectorStageDto {
  readonly stageId: string;
  readonly workflowStageKey: string;
  readonly status: string;
  readonly attempt: number;
  readonly durationMs?: number;
  readonly failureCode?: string;
}

export interface InspectorProcessDto {
  readonly processId: string;
  readonly status: string;
  readonly platform: string;
  readonly nativePidEvidenceOnly: number | null;
  readonly exitCode: number | null;
  readonly terminationReason: string | null;
}

export interface InspectorEventDto {
  readonly eventId: string;
  readonly sequence: number;
  readonly type: string;
  readonly timestamp: string;
  readonly severity: string;
}

export interface InspectorMemoryDto {
  readonly totalTokens: number;
  readonly truncated: boolean;
  readonly selectedCount: number;
}

export interface InspectorProjectionDto {
  readonly overview: InspectorRunOverviewDto;
  readonly stages: readonly InspectorStageDto[];
  readonly processes: readonly InspectorProcessDto[];
  readonly events: readonly InspectorEventDto[];
  readonly highWatermark: number;
  readonly memoryContext: InspectorMemoryDto | null;
  readonly truncated: boolean;
}

export interface RuntimeInspectorViewProps {
  readonly theme: UiTheme;
  readonly projection: InspectorProjectionDto;
  readonly error?: string;
}

function Section(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section style={{ marginBottom: UI_SPACING_BASE_PX * 4 }}>
      <h3 style={{
        margin: `0 0 ${UI_SPACING_BASE_PX}px 0`, fontSize: 12, fontWeight: 600,
        color: 'var(--text-secondary)', letterSpacing: 0.2, textTransform: 'uppercase',
      }}>
        {props.title}
      </h3>
      {props.children}
    </section>
  );
}

function Field(props: { readonly label: string; readonly value: ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: UI_SPACING_BASE_PX, fontSize: 12 }}>
      <dt style={{ color: 'var(--text-tertiary)', minWidth: 120 }}>{props.label}</dt>
      <dd style={{ margin: 0, color: 'var(--text-primary)', fontFamily: 'inherit' }}>{props.value}</dd>
    </div>
  );
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function RuntimeInspectorView(props: RuntimeInspectorViewProps) {
  const { theme, projection, error } = props;
  const { overview, stages, processes, events, memoryContext } = projection;
  return (
    <div
      data-agentos="runtime-inspector"
      style={{
        ...uiCssVariables(theme),
        fontFamily: UI_FONT_STACK.ui,
        backgroundColor: 'var(--surface-base)',
        color: 'var(--text-primary)',
        padding: UI_SPACING_BASE_PX * 3,
        overflow: 'auto', height: '100%',
      }}
    >
      {error === undefined ? null : (
        <div role="alert" style={{ color: 'var(--status-danger)', marginBottom: UI_SPACING_BASE_PX * 2 }}>{error}</div>
      )}

      <Section title="Run">
        <dl style={{ margin: 0, display: 'grid', rowGap: 2 }}>
          <Field label="Run" value={overview.runId} />
          <Field label="Task" value={overview.taskId} />
          <Field label="status" value={<span data-status={overview.status}>{overview.status}</span>} />
          <Field label="reason" value={overview.reason} />
          <Field label="origin" value={overview.origin} />
          <Field label="attempt" value={overview.attempt ?? '—'} />
          <Field label="duration" value={formatDuration(overview.durationMs)} />
          <Field label="last event seq" value={overview.lastEventSequence} />
        </dl>
      </Section>

      <Section title={`Stages (${stages.length})`}>
        {stages.length === 0 ? (
          <p style={{ margin: 0, color: 'var(--text-tertiary)' }}>No stages.</p>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {stages.map(stage => (
              <li key={stage.stageId} data-stage={stage.stageId} style={{
                display: 'flex', justifyContent: 'space-between', padding: `${UI_SPACING_BASE_PX}px 0`,
                borderBottom: '1px solid var(--border-subtle)', fontSize: 12,
              }}>
                <span>{stage.workflowStageKey}</span>
                <span data-status={stage.status}>{stage.status}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={`Processes (${processes.length})`}>
        {processes.map(process => (
          <div key={process.processId} data-process={process.processId} style={{ fontSize: 12, marginBottom: UI_SPACING_BASE_PX }}>
            <span style={{ color: 'var(--text-primary)' }}>{process.processId}</span>
            <span style={{ color: 'var(--text-tertiary)' }}>
              {' '}{process.platform} · {process.status}
              {process.nativePidEvidenceOnly === null ? '' : ` · pid ${process.nativePidEvidenceOnly} (evidence)`}
              {process.exitCode === null ? '' : ` · exit ${process.exitCode}`}
            </span>
          </div>
        ))}
      </Section>

      <Section title={`Events (${events.length})`}>
        {events.length === 0 ? (
          <p style={{ margin: 0, color: 'var(--text-tertiary)' }}>No events.</p>
        ) : (
          <ol style={{ margin: 0, padding: 0, listStyle: 'none' }}>
            {events.map(event => (
              <li key={event.eventId} data-event-seq={event.sequence} style={{ fontSize: 12, padding: `${UI_SPACING_BASE_PX / 2}px 0` }}>
                <span style={{ color: 'var(--text-tertiary)', fontFamily: UI_FONT_STACK.code }}>#{event.sequence}</span>
                {' '}<span>{event.type}</span>
                {' '}<span style={{ color: 'var(--text-tertiary)' }}>{event.severity}</span>
              </li>
            ))}
          </ol>
        )}
      </Section>

      <Section title="Memory Context">
        {memoryContext === null ? (
          <p style={{ margin: 0, color: 'var(--text-tertiary)' }}>No Memory Context snapshot.</p>
        ) : (
          <dl style={{ margin: 0, display: 'grid', rowGap: 2 }}>
            <Field label="total tokens" value={memoryContext.totalTokens} />
            <Field label="truncated" value={memoryContext.truncated ? 'yes' : 'no'} />
            <Field label="selected entries" value={memoryContext.selectedCount} />
          </dl>
        )}
      </Section>
    </div>
  );
}

