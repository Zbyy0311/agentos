'use client';

import { useEffect, useRef, useState } from 'react';
import { useApi } from '@/lib/useApi';
import {
  collaborationRecoveryPath,
  collaborationRecoveryRequest,
  type CollaborationRecoveryAction,
  type CollaborationRecoveryAvailability,
} from '@/lib/collaborationRecovery';

interface RecoveryResult {
  readonly action: CollaborationRecoveryAction;
  readonly task: { readonly id: string; readonly title: string; readonly status: string };
  readonly priorRunId: string;
  readonly newRunId?: string;
  readonly checkedBaseCommit: string;
  readonly replayed: boolean;
  readonly pending?: boolean;
}

export function CollaborationRecoveryPanel(props: {
  readonly workspaceId: string;
  readonly taskId: string;
  readonly refreshRevision?: number;
  readonly onRecovered?: (result: RecoveryResult) => void;
}) {
  const { request } = useApi();
  const [availability, setAvailability] = useState<CollaborationRecoveryAvailability | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const busyRef = useRef(false);
  const [refreshRevision, setRefreshRevision] = useState(0);

  useEffect(() => {
    let active = true;
    setAvailability(null);
    setError('');
    void request<{ recovery: CollaborationRecoveryAvailability }>(collaborationRecoveryPath(props.workspaceId, props.taskId))
      .then(result => { if (active) setAvailability(result.recovery); })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : '无法读取恢复状态'); });
    return () => { active = false; };
  }, [props.workspaceId, props.taskId, props.refreshRevision, request, refreshRevision]);

  const recover = async (action: CollaborationRecoveryAction) => {
    if (!availability || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await request<{ recovery: RecoveryResult }>(
        `/api/workspaces/${encodeURIComponent(props.workspaceId)}/collaboration/tasks/${encodeURIComponent(props.taskId)}/recover`,
        collaborationRecoveryRequest(props.workspaceId, availability, action),
      );
      props.onRecovered?.(result.recovery);
      setNotice(result.recovery.pending
        ? '恢复请求仍在核验中；旧 Provider 调用不会重放。'
        : result.recovery.action === 'new-linked-task'
          ? `已建立关联任务“${result.recovery.task.title}”，请检查后再确认启动。`
          : `已为失败 Run ${result.recovery.priorRunId} 建立新的 canonical Run。`);
      setRefreshRevision(value => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '恢复操作失败');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  if (!availability) return <section className="mt-5 rounded-xl border ui-border p-4 text-xs ui-muted" aria-label="协作任务恢复" aria-live="polite">
    {error ? <div role="alert" className="text-[var(--app-danger)]">{error}</div> : '正在核验恢复条件…'}
  </section>;
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
      {actions.retryKnownFailure && <button type="button" disabled={busy} className="ui-button-primary rounded-lg px-3 py-2 text-xs disabled:opacity-50" onClick={() => { void recover('retry-known-failure'); }}>{busy ? '创建新 Run…' : '重试已知启动前失败'}</button>}
    </div>
  </section>;
}
