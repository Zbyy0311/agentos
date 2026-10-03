'use client';

import { useEffect, useRef, useState } from 'react';
import { useApi } from '@/lib/useApi';
import {
  commitIfRecoveryTargetCurrent,
  collaborationRecoveryPath,
  collaborationRecoveryRequest,
  invalidateRecoveryTargetOnDispose,
  isRecoveryTargetCurrent,
  type CollaborationRecoveryAction,
  type CollaborationRecoveryAvailability,
  type CollaborationRecoveryTarget,
} from '@/lib/collaborationRecovery';
import type { CollaborationProgress } from '@agentos/shared';

interface RecoveryResult {
  readonly action: CollaborationRecoveryAction;
  readonly task: { readonly id: string; readonly title: string; readonly status: string };
  readonly priorRunId: string;
  readonly newRunId?: string;
  readonly checkedBaseCommit: string;
  readonly replayed: boolean;
  readonly pending?: boolean;
}

interface OwnedValue<T> {
  readonly target: CollaborationRecoveryTarget;
  readonly value: T;
}

export function shouldRenderCollaborationRecoveryPanel(
  availability: CollaborationRecoveryAvailability | null,
  showUnavailable: boolean,
): boolean {
  return showUnavailable || Boolean(availability?.actions.retryKnownFailure || availability?.actions.newLinkedTask);
}

export function CollaborationRecoveryPanel(props: {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly refreshRevision?: number;
  /** Queued tasks stay quiet unless the server confirms a recovery action. */
  readonly taskStatus?: CollaborationProgress['task']['status'];
  readonly onRecovered?: (result: RecoveryResult) => void;
}) {
  const { request } = useApi();
  const [availabilityState, setAvailabilityState] = useState<OwnedValue<CollaborationRecoveryAvailability> | null>(null);
  const [availabilityErrorState, setAvailabilityErrorState] = useState<OwnedValue<string> | null>(null);
  const [actionErrorState, setActionErrorState] = useState<OwnedValue<string> | null>(null);
  const [noticeState, setNoticeState] = useState<OwnedValue<string> | null>(null);
  const [busyState, setBusyState] = useState<OwnedValue<boolean> | null>(null);
  const busyRef = useRef<CollaborationRecoveryTarget | null>(null);
  const recoveryTargetRef = useRef<CollaborationRecoveryTarget>({
    workspaceId: props.workspaceId, taskId: props.taskId, generation: 0,
  });
  if (recoveryTargetRef.current.workspaceId !== props.workspaceId || recoveryTargetRef.current.taskId !== props.taskId) {
    recoveryTargetRef.current = {
      workspaceId: props.workspaceId,
      taskId: props.taskId,
      generation: recoveryTargetRef.current.generation + 1,
    };
  }
  const [refreshRevision, setRefreshRevision] = useState(0);

  const currentTarget = recoveryTargetRef.current;
  const ownedValue = <T,>(state: OwnedValue<T> | null): T | null => (
    state && isRecoveryTargetCurrent(state.target, currentTarget) ? state.value : null
  );
  const availability = ownedValue(availabilityState);
  const availabilityError = ownedValue(availabilityErrorState) ?? '';
  const actionError = ownedValue(actionErrorState) ?? '';
  const error = actionError || availabilityError;
  const notice = ownedValue(noticeState) ?? '';
  const busy = ownedValue(busyState) ?? false;

  useEffect(() => {
    const target = recoveryTargetRef.current;
    busyRef.current = null;
    setAvailabilityState(null);
    setAvailabilityErrorState(null);
    setActionErrorState(null);
    setNoticeState(null);
    setBusyState(null);
    return () => {
      // Prop changes advance the generation during render, so this only advances
      // the still-current identity when this effect is actually being disposed.
      const invalidated = invalidateRecoveryTargetOnDispose(target, recoveryTargetRef.current);
      if (invalidated) recoveryTargetRef.current = invalidated;
    };
  }, [props.workspaceId, props.taskId]);

  useEffect(() => {
    let active = true;
    const target = recoveryTargetRef.current;
    setAvailabilityState(null);
    setAvailabilityErrorState(null);
    void request<{ recovery: CollaborationRecoveryAvailability }>(collaborationRecoveryPath(props.workspaceId, props.taskId))
      .then(result => {
        if (active) commitIfRecoveryTargetCurrent(target, recoveryTargetRef.current, () => {
          setAvailabilityState({ target, value: result.recovery });
        });
      })
      .catch(cause => {
        if (active) commitIfRecoveryTargetCurrent(target, recoveryTargetRef.current, () => {
          setAvailabilityErrorState({ target, value: cause instanceof Error ? cause.message : '无法读取恢复状态' });
        });
      });
    return () => { active = false; };
  }, [props.workspaceId, props.taskId, props.refreshRevision, request, refreshRevision]);

  const recover = async (action: CollaborationRecoveryAction) => {
    const target = recoveryTargetRef.current;
    if (!availability || (busyRef.current && isRecoveryTargetCurrent(busyRef.current, target))) return;
    busyRef.current = target;
    setBusyState({ target, value: true });
    setActionErrorState({ target, value: '' });
    setNoticeState({ target, value: '' });
    try {
      const result = await request<{ recovery: RecoveryResult }>(
        `/api/workspaces/${encodeURIComponent(props.workspaceId)}/collaboration/tasks/${encodeURIComponent(props.taskId)}/recover`,
        collaborationRecoveryRequest(props.workspaceId, availability, action),
      );
      commitIfRecoveryTargetCurrent(target, recoveryTargetRef.current, () => {
        props.onRecovered?.(result.recovery);
        setNoticeState({ target, value: result.recovery.pending
          ? '恢复请求仍在核验中；旧 Provider 调用不会重放。'
          : result.recovery.action === 'new-linked-task'
            ? `已建立关联任务“${result.recovery.task.title}”，请检查后再确认启动。`
            : availability.resumeRequest
              ? `已安全续办原 Run ${result.recovery.newRunId ?? ''}；不会重复创建 Run 或重放 Provider 调用。`
              : `已为失败 Run ${result.recovery.priorRunId} 建立新的 canonical Run。` });
        setRefreshRevision(value => value + 1);
      });
    } catch (cause) {
      commitIfRecoveryTargetCurrent(target, recoveryTargetRef.current, () => {
        setActionErrorState({ target, value: cause instanceof Error ? cause.message : '恢复操作失败' });
      });
    } finally {
      commitIfRecoveryTargetCurrent(target, recoveryTargetRef.current, () => {
        if (busyRef.current && isRecoveryTargetCurrent(busyRef.current, target)) {
          busyRef.current = null;
          setBusyState({ target, value: false });
        }
      });
    }
  };

  const showUnavailable = props.taskStatus === undefined
    || props.taskStatus === 'failed' || props.taskStatus === 'blocked';
  if (!availability) {
    if (!showUnavailable) return null;
    return <section className="mt-5 rounded-xl border ui-border p-4 text-xs ui-muted" aria-label="协作任务恢复" aria-live="polite">
      {error ? <div role="alert" className="text-[var(--app-danger)]">{error}</div> : '正在核验恢复条件…'}
      {notice && <div role="status" className="mt-3 text-xs ui-text-soft">{notice}</div>}
    </section>;
  }
  if (!shouldRenderCollaborationRecoveryPanel(availability, showUnavailable)) return null;
  const { actions } = availability;

  return <section className="mt-5 rounded-xl border border-[var(--app-warning)]/40 bg-[var(--app-surface-soft)] p-4" aria-label="协作任务恢复">
    <h2 className="text-sm font-medium ui-text">恢复失败协作任务</h2>
    <p className="mt-2 text-xs leading-5 ui-text-soft">每次恢复都使用当前 task/Run 版本进行并发核对。已知的启动前失败可新建 canonical Run；副作用不明时只允许在干净基线上创建关联任务，旧 Provider 调用不会重放。</p>
    {availability.failureCode && <p className="mt-2 text-[11px] ui-muted">失败代码：<code>{availability.failureCode}</code>{availability.recoveryRequired ? ' · 副作用状态待核实' : ''}</p>}
    {(availability.reason || (!actions.retryKnownFailure && !actions.newLinkedTask)) && <p className="mt-2 text-xs ui-muted">{availability.reason ?? '当前失败状态不满足安全恢复条件。'}</p>}
    {availability.checkedBaseCommit && <p className="mt-2 text-[11px] ui-muted">已检查基线：<code>{availability.checkedBaseCommit.slice(0, 12)}</code></p>}
    {error && <div role="alert" className="mt-3 text-xs text-[var(--app-danger)]">{error}</div>}
    {notice && <div role="status" className="mt-3 text-xs ui-text-soft">{notice}</div>}
    <div className="mt-4 flex flex-wrap justify-end gap-2">
      {actions.newLinkedTask && <button type="button" disabled={busy} className="ui-button-secondary rounded-lg px-3 py-2 text-xs disabled:opacity-50" onClick={() => { void recover('new-linked-task'); }}>{busy ? '核验中…' : '在干净基线上创建关联任务'}</button>}
      {actions.retryKnownFailure && <button type="button" disabled={busy} className="ui-button-primary rounded-lg px-3 py-2 text-xs disabled:opacity-50" onClick={() => { void recover('retry-known-failure'); }}>{busy ? (availability.resumeRequest ? '安全续办中…' : '创建新 Run…') : (availability.resumeRequest ? '安全续办原重试' : '重试已知启动前失败')}</button>}
    </div>
  </section>;
}
