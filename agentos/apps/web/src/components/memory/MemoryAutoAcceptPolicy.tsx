'use client';

import { useEffect, useRef, useState } from 'react';
import {
  isMemoryAutoAcceptPolicyDto,
  memoryAutoAcceptPolicyPath,
  memoryAutoAcceptPolicyPayload,
  type MemoryAutoAcceptPolicyDto,
} from '@/lib/memoryFeedback';
import { isMemoryVersionConflict, memoryVersionConflictGuidance, workspaceResponseIsCurrent } from '@/lib/memoryManagement';
import { useApi } from '@/lib/useApi';

interface MemoryAutoAcceptPolicyProps {
  readonly workspaceId: string;
}

interface MemoryAutoAcceptPolicyCardProps {
  readonly policy?: MemoryAutoAcceptPolicyDto;
  readonly loading: boolean;
  readonly busy: boolean;
  readonly error: string;
  readonly stale: boolean;
  readonly notice: string;
  onEnabledChange(enabled: boolean): void;
  onReload(): void;
}

type PolicyLoadState =
  | { readonly workspaceId: string; readonly status: 'loading' }
  | { readonly workspaceId: string; readonly status: 'error'; readonly message: string }
  | { readonly workspaceId: string; readonly status: 'success'; readonly policy: MemoryAutoAcceptPolicyDto };

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return [message, memoryVersionConflictGuidance(error)].filter(Boolean).join(' ');
}

export function MemoryAutoAcceptPolicyCard({
  policy, loading, busy, error, stale, notice, onEnabledChange, onReload,
}: MemoryAutoAcceptPolicyCardProps) {
  return <section aria-label="低风险事实自动接受策略" className="mb-4 rounded-xl border ui-border p-4" data-agentos="memory-auto-accept-policy">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <h4 className="font-medium ui-text">低风险事实自动接受</h4>
        <p className="mt-1 text-xs leading-5 ui-dim">仅限当前工作区：服务端验证过的白名单失败码、运行环境信息和测试结果；来源验证通过且没有冲突时才自动接受。其他事实或有冲突的事实仍进入候选审查。</p>
        <p className="mt-1 text-xs leading-5 ui-dim">此设置只影响后续事实，不会改写现有记忆或历史快照。关闭后，新事实进入候选审查。</p>
      </div>
      {policy && <label className="flex shrink-0 items-center gap-2 text-xs ui-text-soft">
        <input
          type="checkbox"
          aria-label="启用低风险事实自动接受"
          checked={policy.enabled}
          disabled={busy || loading}
          onChange={event => onEnabledChange(event.target.checked)}
          className="h-4 w-4 accent-[var(--app-accent)]"
        />
        {busy ? '保存中…' : policy.enabled ? '已启用' : '已关闭'}
      </label>}
    </div>
    {loading && <p role="status" className="mt-3 text-xs ui-dim">正在读取自动接受策略…</p>}
    {!loading && policy && <p className="mt-2 text-[11px] ui-dim">{policy.version === 0 ? '系统默认策略 · v0' : `策略版本 v${policy.version}`}</p>}
    {notice && <p role="status" className="mt-3 text-xs ui-accent">{notice}</p>}
    {error && <div className="mt-3 text-xs text-[var(--app-danger)]"><p role="alert">{error}</p><button type="button" onClick={onReload} className="ui-button-ghost mt-2 rounded-lg border ui-border px-3 py-2">{stale ? '重新加载最新版本' : '重试加载策略'}</button></div>}
  </section>;
}

export function MemoryAutoAcceptPolicy({ workspaceId }: MemoryAutoAcceptPolicyProps) {
  const { request } = useApi();
  const [loadState, setLoadState] = useState<PolicyLoadState>({ workspaceId, status: 'loading' });
  const [reloadToken, setReloadToken] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [notice, setNotice] = useState('');
  const activeWorkspaceId = useRef(workspaceId);
  const requestGeneration = useRef(0);
  activeWorkspaceId.current = workspaceId;

  useEffect(() => {
    const generation = ++requestGeneration.current;
    const isCurrent = () => workspaceResponseIsCurrent(workspaceId, activeWorkspaceId.current, generation, requestGeneration.current);
    setLoadState({ workspaceId, status: 'loading' });
    setBusy(false);
    setError('');
    setStale(false);
    setNotice('');
    void request<{ policy: unknown }>(memoryAutoAcceptPolicyPath(workspaceId))
      .then(result => {
        if (!isCurrent()) return;
        if (!isMemoryAutoAcceptPolicyDto(result.policy)) throw new Error('自动接受策略接口响应无效');
        setLoadState({ workspaceId, status: 'success', policy: result.policy });
      })
      .catch(loadError => {
        if (isCurrent()) setLoadState({ workspaceId, status: 'error', message: errorMessage(loadError) });
      });
    return () => {
      if (requestGeneration.current === generation) requestGeneration.current += 1;
    };
  }, [reloadToken, request, workspaceId]);

  const currentState: PolicyLoadState = loadState.workspaceId === workspaceId
    ? loadState
    : { workspaceId, status: 'loading' };

  const saveEnabled = async (enabled: boolean) => {
    if (busy || currentState.status !== 'success' || currentState.policy.enabled === enabled) return;
    const policy = currentState.policy;
    const generation = requestGeneration.current;
    const isCurrent = () => workspaceResponseIsCurrent(workspaceId, activeWorkspaceId.current, generation, requestGeneration.current);
    setBusy(true);
    setError('');
    setStale(false);
    setNotice('');
    try {
      const result = await request<{ policy: unknown }>(memoryAutoAcceptPolicyPath(workspaceId), {
        method: 'POST',
        body: memoryAutoAcceptPolicyPayload(policy, enabled),
      });
      if (!isCurrent()) return;
      if (!isMemoryAutoAcceptPolicyDto(result.policy)) throw new Error('自动接受策略更新响应无效');
      setLoadState({ workspaceId, status: 'success', policy: result.policy });
      setNotice(enabled ? '低风险事实自动接受已启用。' : '自动接受已关闭；新事实将进入候选审查。');
    } catch (saveError) {
      if (!isCurrent()) return;
      setError(errorMessage(saveError));
      setStale(isMemoryVersionConflict(saveError));
    } finally {
      if (isCurrent()) setBusy(false);
    }
  };

  return <MemoryAutoAcceptPolicyCard
    policy={currentState.status === 'success' ? currentState.policy : undefined}
    loading={currentState.status === 'loading'}
    busy={busy}
    error={error || (currentState.status === 'error' ? currentState.message : '')}
    stale={stale}
    notice={notice}
    onEnabledChange={enabled => { void saveEnabled(enabled); }}
    onReload={() => setReloadToken(value => value + 1)}
  />;
}
