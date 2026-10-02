export type CollaborationRecoveryAction = 'retry-known-failure' | 'new-linked-task';

export interface CollaborationRecoveryAvailability {
  readonly taskId: string;
  readonly taskVersion: number;
  readonly runId?: string;
  readonly runVersion?: number;
  readonly failureCode?: string;
  readonly recoveryRequired?: boolean;
  readonly checkedBaseCommit?: string;
  readonly actions: { readonly retryKnownFailure: boolean; readonly newLinkedTask: boolean };
  readonly reason?: string;
}

function stableIntentHash(value: string): string {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function collaborationRecoveryPath(workspaceId: string, taskId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/collaboration/tasks/${encodeURIComponent(taskId)}/recovery`;
}

export function collaborationRecoveryRequest(
  workspaceId: string,
  availability: CollaborationRecoveryAvailability,
  action: CollaborationRecoveryAction,
): { readonly method: 'POST'; readonly body: { readonly action: CollaborationRecoveryAction; readonly expectedTaskVersion: number; readonly expectedRunId: string; readonly expectedRunVersion: number }; readonly headers: { readonly 'Idempotency-Key': string } } {
  if (!availability.runId || availability.runVersion === undefined) throw new Error('The current failed Run is unavailable');
  const intent = [workspaceId, availability.taskId, availability.taskVersion, availability.runId, availability.runVersion, action].join(':');
  return {
    method: 'POST',
    body: {
      action,
      expectedTaskVersion: availability.taskVersion,
      expectedRunId: availability.runId,
      expectedRunVersion: availability.runVersion,
    },
    headers: { 'Idempotency-Key': `p2-recovery-${action}-${stableIntentHash(intent)}` },
  };
}
