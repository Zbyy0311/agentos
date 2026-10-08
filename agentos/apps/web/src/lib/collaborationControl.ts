export interface PendingCollaborationControl {
  readonly id: string;
  readonly action: 'confirm' | 'cancel' | 'apply' | 'rework';
  readonly state: 'reserved' | 'running' | 'recovery_required';
  readonly epoch: number;
  readonly reason?: string;
  readonly recoveryReference?: string;
}

export function readPendingCollaborationControl(task: unknown): PendingCollaborationControl | undefined {
  if (!task || typeof task !== 'object') return undefined;
  const control = (task as { pendingControl?: unknown }).pendingControl;
  if (!control || typeof control !== 'object') return undefined;
  const value = control as Record<string, unknown>;
  if (typeof value.id !== 'string' || !['confirm', 'cancel', 'apply', 'rework'].includes(String(value.action))
    || !['reserved', 'running', 'recovery_required'].includes(String(value.state))
    || typeof value.epoch !== 'number' || !Number.isSafeInteger(value.epoch)) return undefined;
  return {
    id: value.id,
    action: value.action as PendingCollaborationControl['action'],
    state: value.state as PendingCollaborationControl['state'],
    epoch: value.epoch,
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
    ...(typeof value.recoveryReference === 'string' ? { recoveryReference: value.recoveryReference } : {}),
  };
}

export function collaborationControlBlockReason(control?: PendingCollaborationControl): string | undefined {
  if (!control) return undefined;
  const action = control.action === 'confirm' ? '启动' : control.action === 'cancel' ? '取消' : control.action === 'apply' ? '应用' : '返工';
  const reason = control.reason?.trim() || (control.state === 'recovery_required' ? '服务正在恢复该操作状态' : '该操作尚未完成');
  const recovery = control.recoveryReference ? `（恢复引用：${control.recoveryReference}）` : '';
  return `当前已有${action}控制操作待处理：${reason}${recovery}。请等待状态同步后再操作。`;
}

export function collaborationMutationRequest(
  taskId: string,
  expectedVersion: number,
  action: 'confirm' | 'cancel' | 'apply',
  candidate?: { readonly id: string; readonly baseCommit: string; readonly contentHash: string },
): { readonly method: 'POST'; readonly body: { readonly expectedVersion: number; readonly candidateId?: string; readonly candidateBaseCommit?: string; readonly candidateContentHash?: string }; readonly headers: { readonly 'Idempotency-Key': string } } {
  return {
    method: 'POST',
    body: { expectedVersion, ...(candidate === undefined ? {} : {
      candidateId: candidate.id, candidateBaseCommit: candidate.baseCommit, candidateContentHash: candidate.contentHash,
    }) },
    headers: { 'Idempotency-Key': `workspace-ui-${action}-${taskId}-${expectedVersion}` },
  };
}
