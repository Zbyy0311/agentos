import type { CollaborationProgress, CollaborationTask } from '@agentos/shared';

export interface CollaborationTaskPageResult {
  readonly tasks: CollaborationTask[];
  readonly selectedTaskId: string | null;
  readonly hasMore: boolean;
}

export function mergeCollaborationTaskPage(
  current: readonly CollaborationTask[],
  nextPage: readonly CollaborationTask[],
  selectedTaskId: string | null,
  pageSize = 100,
): CollaborationTaskPageResult {
  const byId = new Map(current.map(task => [task.id, task]));
  for (const task of nextPage) byId.set(task.id, task);
  return {
    tasks: [...byId.values()],
    selectedTaskId: selectedTaskId ?? nextPage[0]?.id ?? current[0]?.id ?? null,
    hasMore: nextPage.length >= pageSize,
  };
}

export function resolveExplicitTaskProgress(
  progress: CollaborationProgress,
  expectedConversationId: string,
  expectedTaskId?: string,
): CollaborationProgress | undefined {
  return progress.task.conversationId === expectedConversationId
    && (expectedTaskId === undefined || progress.task.id === expectedTaskId) ? progress : undefined;
}
