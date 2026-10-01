'use client';

import { useEffect, useRef, useState } from 'react';
import type { MemoryEntryDto } from '@/lib/memoryEntries';
import {
  joinMemoryFeedbackActions,
  memoryFeedbackActionResolvePath,
  memoryFeedbackActionResolutionPayload,
  memoryFeedbackActionsPath,
  memoryFeedbackPath,
  memoryFeedbackResponseIsCurrent,
  type MemoryFeedbackActionDto,
  type MemoryFeedbackActionResolution,
  type MemoryFeedbackActionView,
  type MemoryVersionFeedbackDto,
} from '@/lib/memoryFeedback';
import { memoryEntryPath } from '@/lib/memoryEntries';
import { isMemoryVersionConflict, memoryVersionConflictGuidance } from '@/lib/memoryManagement';
import { useApi } from '@/lib/useApi';
import { MemoryAutoAcceptPolicy } from './MemoryAutoAcceptPolicy';

interface MemoryFeedbackActionsProps {
  readonly workspaceId: string;
  readonly onOpenContext?: (contextKind: MemoryVersionFeedbackDto['contextKind'], contextId: string) => void;
}

interface FeedbackActionRowProps {
  readonly view: MemoryFeedbackActionView;
  readonly entry?: MemoryEntryDto;
  readonly entryError?: string;
  readonly busy: boolean;
  readonly onResolve: (action: MemoryFeedbackActionDto, status: MemoryFeedbackActionResolution) => void;
  readonly onOpenContext?: MemoryFeedbackActionsProps['onOpenContext'];
}

interface LoadedRow extends MemoryFeedbackActionView {
  readonly entry?: MemoryEntryDto;
  readonly entryError?: string;
}

type LoadState =
  | { readonly workspaceId: string; readonly status: 'loading' }
  | { readonly workspaceId: string; readonly status: 'error'; readonly message: string }
  | { readonly workspaceId: string; readonly status: 'success'; readonly rows: readonly LoadedRow[] };

const ACTION_LABELS: Record<MemoryFeedbackActionDto['action'], string> = {
  correction: '修正',
  revalidation: '重新验证',
};
const STATUS_LABELS: Record<MemoryFeedbackActionDto['status'], string> = {
  pending: '待处理',
  resolved: '已解决',
  rejected: '已拒绝',
};
const FEEDBACK_LABELS: Record<MemoryVersionFeedbackDto['kind'], string> = {
  helpful: '有帮助',
  wrong: '有错误',
  outdated: '已过时',
};
const CONTEXT_LABELS: Record<MemoryVersionFeedbackDto['contextKind'], string> = {
  run: 'Run',
  stage: 'Stage',
  turn: 'Turn',
  'legacy-execution': '旧版 Execution',
};

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return [message, memoryVersionConflictGuidance(error)].filter(Boolean).join(' ');
}

export function MemoryFeedbackActionRow({ view, entry, entryError, busy, onResolve, onOpenContext }: FeedbackActionRowProps) {
  const { action, feedback } = view;
  return (
    <article className="ui-panel rounded-xl border ui-border p-4" data-feedback-action-id={action.id} data-status={action.status}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h4 className="font-medium ui-text">{ACTION_LABELS[action.action]} · {FEEDBACK_LABELS[feedback?.kind ?? (action.action === 'correction' ? 'wrong' : 'outdated')]}</h4>
          <p className="mt-1 break-all text-xs ui-dim">记忆 {action.memoryId} · 冻结版本 v{action.memoryVersion}</p>
        </div>
        <span className="rounded-full border ui-border px-2 py-1 text-[11px] ui-accent">{STATUS_LABELS[action.status]}</span>
      </div>

      <section className="mt-3 rounded-lg border ui-border p-3" aria-label="关联正式记忆">
        <div className="text-[11px] tracking-wide ui-dim">关联正式记忆</div>
        {entry ? <>
          <p className="mt-1 break-words text-sm font-medium ui-text">{entry.title} · 当前 v{entry.version} · {entry.status}</p>
          {entry.summary && <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 ui-text-soft">{entry.summary}</p>}
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] ui-dim">
            <span>类别：{entry.category}</span>
            <span>来源：{entry.sources.length ? entry.sources.map(source => `${source.kind}:${source.id}`).join('、') : '未记录'}</span>
          </div>
        </> : entryError ? <p role="status" className="mt-1 break-words text-xs ui-dim">无法加载正式记忆详情：{entryError}</p> : <p role="status" className="mt-1 text-xs ui-dim">未找到关联正式记忆。</p>}
      </section>

      <section className="mt-3 rounded-lg border ui-border p-3" aria-label="关联冻结上下文">
        <div className="text-[11px] tracking-wide ui-dim">关联冻结上下文</div>
        {feedback ? <>
          <p className="mt-1 break-all text-xs ui-text-soft">{CONTEXT_LABELS[feedback.contextKind]} · {feedback.contextId}</p>
          <p className="mt-1 break-words text-xs leading-5 ui-text-soft">{feedback.comment || '未填写补充说明'}</p>
          <p className="mt-1 break-all text-[11px] ui-dim">冻结版本 v{feedback.memoryVersion} · 提交时正式记忆 v{feedback.currentEntryVersion} · 上下文校验 {feedback.contextHash}</p>
          {onOpenContext && <button type="button" onClick={() => onOpenContext(feedback.contextKind, feedback.contextId)} className="ui-button-ghost mt-2 rounded-lg border ui-border px-3 py-2 text-xs">查看关联上下文</button>}
        </> : <p className="mt-1 text-xs ui-dim">未返回关联反馈详情。</p>}
      </section>

      {action.status === 'pending' && <div className="mt-3 flex justify-end gap-2">
        <button type="button" disabled={busy} onClick={() => onResolve(action, 'rejected')} className="ui-button-ghost rounded-lg border ui-border px-3 py-2 text-xs disabled:opacity-50">拒绝</button>
        <button type="button" disabled={busy} onClick={() => onResolve(action, 'resolved')} className="ui-button-primary rounded-lg px-3 py-2 text-xs disabled:opacity-50">{busy ? '处理中…' : '标记已解决'}</button>
      </div>}
    </article>
  );
}

export function MemoryFeedbackActions({ workspaceId, onOpenContext }: MemoryFeedbackActionsProps) {
  const { request } = useApi();
  const [loadState, setLoadState] = useState<LoadState>({ workspaceId, status: 'loading' });
  const [reloadToken, setReloadToken] = useState(0);
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [notice, setNotice] = useState('');
  const activeWorkspaceId = useRef(workspaceId);
  const requestGeneration = useRef(0);
  activeWorkspaceId.current = workspaceId;

  useEffect(() => {
    const generation = ++requestGeneration.current;
    const isCurrent = () => memoryFeedbackResponseIsCurrent(
      workspaceId,
      activeWorkspaceId.current,
      generation,
      requestGeneration.current,
    );
    setLoadState({ workspaceId, status: 'loading' });
    setError('');
    setStale(false);
    setNotice('');
    setBusyId(undefined);

    void Promise.all([
      request<{ actions: MemoryFeedbackActionDto[] }>(memoryFeedbackActionsPath(workspaceId)),
      request<{ feedback: MemoryVersionFeedbackDto[] }>(memoryFeedbackPath(workspaceId)),
    ]).then(async ([actionResult, feedbackResult]) => {
      if (!Array.isArray(actionResult.actions) || !Array.isArray(feedbackResult.feedback)) {
        throw new Error('记忆反馈接口响应格式无效');
      }
      const views = joinMemoryFeedbackActions(actionResult.actions, feedbackResult.feedback);
      const memoryIds = [...new Set(views.map(view => view.action.memoryId))];
      const entryResults: Array<readonly [string, { readonly entry?: MemoryEntryDto; readonly entryError?: string }]> = await Promise.all(memoryIds.map(async memoryId => {
        try {
          const result = await request<{ entry: MemoryEntryDto }>(memoryEntryPath(workspaceId, memoryId));
          if (!result.entry || result.entry.id !== memoryId
            || (result.entry.workspaceId !== workspaceId && result.entry.scope !== 'global')) {
            throw new Error('正式记忆响应与当前工作区不匹配');
          }
          return [memoryId, { entry: result.entry }] as const;
        } catch (entryLoadError) {
          return [memoryId, { entryError: entryLoadError instanceof Error ? entryLoadError.message : String(entryLoadError) }] as const;
        }
      }));
      if (!isCurrent()) return;
      const entriesById = new Map(entryResults);
      const rows: LoadedRow[] = views.map(view => ({ ...view, ...entriesById.get(view.action.memoryId) }));
      setLoadState({ workspaceId, status: 'success', rows });
    }).catch(loadError => {
      if (isCurrent()) setLoadState({ workspaceId, status: 'error', message: errorMessage(loadError) });
    });

    return () => {
      if (requestGeneration.current === generation) requestGeneration.current += 1;
    };
  }, [reloadToken, request, workspaceId]);

  const currentState: LoadState = loadState.workspaceId === workspaceId
    ? loadState
    : { workspaceId, status: 'loading' };
  const rows = currentState.status === 'success' ? currentState.rows : [];

  const resolve = async (action: MemoryFeedbackActionDto, status: MemoryFeedbackActionResolution) => {
    if (busyId || action.status !== 'pending') return;
    const generation = requestGeneration.current;
    const isCurrent = () => memoryFeedbackResponseIsCurrent(
      workspaceId,
      activeWorkspaceId.current,
      generation,
      requestGeneration.current,
    );
    setBusyId(action.id);
    setError('');
    setStale(false);
    setNotice('');
    try {
      if (!isCurrent()) return;
      const result = await request<{ action: MemoryFeedbackActionDto }>(
        memoryFeedbackActionResolvePath(workspaceId, action.id),
        { method: 'POST', body: memoryFeedbackActionResolutionPayload(action, status) },
      );
      if (!isCurrent()) return;
      if (!result.action || result.action.id !== action.id || result.action.workspaceId !== workspaceId) {
        throw new Error('反馈操作响应与当前工作区不匹配');
      }
      setLoadState(state => state.workspaceId === workspaceId && state.status === 'success'
        ? { ...state, rows: state.rows.map(row => row.action.id === action.id ? { ...row, action: result.action } : row) }
        : state);
      setNotice(status === 'resolved' ? '反馈待办已标记为解决。' : '反馈待办已拒绝。');
    } catch (resolveError) {
      if (!isCurrent()) return;
      setError(errorMessage(resolveError));
      setStale(isMemoryVersionConflict(resolveError));
    } finally {
      if (isCurrent()) setBusyId(undefined);
    }
  };

  const sortedRows = [...rows].sort((left, right) => {
    if (left.action.status === 'pending' && right.action.status !== 'pending') return -1;
    if (right.action.status === 'pending' && left.action.status !== 'pending') return 1;
    return right.action.createdAt.localeCompare(left.action.createdAt);
  });

  return (
    <section aria-label="记忆反馈待办" className="min-h-0 min-w-0 flex-1 overflow-y-auto" data-agentos="memory-feedback-actions">
      <header className="mb-4">
        <div className="text-[11px] tracking-[0.14em] ui-dim">MEMORY FEEDBACK</div>
        <h3 className="mt-1 text-lg font-semibold ui-text">反馈待办</h3>
        <p className="mt-2 text-xs leading-5 ui-dim">待办关联原始冻结上下文和当前正式记忆。解决或拒绝会记录待办审计，不会改写历史快照。</p>
      </header>
      <MemoryAutoAcceptPolicy workspaceId={workspaceId} />
      {notice && <p role="status" className="mb-3 rounded-lg border ui-border p-3 text-xs ui-accent">{notice}</p>}
      {error && <div role="alert" className="mb-3 rounded-lg border border-[var(--app-danger)]/30 p-3 text-xs text-[var(--app-danger)]"><p>{error}</p><button type="button" onClick={() => setReloadToken(value => value + 1)} className="ui-button-ghost mt-2 rounded-lg border ui-border px-3 py-2">{stale ? '重新加载最新版本' : '重试'}</button></div>}
      {currentState.status === 'loading' ? <p role="status" className="p-3 text-sm ui-dim">正在加载记忆反馈待办…</p>
        : currentState.status === 'error' ? <div role="alert" className="rounded-xl border border-[var(--app-danger)]/30 p-4 text-sm text-[var(--app-danger)]"><p>加载记忆反馈待办失败：{currentState.message}</p><button type="button" onClick={() => setReloadToken(value => value + 1)} className="ui-button-ghost mt-3 rounded-lg border ui-border px-3 py-2 text-xs">重试</button></div>
          : sortedRows.length === 0 ? <div className="rounded-xl border border-dashed ui-border p-6 text-sm ui-dim">暂无记忆反馈待办。</div>
            : <div className="space-y-3">{sortedRows.map(row => <MemoryFeedbackActionRow
              key={row.action.id}
              view={row}
              entry={row.entry}
              entryError={row.entryError}
              busy={busyId === row.action.id}
              onResolve={(item, status) => { void resolve(item, status); }}
              onOpenContext={onOpenContext}
            />)}</div>}
    </section>
  );
}
