import type { AgentPresence, AgentPresenceState } from '@agentos/shared';

export const PRESENCE_LABELS: Record<AgentPresenceState, string> = {
  disabled: 'Disabled',
  idle: 'Idle',
  queued: 'Queued',
  working: 'Working',
  waiting: 'Waiting',
  failed: 'Failed',
};

export const PRESENCE_COLORS: Record<AgentPresenceState, string> = {
  disabled: 'bg-[var(--app-dim)]',
  idle: 'bg-[var(--app-success)]',
  queued: 'bg-[var(--app-warning)]',
  working: 'bg-[var(--app-accent)]',
  waiting: 'bg-[var(--app-info)]',
  failed: 'bg-[var(--app-danger)]',
};

export function indexPresence(items: readonly AgentPresence[]): Map<string, AgentPresence> {
  return new Map(items.map(item => [item.agentId, item]));
}

