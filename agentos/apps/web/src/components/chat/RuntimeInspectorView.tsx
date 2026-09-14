'use client';

import type { ReactNode } from 'react';
import { UI_FONT_STACK, UI_SPACING_BASE_PX, UI_RADIUS_TOKENS, uiCssVariables } from '../../lib/uiFoundation';
import type { UiTheme } from '../../lib/uiFoundation';
import { MemoryExplanationView } from '../memory/MemoryExplanationView';
import type { MemoryExplanationSnapshotDto } from '../memory/MemoryExplanationView';

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

/**
 * MF-5: the Inspector Memory section renders the full frozen Context Snapshot
 * summary (13-Runtime-Inspector section 10 + 12-UI-Architecture section 14),
 * not just counters.
 */
export type InspectorMemoryDto = MemoryExplanationSnapshotDto;

/**
 * LITE-13-101: the compaction explanation for the Conversation behind this Run.
 * The view renders the frozen budget inputs (trigger value against threshold),
 * the policy version, the source range, the summary, the attempts/failure state
 * and the Turn/Snapshot that actually received the summary. It never recomputes
 * a threshold: it shows what the durable row recorded.
 */
export interface InspectorCompactionTaskDto {
  readonly id: string;
  readonly status: string;
  readonly sourceMessageCount: number;
  readonly sourceStartMessageId: string | null;
  readonly sourceEndMessageId: string | null;
  readonly summary: string | null;
  readonly summaryTokenEstimate: number | null;
  readonly candidateId: string | null;
  readonly model: string | null;
  readonly adapterId: string | null;
  readonly attempts: number;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
  readonly publishedAt: string | null;
  readonly budget: Record<string, unknown>;
}

export interface InspectorCompactionDto {
  readonly conversationId: string;
  readonly linkVia: 'turn' | 'message' | 'task';
  readonly turnId: string | null;
  readonly contextSnapshotId: string | null;
  readonly policy: {
    readonly policyVersion: string;
    readonly triggerRatio: number;
    readonly targetRatio: number;
    readonly minRecentMessages: number;
    readonly summaryMaxTokens: number;
    readonly maxAutomaticRetries: number;
  } | null;
  readonly latest: InspectorCompactionTaskDto | null;
  readonly tasks: readonly InspectorCompactionTaskDto[];
  readonly tasksTruncated: boolean;
  readonly adoptions: readonly {
    readonly snapshotId: string;
    readonly turnId: string | null;
    readonly summaryId: string;
    readonly summarizedMessages: number | null;
  }[];
  readonly rejections: readonly {
    readonly snapshotId: string;
    readonly turnId: string | null;
    readonly summaryId: string;
    readonly reason: string;
  }[];
  readonly thisTurn: {
    readonly snapshotId: string;
    readonly appliedSummaryId: string | null;
    readonly summarizedMessages: number | null;
    readonly rejectedSummaryId: string | null;
    readonly rejectedReason: string | null;
  } | null;
}

export interface InspectorProjectionDto {
  readonly overview: InspectorRunOverviewDto;
  readonly stages: readonly InspectorStageDto[];
  readonly processes: readonly InspectorProcessDto[];
  readonly events: readonly InspectorEventDto[];
  readonly highWatermark: number;
  readonly memoryContext: InspectorMemoryDto | null;
  readonly compaction?: InspectorCompactionDto | null;
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

/** Read a recorded budget input; a missing or non-numeric member stays absent. */
function budgetNumber(budget: Record<string, unknown>, key: string): number | null {
  const value = budget[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function budgetText(budget: Record<string, unknown>, key: string): string | null {
  const value = budget[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * LITE-13-101: the frozen inputs of the evaluation are shown as recorded, so a
 * reader sees the trigger value against its budget instead of a conclusion.
 * Nothing here recomputes the decision.
 */
function CompactionBudgetFields(props: { readonly task: InspectorCompactionTaskDto }) {
  const { budget } = props.task;
  const historyTokens = budgetNumber(budget, 'historyTokens');
  const historyBudgetTokens = budgetNumber(budget, 'historyBudgetTokens');
  const triggerRatio = budgetNumber(budget, 'triggerRatio');
  const targetRatio = budgetNumber(budget, 'targetRatio');
  const retained = budgetNumber(budget, 'retainedRecentMessages');
  const applicationBudgetSource = budgetText(budget, 'applicationBudgetSource');
  const estimatorVersion = budgetText(budget, 'estimatorVersion');
  return (
    <dl style={{ margin: 0, display: 'grid', rowGap: 2 }}>
      <Field label="trigger" value={
        historyTokens === null || historyBudgetTokens === null
          ? 'not recorded'
          : (historyTokens + ' / ' + historyBudgetTokens + ' tokens')
      } />
      <Field label="ratios" value={
        triggerRatio === null && targetRatio === null
          ? 'not recorded'
          : ('trigger ' + (triggerRatio ?? '—') + ' · target ' + (targetRatio ?? '—'))
      } />
      <Field label="recent retained" value={retained === null ? 'not recorded' : retained} />
      <Field label="budget source" value={applicationBudgetSource ?? 'not recorded'} />
      <Field label="estimator" value={estimatorVersion ?? 'not recorded'} />
    </dl>
  );
}

export function RuntimeInspectorView(props: RuntimeInspectorViewProps) {
  const { theme, projection, error } = props;
  const { overview, stages, processes, events, memoryContext, compaction } = projection;
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
          <MemoryExplanationView snapshot={memoryContext} />
        )}
      </Section>

      <Section title="Compaction">
        {compaction === undefined || compaction === null ? (
          <p data-compaction="not-placed" style={{ margin: 0, color: 'var(--text-tertiary)' }}>
            This Run is not placed in a Conversation, so no compaction explanation exists.
          </p>
        ) : compaction.latest === null ? (
          <p data-compaction="none" style={{ margin: 0, color: 'var(--text-tertiary)' }}>
            No compaction has run for this Conversation.
          </p>
        ) : (
          <div data-agentos="compaction-explanation" data-compaction-status={compaction.latest.status}>
            <dl style={{ margin: 0, display: 'grid', rowGap: 2 }}>
              <Field label="conversation" value={compaction.conversationId + ' (via ' + compaction.linkVia + ')'} />
              <Field label="policy" value={compaction.policy === null ? 'not recorded' : compaction.policy.policyVersion} />
              <Field label="status" value={<span data-status={compaction.latest.status}>{compaction.latest.status}</span>} />
            </dl>
            <CompactionBudgetFields task={compaction.latest} />
            <dl style={{ margin: 0, display: 'grid', rowGap: 2 }}>
              <Field label="source" value={
                compaction.latest.sourceMessageCount + ' messages · '
                + (compaction.latest.sourceStartMessageId ?? '—') + ' .. ' + (compaction.latest.sourceEndMessageId ?? '—')
              } />
              <Field label="summary" value={compaction.latest.summary ?? 'not published'} />
              <Field label="attempts" value={
                compaction.latest.attempts
                + (compaction.latest.failureCode === null ? '' : (' · ' + compaction.latest.failureCode))
              } />
              <Field label="adopted by" value={
                compaction.thisTurn !== null && compaction.thisTurn.appliedSummaryId !== null
                  ? ('this Run · snapshot ' + compaction.thisTurn.snapshotId + ' · ' + compaction.thisTurn.appliedSummaryId)
                  : (compaction.adoptions.length === 0
                    ? 'no Turn received the summary'
                    : ('snapshot ' + compaction.adoptions[compaction.adoptions.length - 1]!.snapshotId
                      + ' · ' + compaction.adoptions[compaction.adoptions.length - 1]!.summaryId))
              } />
              <Field label="refused" value={
                compaction.thisTurn !== null && compaction.thisTurn.rejectedSummaryId !== null
                  ? (compaction.thisTurn.rejectedReason ?? 'unknown')
                  : (compaction.rejections.length === 0
                    ? '—'
                    : compaction.rejections[compaction.rejections.length - 1]!.reason)
              } />
            </dl>
            {compaction.tasks.length > 1 ? (
              <ul data-compaction-tasks={compaction.tasks.length} style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {compaction.tasks.map(task => (
                  <li key={task.id} data-compaction-task={task.id} style={{ fontSize: 12, padding: '2px 0' }}>
                    {task.id} · <span data-status={task.status}>{task.status}</span> · {task.sourceMessageCount} messages
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        )}
      </Section>
    </div>
  );
}
