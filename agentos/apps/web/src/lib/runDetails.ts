import type { AgentRunDetails } from '@agentos/shared';

export function normalizeRunDetails(details: AgentRunDetails): AgentRunDetails {
  const fileChanges = [...new Map(details.fileChanges.map(change => [`${change.path}:${change.changeType}`, change])).values()]
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    ...details,
    events: [...details.events].sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime()),
    fileChanges,
  };
}

export function getRunFailureReason(details: AgentRunDetails): string | undefined {
  return details.run.status === 'failed' ? details.run.failureReason ?? '执行失败，未提供更多原因' : undefined;
}

export function getRunDurationMs(details: AgentRunDetails): number | undefined {
  if (!details.run.startedAt) return undefined;
  const end = details.run.completedAt ? new Date(details.run.completedAt).getTime() : Date.now();
  return Math.max(0, end - new Date(details.run.startedAt).getTime());
}
