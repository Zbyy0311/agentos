import type { AgentExecution } from '@agentos/shared';
import type { ExecutionStatus } from '@agentos/shared';

const TERMINAL_STATUSES = new Set<ExecutionStatus>(['waiting_user', 'completed', 'failed', 'cancelled']);

export function getElapsedSeconds(
  execution: Pick<AgentExecution, 'startedAt' | 'completedAt'>,
  now = Date.now(),
): number {
  if (!execution.startedAt) return 0;

  const start = new Date(execution.startedAt).getTime();
  const end = execution.completedAt
    ? new Date(execution.completedAt).getTime()
    : now;

  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, Math.round((end - start) / 1000));
}

export function shouldRefreshElapsed(status: ExecutionStatus | undefined, hasStarted: boolean): boolean {
  return hasStarted && !TERMINAL_STATUSES.has(status ?? 'queued');
}
