import type { AgentRunDetails } from '@agentos/shared';

export type ArchiveItemKind = 'step' | 'status' | 'tool' | 'output' | 'artifact' | 'terminal';

export interface ExecutionArchiveItem {
  id: string;
  sequence: number;
  kind: ArchiveItemKind;
  title: string;
  detail?: string;
  agentId?: string;
  failed: boolean;
  fileChange?: boolean;
}

export interface ArchiveFilter {
  kinds: ArchiveItemKind[];
  agentId?: string;
  failuresOnly: boolean;
  fileChangesOnly: boolean;
  query?: string;
}

export function buildExecutionArchive(details: AgentRunDetails): ExecutionArchiveItem[] {
  const items: ExecutionArchiveItem[] = [];
  for (const event of details.events) {
    const payload = event.payload as Record<string, unknown>;
    const type = event.type;
    const step = payload.step as Record<string, unknown> | undefined;
    const toolName = typeof payload.toolName === 'string' ? payload.toolName : undefined;
    const detail = typeof payload.summary === 'string' ? payload.summary : typeof payload.text === 'string' ? payload.text : typeof payload.content === 'string' ? payload.content : undefined;
    const kind: ArchiveItemKind = type.startsWith('run.step.') ? 'step' : type.includes('.tool.') || toolName ? 'tool' : type === 'conversation.message.created' ? 'output' : type === 'run.completed' || type === 'run.failed' || type === 'run.cancelled' ? 'terminal' : 'status';
    const title = typeof step?.title === 'string' ? step.title : toolName ?? (typeof payload.activity === 'string' ? payload.activity : type);
    const failed = type.includes('failed') || step?.status === 'failed' || payload.status === 'failed';
    items.push({ id: event.eventId, sequence: event.sequence, kind, title, ...(detail ? { detail } : {}), ...(event.agentId ? { agentId: event.agentId } : {}), failed });
  }
  const maxSequence = items.reduce((max, item) => Math.max(max, item.sequence), 0);
  details.artifacts.forEach((artifact, index) => items.push({ id: `artifact:${artifact.id}`, sequence: maxSequence + index + 1, kind: 'artifact', title: artifact.title, detail: artifact.summary, agentId: artifact.agentId, failed: false }));
  details.fileChanges.forEach((change, index) => items.push({ id: `file:${change.path}:${change.changeType}`, sequence: maxSequence + details.artifacts.length + index + 1, kind: 'output', title: `${change.changeType}: ${change.path}`, detail: change.path, failed: false, fileChange: true }));
  const terminalSequence = Math.max(...items.map(item => item.sequence), maxSequence) + 1;
  if (details.run.status !== 'running' && details.run.status !== 'queued') {
    items.push({ id: `terminal:${details.run.id}`, sequence: terminalSequence, kind: 'terminal', title: details.run.status, detail: details.run.failureReason ?? details.run.resultSummary, failed: details.run.status === 'failed' });
  }
  return items.sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
}

export function filterExecutionArchive(items: readonly ExecutionArchiveItem[], filter: ArchiveFilter): ExecutionArchiveItem[] {
  const query = filter.query?.trim().toLocaleLowerCase();
  return items.filter(item => {
    if (filter.kinds.length && !filter.kinds.includes(item.kind)) return false;
    if (filter.agentId && item.agentId !== filter.agentId) return false;
    if (filter.failuresOnly && !item.failed) return false;
    if (filter.fileChangesOnly && !item.fileChange) return false;
    if (query && !`${item.title} ${item.detail ?? ''}`.toLocaleLowerCase().includes(query)) return false;
    return true;
  });
}
