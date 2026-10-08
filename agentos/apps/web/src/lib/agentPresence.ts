import type { AgentPresence, AgentPresenceState } from '@agentos/shared';

export const PRESENCE_LABELS: Record<AgentPresenceState, string> = {
  disabled: '已禁用',
  idle: '空闲',
  queued: '排队中',
  working: '执行中',
  waiting: '等待补充',
  failed: '失败',
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
