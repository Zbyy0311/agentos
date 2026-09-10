'use client';

import type { ReactNode } from 'react';
import { UI_FONT_STACK, UI_SPACING_BASE_PX, UI_RADIUS_TOKENS, uiCssVariables } from '../../lib/uiFoundation';
import type { UiTheme } from '../../lib/uiFoundation';

/**
 * Controlled Group Conversation UX (Lite 12 §13).
 *
 * A group interaction is visibly bounded: the budget, the per-Agent replies, the hop
 * chain, and the terminal state (stop reason / loop-guard signal) are all explicit.
 * The Stop control blocks new replies; it never cancels a Run. Presentational.
 */

export interface GroupBudgetStatusDto {
  readonly repliesUsed: number;
  readonly repliesRemaining: number;
  readonly hopsUsed: number;
  readonly hopsRemaining: number;
  readonly distinctAgents: number;
  readonly agentsRemaining: number;
}

export interface GroupReplyDto {
  readonly id: string;
  readonly agentId: string;
  readonly messageId: string;
  readonly hopFromAgentId: string | null;
  readonly hopOrder: number;
}

export interface GroupInteractionDto {
  readonly id: string;
  readonly status: 'active' | 'stopped' | 'exhausted' | 'completed';
  readonly stopReason: string | null;
  readonly loopGuardSignal: string | null;
}

export interface BoundedGroupViewProps {
  readonly theme: UiTheme;
  readonly interaction: GroupInteractionDto;
  readonly budget: GroupBudgetStatusDto;
  readonly replies: readonly GroupReplyDto[];
  readonly stopping: boolean;
  readonly error?: string;
  readonly onStop: () => void;
}

function Meter(props: { readonly label: string; readonly used: number; readonly remaining: number }) {
  const total = props.used + props.remaining;
  return (
    <div style={{ marginBottom: UI_SPACING_BASE_PX }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 2 }}>
        <span>{props.label}</span>
        <span>{props.used} / {total}</span>
      </div>
      <div role="progressbar" aria-label={props.label} aria-valuenow={props.used} aria-valuemax={total} style={{
        height: 4, borderRadius: UI_RADIUS_TOKENS.input, backgroundColor: 'var(--surface-raised)', overflow: 'hidden',
      }}>
        <div style={{
          width: total === 0 ? '0%' : `${Math.min(100, (props.used / total) * 100)}%`,
          height: '100%', backgroundColor: 'var(--accent-default)',
        }} />
      </div>
    </div>
  );
}

export function BoundedGroupView(props: BoundedGroupViewProps) {
  const { theme, interaction, budget, replies, stopping, error, onStop } = props;
  const terminal = interaction.status !== 'active';
  return (
    <div
      data-agentos="bounded-group-view"
      style={{
        ...uiCssVariables(theme),
        fontFamily: UI_FONT_STACK.ui,
        backgroundColor: 'var(--surface-base)',
        color: 'var(--text-primary)',
        padding: UI_SPACING_BASE_PX * 3,
      }}
    >
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: UI_SPACING_BASE_PX * 2 }}>
        <span style={{ fontWeight: 600 }}>Group interaction</span>
        <span data-status={interaction.status} style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          {interaction.status}
        </span>
      </header>

      <div style={{ marginBottom: UI_SPACING_BASE_PX * 2 }}>
        <Meter label="replies" used={budget.repliesUsed} remaining={budget.repliesRemaining} />
        <Meter label="hops" used={budget.hopsUsed} remaining={budget.hopsRemaining} />
        <Meter label="agents" used={budget.distinctAgents} remaining={budget.agentsRemaining} />
      </div>

      {interaction.loopGuardSignal === null ? null : (
        <div role="alert" style={{
          color: 'var(--status-warning)', fontSize: 12, marginBottom: UI_SPACING_BASE_PX * 2,
          border: '1px solid var(--border-default)', borderRadius: UI_RADIUS_TOKENS.row,
          padding: UI_SPACING_BASE_PX * 2,
        }}>
          Loop guard: {interaction.loopGuardSignal}
        </div>
      )}
      {interaction.stopReason === null ? null : (
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: UI_SPACING_BASE_PX * 2 }}>
          Ended: {interaction.stopReason}
        </div>
      )}

      <ol style={{ listStyle: 'none', margin: 0, padding: 0, marginBottom: UI_SPACING_BASE_PX * 2 }}>
        {replies.map(reply => (
          <li key={reply.id} data-reply={reply.id} style={{ fontSize: 12, padding: `${UI_SPACING_BASE_PX}px 0`, borderBottom: '1px solid var(--border-subtle)' }}>
            <span style={{ fontFamily: UI_FONT_STACK.code, color: 'var(--text-tertiary)' }}>#{reply.hopOrder}</span>
            {' '}{reply.agentId}
            {reply.hopFromAgentId === null ? '' : ` ← ${reply.hopFromAgentId}`}
          </li>
        ))}
      </ol>

      {error === undefined ? null : (
        <div role="alert" style={{ color: 'var(--status-danger)', fontSize: 12, marginBottom: UI_SPACING_BASE_PX * 2 }}>{error}</div>
      )}

      {terminal ? null : (
        <button
          type="button"
          data-agentos="group-stop"
          disabled={stopping}
          onClick={onStop}
          style={{
            border: '1px solid var(--border-strong)', borderRadius: UI_RADIUS_TOKENS.input,
            backgroundColor: 'var(--surface-raised)', color: 'var(--status-danger)',
            padding: `${UI_SPACING_BASE_PX}px ${UI_SPACING_BASE_PX * 2}px`, cursor: 'pointer', fontSize: 12,
          }}
        >
          Stop interaction
        </button>
      )}
    </div>
  );
}
