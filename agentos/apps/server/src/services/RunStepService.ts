import { randomUUID } from 'node:crypto';
import type {
  AgentEventDraft,
  CreateRunStepInput,
  RunStep,
  RunStepStatus,
  ConversationMember,
  UpdateRunStepInput,
} from '@agentos/shared';
import { createAgentEvent } from '../events/createAgentEvent.js';
import { EventBus } from '../events/EventBus.js';
import { SqliteStore } from '../store/SqliteStore.js';

const ALLOWED_TRANSITIONS: Record<RunStepStatus, readonly RunStepStatus[]> = {
  pending: ['running', 'cancelled', 'skipped'],
  running: ['waiting', 'completed', 'failed', 'cancelled'],
  waiting: ['running', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
  skipped: [],
};

const DIRECT_STEPS = [
  { stableStepKey: 'direct.context', sequence: 10, kind: 'context', title: '准备上下文' },
  { stableStepKey: 'direct.agent', sequence: 20, kind: 'agent', title: 'Agent 执行' },
  { stableStepKey: 'direct.artifacts', sequence: 30, kind: 'artifact', title: '收集变更与产物' },
  { stableStepKey: 'direct.summary', sequence: 40, kind: 'summary', title: '交付结果' },
] as const;

export class RunStepService {
  constructor(
    private readonly store: SqliteStore,
    private readonly eventBus?: EventBus,
  ) {}

  async createOrGet(input: CreateRunStepInput): Promise<RunStep> {
    const existing = this.store.getRunStep(input.workspaceId, input.runId, input.stableStepKey);
    if (existing) return existing;
    const draft = this.createDraft('run.step.created', input, { operation: 'create' });
    try {
      const result = this.store.persistRunStepMutation({ eventId: draft.eventId, operation: 'create', input }, draft);
      await this.broadcast(result.event, result.inserted);
      return result.step;
    } catch (error) {
      const raced = this.store.getRunStep(input.workspaceId, input.runId, input.stableStepKey);
      if (raced) return raced;
      throw error;
    }
  }

  async update(input: UpdateRunStepInput): Promise<RunStep> {
    const current = this.store.getRunStep(input.workspaceId, input.runId, input.stableStepKey);
    if (!current) throw new Error(`RunStep not found: ${input.stableStepKey}`);
    if (current.status === input.status && !input.executionId && input.summary === undefined) return current;
    if (!ALLOWED_TRANSITIONS[current.status].includes(input.status)) {
      throw new Error(`Invalid RunStep transition: ${current.status} -> ${input.status}`);
    }
    const draft = this.createDraft('run.step.updated', input, { operation: 'update' });
    const result = this.store.persistRunStepMutation({ eventId: draft.eventId, operation: 'update', input }, draft);
    await this.broadcast(result.event, result.inserted);
    return result.step;
  }

  async initializeDirectRun(input: { workspaceId: string; runId: string; agentId?: string }): Promise<RunStep[]> {
    const steps: RunStep[] = [];
    for (const definition of DIRECT_STEPS) {
      steps.push(await this.createOrGet({
        ...definition,
        workspaceId: input.workspaceId,
        runId: input.runId,
        ...(input.agentId ? { agentId: input.agentId } : {}),
      }));
    }
    return steps;
  }

  async initializeGroupRun(input: { workspaceId: string; runId: string; members: readonly ConversationMember[] }): Promise<RunStep[]> {
    const steps: RunStep[] = [];
    for (const member of [...input.members].sort((left, right) => left.sequence - right.sequence)) {
      steps.push(await this.createOrGet({
        stableStepKey: `group.agent.${member.agentId}`,
        workspaceId: input.workspaceId,
        runId: input.runId,
        agentId: member.agentId,
        kind: member.roleKind === 'reviewer' ? 'review' : 'agent',
        title: member.roleTitle,
        sequence: member.sequence,
      }));
    }
    steps.push(await this.createOrGet({
      stableStepKey: 'group.summary', workspaceId: input.workspaceId, runId: input.runId,
      kind: 'summary', title: '群聊总结', sequence: (Math.max(...input.members.map(member => member.sequence), 0) + 10),
    }));
    return steps;
  }

  async reconcileInterruptedRun(input: { workspaceId: string; runId: string; reason: string }): Promise<void> {
    const steps = this.store.listRunSteps(input.workspaceId, input.runId);
    const pending: Promise<RunStep>[] = [];
    for (const step of steps) {
      if (step.status === 'running') {
        pending.push(this.update({ workspaceId: input.workspaceId, runId: input.runId, stableStepKey: step.stableStepKey, status: 'failed', summary: input.reason }));
      } else if (step.status === 'pending') {
        pending.push(this.update({ workspaceId: input.workspaceId, runId: input.runId, stableStepKey: step.stableStepKey, status: 'skipped', summary: input.reason }));
      }
    }
    await Promise.all(pending);
  }

  private createDraft(
    type: 'run.step.created' | 'run.step.updated',
    input: CreateRunStepInput | UpdateRunStepInput,
    payload: Record<string, unknown>,
  ): AgentEventDraft {
    return createAgentEvent({
      eventId: randomUUID(),
      type,
      workspaceId: input.workspaceId,
      conversationId: this.store.getRun(input.workspaceId, input.runId)?.conversationId ?? '',
      runId: input.runId,
      executionId: 'executionId' in input && input.executionId ? input.executionId : undefined,
      agentId: 'agentId' in input && input.agentId ? input.agentId : undefined,
      payload: { ...payload, stableStepKey: input.stableStepKey },
    });
  }

  private async broadcast(event: Parameters<NonNullable<EventBus['broadcastPersisted']>>[0], inserted: boolean): Promise<void> {
    if (inserted && this.eventBus) await this.eventBus.broadcastPersisted(event);
  }
}

export function canTransitionRunStep(from: RunStepStatus, to: RunStepStatus): boolean {
  return from === to || ALLOWED_TRANSITIONS[from].includes(to);
}
