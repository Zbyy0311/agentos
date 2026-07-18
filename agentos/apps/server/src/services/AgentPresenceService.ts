import type { AgentExecution, AgentPresence, AgentPresenceState } from '@agentos/shared';
import { SqliteStore } from '../store/SqliteStore.js';

const FAILED_RETENTION_MS = 30_000;

const STATE_PRIORITY: Record<AgentPresenceState, number> = {
  disabled: 5,
  waiting: 4,
  working: 3,
  queued: 2,
  failed: 1,
  idle: 0,
};

export class AgentPresenceService {
  constructor(private readonly store: SqliteStore) {}

  resolve(workspaceId: string, now = new Date()): AgentPresence[] {
    const agents = this.store.listAgentProfiles(workspaceId);
    const executions = this.store.listExecutionsForWorkspace(workspaceId);
    return agents.map(agent => {
      if (!agent.enabled) return { agentId: agent.id, state: 'disabled', updatedAt: now.toISOString() };
      const candidates = executions
        .filter(execution => execution.agentId === agent.id)
        .map(execution => this.toCandidate(execution, now))
        .filter((candidate): candidate is AgentPresence => candidate !== undefined);
      return candidates.sort((left, right) => STATE_PRIORITY[right.state] - STATE_PRIORITY[left.state] || right.updatedAt.localeCompare(left.updatedAt))[0]
        ?? { agentId: agent.id, state: 'idle', updatedAt: now.toISOString() };
    });
  }

  private toCandidate(execution: AgentExecution, now: Date): AgentPresence | undefined {
    const updatedAt = execution.updatedAt;
    const common = { agentId: execution.agentId, runId: execution.runId, conversationId: execution.conversationId, updatedAt };
    if (execution.status === 'waiting_user') return { ...common, state: 'waiting' };
    if (execution.status === 'queued') return { ...common, state: 'queued' };
    if (execution.status === 'preparing_context' || execution.status === 'running_cli' || execution.status === 'streaming_response') {
      const latestEvent = this.store.listExecutionEvents(execution.workspaceId, execution.id).at(-1);
      return { ...common, state: 'working', ...(latestEvent?.activity ? { activity: latestEvent.activity } : {}) };
    }
    if (execution.status === 'failed') {
      const completedAt = execution.completedAt ? new Date(execution.completedAt).getTime() : new Date(updatedAt).getTime();
      if (now.getTime() - completedAt <= FAILED_RETENTION_MS) {
        const latestEvent = this.store.listExecutionEvents(execution.workspaceId, execution.id).at(-1);
        return { ...common, state: 'failed', ...(latestEvent?.activity ? { activity: latestEvent.activity } : {}) };
      }
    }
    return undefined;
  }
}

