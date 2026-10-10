'use client';

import { useEffect, useRef, useState } from 'react';
import type { MemoryEntryDto } from '@/lib/memoryEntries';
import {
  joinMemoryFeedbackActions,
  memoryFeedbackActionApplyPayload,
  memoryFeedbackActionResolvePath,
  memoryFeedbackActionResponseMatchesRequest,
  parseMemoryFeedbackActionResult,
  parseMemoryFeedbackActionsResponse,
  parseMemoryVersionFeedbackListResponse,
  memoryFeedbackActionResolutionPayload,
  memoryFeedbackActionsPath,
  memoryFeedbackPath,
  memoryFeedbackResponseIsCurrent,
  type MemoryFeedbackActionApplyDetails,
  type MemoryFeedbackActionDto,
  type MemoryFeedbackActionView,
  type MemoryFeedbackResolutionKind,
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
  readonly workspaceId: string;
  readonly view: MemoryFeedbackActionView;
  readonly entry?: MemoryEntryDto;
  readonly entryError?: string;
  readonly busy: boolean;
  readonly onReject: (action: MemoryFeedbackActionDto) => void;
  readonly onApply: (action: MemoryFeedbackActionDto, entry: MemoryEntryDto, details: MemoryFeedbackActionApplyDetails) => void;
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
const RESOLUTION_LABELS: Record<MemoryFeedbackResolutionKind, string> = {
  corrected: '提交修正版',
  archived: '归档这条记忆',
  revalidated: '重新验证当前版本',
};

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // ApiProblem responses carry a stable machine-readable `code`; legacy bodies
  // embedded the same code string in the message. Match either shape.
  const code = (error as { code?: unknown } | null)?.code;
  const token = typeof code === 'string' && code.length > 0 ? code : message;
  const guidance = memoryVersionConflictGuidance(error);
  if (token.includes('MEMORY_FEEDBACK_GLOBAL_ENTRY_OWNER_REQUIRED')) {
    return '这条全局记忆由其他工作区拥有。请在归属工作区修正、归档或重新验证；当前工作区可以拒绝本工作区提交的报告。所有待处理错误报告解除后，该版本才能再次使用。';
  }
  if (token.includes('MEMORY_FEEDBACK_CORRECTION_UNCHANGED')) {
    return '修正版必须更改标题、摘要或正文后才能解决此反馈。';
  }
  if (token.includes('MEMORY_FEEDBACK_RESOLUTION_REQUIRED')) {
    return '此旧请求没有提交解决依据。请打开处理表单，选择修正、归档或重新验证并填写结论与证据。';
  }
  return [message, guidance].filter(Boolean).join(' ');
}

interface MemoryFeedbackResolutionEditorProps {
  readonly entry: MemoryEntryDto;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onApply: (details: MemoryFeedbackActionApplyDetails) => void;
}

export function MemoryFeedbackResolutionEditor({ entry, busy, onCancel, onApply }: MemoryFeedbackResolutionEditorProps) {
  const [resolution, setResolution] = useState<MemoryFeedbackResolutionKind>('corrected');
  const [title, setTitle] = useState(entry.title);
  const [summary, setSummary] = useState(entry.summary);
  const [content, setContent] = useState(entry.content);
  const [conclusion, setConclusion] = useState('');
  const [evidence, setEvidence] = useState('');

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onApply({
      resolution,
      conclusion: conclusion.trim(),
      evidence: evidence.trim(),
      ...(resolution === 'corrected' ? { correctedEntry: { title: title.trim(), summary, content } } : {}),
    });
  };

  return <form onSubmit={submit} aria-label="处理记忆反馈" className="mt-3 space-y-3 rounded-lg border ui-border p-3">
    <label className="block text-xs ui-text-soft">处理方式
      <select aria-label="处理方式" value={resolution} onChange={event => setResolution(event.target.value as MemoryFeedbackResolutionKind)} className="ui-input mt-1 w-full rounded-lg border ui-border px-3 py-2">
        {Object.entries(RESOLUTION_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
    </label>
    {resolution === 'corrected' && <fieldset className="space-y-2">
      <legend className="text-xs font-medium ui-text">修正后的正式记忆（会生成新版本）</legend>
      <label className="block text-xs ui-text-soft">标题
        <input aria-label="修正后的标题" required value={title} onChange={event => setTitle(event.target.value)} className="ui-input mt-1 w-full rounded-lg border ui-border px-3 py-2" />
      </label>
      <label className="block text-xs ui-text-soft">摘要
        <textarea aria-label="修正后的摘要" value={summary} onChange={event => setSummary(event.target.value)} rows={2} className="ui-input mt-1 w-full rounded-lg border ui-border px-3 py-2" />
      </label>
      <label className="block text-xs ui-text-soft">正文
        <textarea aria-label="修正后的正文" required value={content} onChange={event => setContent(event.target.value)} rows={5} className="ui-input mt-1 w-full rounded-lg border ui-border px-3 py-2" />
      </label>
    </fieldset>}
    <label className="block text-xs ui-text-soft">处理结论
      <textarea aria-label="处理结论" required value={conclusion} onChange={event => setConclusion(event.target.value)} rows={2} className="ui-input mt-1 w-full rounded-lg border ui-border px-3 py-2" />
    </label>
    <label className="block text-xs ui-text-soft">证据与依据
      <textarea aria-label="证据与依据" required value={evidence} onChange={event => setEvidence(event.target.value)} rows={3} className="ui-input mt-1 w-full rounded-lg border ui-border px-3 py-2" />
    </label>
    <div className="flex justify-end gap-2">
      <button type="button" disabled={busy} onClick={onCancel} className="ui-button-ghost rounded-lg border ui-border px-3 py-2 text-xs disabled:opacity-50">取消</button>
      <button type="submit" disabled={busy} className="ui-button-primary rounded-lg px-3 py-2 text-xs disabled:opacity-50">{busy ? '处理中…' : '应用并解决'}</button>
    </div>
  </form>;
}

export function MemoryFeedbackActionRow({ workspaceId, view, entry, entryError, busy, onReject, onApply, onOpenContext }: FeedbackActionRowProps) {
  const { action, feedback } = view;
  const [editing, setEditing] = useState(false);
  const globalOwnedElsewhere = entry?.scope === 'global' && entry.workspaceId !== workspaceId;
  return (
    <article className="ui-panel rounded-xl border ui-border p-4" data-feedback-action-id={action.id} data-status={action.status}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h4 className="font-medium ui-text">{ACTION_LABELS[action.action]} · {FEEDBACK_LABELS[feedback?.kind ?? (action.action === 'correction' ? 'wrong' : 'outdated')]}</h4>
          <p className="mt-1 break-all text-xs ui-dim">记忆 {action.memoryId} · 冻结版本 v{action.memoryVersion}</p>
          <p className="mt-1 break-all text-xs ui-dim">报告工作区：{action.workspaceId}</p>
          {action.resolvedByWorkspaceId
            ? <p className="mt-1 break-all text-xs ui-dim">处理工作区：{action.resolvedByWorkspaceId}</p>
            : action.status !== 'pending' && <p className="mt-1 break-all text-xs ui-dim">处理工作区：历史记录未留存</p>}
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
          {globalOwnedElsewhere && action.status === 'pending' && <p role="status" className="mt-2 text-xs ui-dim">此全局记忆由其他工作区拥有。请在归属工作区处理报告；待处理报告继续约束该版本。</p>}
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

      {action.resolution && <section className="mt-3 rounded-lg border ui-border p-3" aria-label="反馈处理依据">
        <p className="text-xs font-medium ui-text">{RESOLUTION_LABELS[action.resolution.resolution]} · v{action.resolution.expectedEntryVersion} → v{action.resolution.resolvedEntryVersion}</p>
        <p className="mt-1 whitespace-pre-wrap break-words text-xs ui-text-soft">{action.resolution.conclusion}</p>
        <p className="mt-1 whitespace-pre-wrap break-words text-xs ui-dim">依据：{action.resolution.evidence}</p>
      </section>}

      {action.status === 'pending' && <>
        <div className="mt-3 flex justify-end gap-2">
          {!globalOwnedElsewhere && <>
            <button type="button" disabled={busy} onClick={() => onReject(action)} className="ui-button-ghost rounded-lg border ui-border px-3 py-2 text-xs disabled:opacity-50">拒绝</button>
            <button type="button" disabled={busy || !entry} onClick={() => setEditing(value => !value)} className="ui-button-primary rounded-lg px-3 py-2 text-xs disabled:opacity-50">{editing ? '收起处理表单' : '处理反馈'}</button>
          </>}
        </div>
        {editing && entry && <MemoryFeedbackResolutionEditor
          key={`${entry.id}:${entry.version}`}
          entry={entry}
          busy={busy}
          onCancel={() => setEditing(false)}
          onApply={details => onApply(action, entry, details)}
        />}
      </>}
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
      request<unknown>(memoryFeedbackActionsPath(workspaceId)),
      request<unknown>(memoryFeedbackPath(workspaceId)),
    ]).then(async ([actionValue, feedbackValue]) => {
      const actions = parseMemoryFeedbackActionsResponse(actionValue);
      const feedback = parseMemoryVersionFeedbackListResponse(feedbackValue);
      if (!actions || !feedback) {
        throw new Error('记忆反馈接口响应格式无效');
      }
      const views = joinMemoryFeedbackActions(actions, feedback);
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

  const mutate = async (
    action: MemoryFeedbackActionDto,
    body: unknown,
    successMessage: string,
    expectedEntry?: MemoryEntryDto,
  ) => {
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
      const response = await request<unknown>(
        memoryFeedbackActionResolvePath(workspaceId, action.id),
        { method: 'POST', body },
      );
      if (!isCurrent()) return;
      const result = parseMemoryFeedbackActionResult(response);
      if (!result) throw new Error('反馈操作接口响应格式无效');
      if (!memoryFeedbackActionResponseMatchesRequest(action, result.action, workspaceId)) {
        throw new Error('反馈操作响应与原报告身份不匹配');
      }
      if (expectedEntry && (!result.entry || result.entry.id !== expectedEntry.id
        || result.entry.workspaceId !== expectedEntry.workspaceId || result.entry.version !== expectedEntry.version + 1)) {
        throw new Error('处理结果没有返回预期的新记忆版本');
      }
      setLoadState(state => state.workspaceId === workspaceId && state.status === 'success'
        ? { ...state, rows: state.rows.map(row => row.action.id === action.id
          ? { ...row, action: result.action, ...(result.entry ? { entry: result.entry } : {}) }
          : row) }
        : state);
      setNotice(successMessage);
    } catch (resolveError) {
      if (!isCurrent()) return;
      setError(errorMessage(resolveError));
      setStale(isMemoryVersionConflict(resolveError));
    } finally {
      if (isCurrent()) setBusyId(undefined);
    }
  };

  const reject = (action: MemoryFeedbackActionDto) => mutate(
    action,
    memoryFeedbackActionResolutionPayload(action, 'rejected'),
    '反馈待办已拒绝；若该版本没有其他待处理错误报告，后续调用可再次使用。',
  );
  const apply = (action: MemoryFeedbackActionDto, entry: MemoryEntryDto, details: MemoryFeedbackActionApplyDetails) => mutate(
    action,
    memoryFeedbackActionApplyPayload(action, entry, details),
    `已${details.resolution === 'corrected' ? '提交修正版' : details.resolution === 'archived' ? '归档记忆' : '重新验证'}并解决反馈。`,
    entry,
  );

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
        <p className="mt-2 text-xs leading-5 ui-dim">处理时须提交修正版、归档或重新验证，并填写结论与依据。后续调用会隔离有待处理错误报告的版本；所有相关报告解除后才能再次使用。历史使用记录保留原始内容。</p>
      </header>
      <MemoryAutoAcceptPolicy workspaceId={workspaceId} />
      {notice && <p role="status" className="mb-3 rounded-lg border ui-border p-3 text-xs ui-accent">{notice}</p>}
      {error && <div role="alert" className="mb-3 rounded-lg border border-[var(--app-danger)]/30 p-3 text-xs text-[var(--app-danger)]"><p>{error}</p><button type="button" onClick={() => setReloadToken(value => value + 1)} className="ui-button-ghost mt-2 rounded-lg border ui-border px-3 py-2">{stale ? '重新加载最新版本' : '重试'}</button></div>}
      {currentState.status === 'loading' ? <p role="status" className="p-3 text-sm ui-dim">正在加载记忆反馈待办…</p>
        : currentState.status === 'error' ? <div role="alert" className="rounded-xl border border-[var(--app-danger)]/30 p-4 text-sm text-[var(--app-danger)]"><p>加载记忆反馈待办失败：{currentState.message}</p><button type="button" onClick={() => setReloadToken(value => value + 1)} className="ui-button-ghost mt-3 rounded-lg border ui-border px-3 py-2 text-xs">重试</button></div>
          : sortedRows.length === 0 ? <div className="rounded-xl border border-dashed ui-border p-6 text-sm ui-dim">暂无记忆反馈待办。</div>
            : <div className="space-y-3">{sortedRows.map(row => <MemoryFeedbackActionRow
              key={row.action.id}
              workspaceId={workspaceId}
              view={row}
              entry={row.entry}
              entryError={row.entryError}
              busy={busyId === row.action.id}
              onReject={item => { void reject(item); }}
              onApply={(item, entry, details) => { void apply(item, entry, details); }}
              onOpenContext={onOpenContext}
            />)}</div>}
    </section>
  );
}
