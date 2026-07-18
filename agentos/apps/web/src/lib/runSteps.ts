import type { AgentEvent, RunStep } from '@agentos/shared';

export interface RunTaskTreeItem {
  id: string;
  stableStepKey: string;
  title: string;
  status: RunStep['status'];
  sequence: number;
  attempt: number;
  agentId?: string;
  durationMs?: number;
}

export interface RunStepProjection {
  steps: RunStep[];
  seenEventIds: Set<string>;
}

export function upsertRunStep(steps: readonly RunStep[], incoming: RunStep): RunStep[] {
  const index = steps.findIndex(step => step.id === incoming.id || step.stableStepKey === incoming.stableStepKey);
  if (index < 0) return [...steps, incoming].sort(compareSteps);
  const current = steps[index];
  if (incoming.updatedEventSequence < current.updatedEventSequence) return [...steps];
  const next = [...steps];
  next[index] = incoming;
  return next.sort(compareSteps);
}

export function applyRunStepEvent(projection: RunStepProjection, event: AgentEvent): RunStepProjection {
  if (projection.seenEventIds.has(event.eventId)) return projection;
  const step = extractRunStep(event);
  const seenEventIds = new Set(projection.seenEventIds).add(event.eventId);
  return step ? { steps: upsertRunStep(projection.steps, step), seenEventIds } : { ...projection, seenEventIds };
}

export function toRunTaskTree(steps: readonly RunStep[]): RunTaskTreeItem[] {
  return [...steps].sort(compareSteps).map(step => ({
    id: step.id,
    stableStepKey: step.stableStepKey,
    title: step.title,
    status: step.status,
    sequence: step.sequence,
    attempt: step.attempt,
    ...(step.agentId ? { agentId: step.agentId } : {}),
    ...(step.startedAt && step.completedAt ? { durationMs: Math.max(0, new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime()) } : {}),
  }));
}

function extractRunStep(event: AgentEvent): RunStep | undefined {
  if (event.type !== 'run.step.created' && event.type !== 'run.step.updated') return undefined;
  const payload = event.payload as Record<string, unknown>;
  const step = payload.step;
  return step && typeof step === 'object' ? step as RunStep : undefined;
}

function compareSteps(left: RunStep, right: RunStep): number {
  return left.sequence - right.sequence || left.id.localeCompare(right.id);
}
