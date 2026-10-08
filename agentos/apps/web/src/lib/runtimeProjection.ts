import type { AgentEvent, AgentExecution, AgentRunDetails, ConversationMessage, RunFileChange, RunStep, RuntimeArtifact } from '@agentos/shared';

export interface RuntimeProjectionScope {
  workspaceId: string;
  conversationId: string;
  runId?: string;
}

export interface RuntimeResultProjection {
  run: AgentRunDetails['run'];
  sourceMessage?: ConversationMessage;
  executions: AgentExecution[];
  events: AgentEvent[];
  steps: RunStep[];
  fileChanges: RunFileChange[];
  artifacts: RuntimeArtifact[];
}

/**
 * Projects one server-owned Run into UI data without guessing associations.
 * Every child record is checked against the Run's workspace/conversation/run
 * identity before it can reach a result card.
 */
export function projectRuntimeResult(details: AgentRunDetails, scope: RuntimeProjectionScope): RuntimeResultProjection | undefined {
  const run = details.run;
  if (run.workspaceId !== scope.workspaceId || run.conversationId !== scope.conversationId || (scope.runId && run.id !== scope.runId)) return undefined;

  const executions = details.executions.filter(execution => execution.workspaceId === run.workspaceId && execution.conversationId === run.conversationId && execution.runId === run.id);
  const events = dedupeEvents(details.events.filter(event => event.workspaceId === run.workspaceId && event.conversationId === run.conversationId && event.runId === run.id));
  const steps = dedupeSteps(details.steps.filter(step => step.workspaceId === run.workspaceId && step.runId === run.id));
  const artifacts = dedupeArtifacts(details.artifacts.filter(artifact => artifact.workspaceId === run.workspaceId && artifact.runId === run.id));
  const fileChanges = dedupeFileChanges(details.fileChanges.filter(change => change.runId === run.id));
  const sourceMessage = details.sourceMessage.workspaceId === run.workspaceId
    && details.sourceMessage.conversationId === run.conversationId
    && details.sourceMessage.id === run.sourceMessageId
    ? details.sourceMessage
    : undefined;

  // Keep artifacts whose execution is missing as Run-level evidence. Dropping
  // them would hide a real result; assigning them to a guessed Agent would be
  // worse. The UI exposes sourceExecutionId for that distinction.
  return { run, ...(sourceMessage ? { sourceMessage } : {}), executions, events, steps, fileChanges, artifacts };
}

/** Add an SSE event once, keeping the newest persisted sequence for its ID. */
export function mergeRuntimeEvent(events: readonly AgentEvent[], incoming: AgentEvent, runId: string): AgentEvent[] {
  if (incoming.runId !== runId) return [...events];
  const next = [...events];
  const index = next.findIndex(event => event.eventId === incoming.eventId);
  if (index >= 0) {
    if (incoming.sequence <= next[index]!.sequence) return [...events];
    next[index] = incoming;
  } else {
    next.push(incoming);
  }
  return dedupeEvents(next);
}

export function messageBelongsToRun(message: ConversationMessage, projection: RuntimeResultProjection): boolean {
  return message.workspaceId === projection.run.workspaceId
    && message.conversationId === projection.run.conversationId
    && message.runId === projection.run.id;
}

function dedupeEvents(events: readonly AgentEvent[]): AgentEvent[] {
  const byId = new Map<string, AgentEvent>();
  for (const event of events) {
    const prior = byId.get(event.eventId);
    if (!prior || event.sequence > prior.sequence) byId.set(event.eventId, event);
  }
  return [...byId.values()].sort((left, right) => left.sequence - right.sequence || left.eventId.localeCompare(right.eventId));
}

function dedupeSteps(steps: readonly RunStep[]): RunStep[] {
  const byStableKey = new Map<string, RunStep>();
  for (const step of steps) {
    const key = step.stableStepKey || step.id;
    const prior = byStableKey.get(key);
    if (!prior || step.updatedEventSequence > prior.updatedEventSequence || (step.updatedEventSequence === prior.updatedEventSequence && step.attempt > prior.attempt)) byStableKey.set(key, step);
  }
  return [...byStableKey.values()].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
}

function dedupeFileChanges(changes: readonly RunFileChange[]): RunFileChange[] {
  const seen = new Set<string>();
  return changes.filter(change => {
    const key = `${change.path}:${change.changeType}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeArtifacts(artifacts: readonly RuntimeArtifact[]): RuntimeArtifact[] {
  const byId = new Map<string, RuntimeArtifact>();
  for (const artifact of artifacts) {
    if (!byId.has(artifact.id)) byId.set(artifact.id, artifact);
  }
  return [...byId.values()].sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime() || left.id.localeCompare(right.id));
}
