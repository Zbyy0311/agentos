'use client';

import { useEffect, useRef, useState } from 'react';
import { useApi } from '@/lib/useApi';
import {
  MEMORY_CONTEXT_KINDS,
  memoryContextsPath,
  parseMemoryContextsResponse,
  type MemoryContextKind,
  type MemoryContextRecord,
} from '@/lib/memoryContexts';

interface MemoryContextHistoryProps {
  readonly workspaceId: string;
}

type ContextLoadState =
  | { readonly workspaceId: string; readonly status: 'loading' }
  | { readonly workspaceId: string; readonly status: 'error'; readonly message: string }
  | { readonly workspaceId: string; readonly status: 'success'; readonly contexts: readonly MemoryContextRecord[] };

const KIND_LABELS: Record<MemoryContextKind, string> = {
  run: 'Run 上下文',
  stage: 'Stage 上下文',
  turn: 'Turn 上下文',
  'legacy-execution': '旧版执行上下文',
};

const UNRECORDED = '未记录';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function Metadata({ label, value }: { readonly label: string; readonly value?: string | null }) {
  return <div className="min-w-0"><dt className="ui-dim">{label}</dt><dd className="break-words ui-text-soft">{value ?? UNRECORDED}</dd></div>;
}

export function MemoryContextDetails({ context }: { readonly context: MemoryContextRecord }) {
  return (
    <article className="space-y-5" data-agentos="memory-context-details" data-context-id={context.id}>
      <header>
        <div className="text-[11px] tracking-[0.14em] ui-dim">{KIND_LABELS[context.kind]}</div>
        <h3 className="mt-1 break-words text-lg font-semibold ui-text">{context.id}</h3>
      </header>

      {context.retrievalDegraded === true ? (
        <p role="status" data-field="retrieval-degraded" className="rounded-lg border border-[var(--status-warning,#b8860b)]/40 p-3 text-xs leading-5 text-[var(--status-warning,#b8860b)]">
          生成此记录时的记忆检索处于降级状态。下方内容和选择说明均来自这条历史记录。
        </p>
      ) : null}

      <dl className="grid grid-cols-1 gap-x-5 gap-y-2 text-xs sm:grid-cols-2">
        <Metadata label="负责人" value={context.ownerId} />
        <Metadata label="创建时间" value={context.createdAt} />
        <Metadata label="Run" value={context.runId} />
        <Metadata label="Stage" value={context.stageId} />
        <Metadata label="Execution" value={context.executionId} />
        <Metadata label="Conversation" value={context.conversationId} />
        <Metadata label="Turn" value={context.turnId} />
        <Metadata label="检索策略" value={context.retrievalStrategyVersion} />
        <Metadata label="检索状态" value={context.retrievalDegraded === undefined ? UNRECORDED : context.retrievalDegraded ? '降级' : '正常'} />
        <Metadata label="查询哈希" value={context.queryHash} />
        <Metadata label="Token" value={`${context.totalTokens}${context.truncated ? ' · 已截断' : ''}`} />
      </dl>

      <section aria-label="冻结的上下文正文">
        <h4 className="mb-2 text-xs font-medium ui-text">冻结上下文</h4>
        {!context.payloadAvailable ? (
          <p data-field="payload-unavailable" className="rounded-xl border border-dashed ui-border p-4 text-xs leading-5 ui-dim">
            此历史记录未保存可回放的冻结上下文正文。
          </p>
        ) : context.contextText === null ? (
          <p data-field="payload-missing" className="rounded-xl border border-dashed ui-border p-4 text-xs leading-5 ui-dim">
            此记录标记冻结正文可用，但响应中没有正文。
          </p>
        ) : context.contextText.length === 0 ? (
          <p data-field="payload-empty" className="rounded-xl border ui-border p-4 text-xs leading-5 ui-dim">冻结上下文为空。</p>
        ) : (
          <pre data-field="frozen-context" className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-xl border ui-border p-4 text-xs leading-5 ui-text-soft">{context.contextText}</pre>
        )}
      </section>

      <section data-agentos="memory-context-selected">
        <h4 className="mb-2 text-xs font-medium ui-text">选中的记忆</h4>
        {context.selected === null ? (
          <p className="text-xs ui-dim">此历史记录没有保存选取明细。</p>
        ) : context.selected.length === 0 ? (
          <p className="text-xs ui-dim">此记录没有选中记忆。</p>
        ) : (
          <ol className="space-y-2">
            {context.selected.map((item, index) => (
              <li key={`${item.memoryId}:${item.rank ?? index}`} className="rounded-xl border ui-border p-3" data-memory-id={item.memoryId}>
                <div className="break-words text-xs font-medium ui-text">
                  #{item.rank ?? UNRECORDED} {item.memoryId}
                  <span className="font-normal ui-dim"> · {item.memoryVersion === null ? '版本未记录' : `v${item.memoryVersion}`}</span>
                  <span className="font-normal ui-dim"> · {item.tokenCost === null ? 'Token 未记录' : `${item.tokenCost} tok`}</span>
                  {item.store ? <span className="font-normal ui-dim"> · {item.store}</span> : null}
                </div>
                <p className="mt-1 break-words text-xs leading-5 ui-dim">原因：{item.reasons.length > 0 ? item.reasons.join('、') : UNRECORDED}</p>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section data-agentos="memory-context-exclusions">
        <h4 className="mb-2 text-xs font-medium ui-text">排除项</h4>
        {context.exclusions === null ? (
          <p className="text-xs ui-dim">此历史记录没有保存排除项明细。</p>
        ) : context.exclusions.length === 0 ? (
          <p className="text-xs ui-dim">此记录没有排除项。</p>
        ) : (
          <ul className="space-y-1">
            {context.exclusions.map((item, index) => (
              <li key={`${item.memoryId}:${index}`} className="break-words text-xs leading-5 ui-dim" data-memory-id={item.memoryId}>
                {item.memoryId} — {item.reason ?? UNRECORDED}
              </li>
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}

export function MemoryContextHistory({ workspaceId }: MemoryContextHistoryProps) {
  const { request } = useApi();
  const [kind, setKind] = useState<MemoryContextKind | 'all'>('all');
  const [reloadToken, setReloadToken] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<ContextLoadState>({ workspaceId, status: 'loading' });
  const requestGeneration = useRef(0);

  useEffect(() => {
    const generation = ++requestGeneration.current;
    setLoadState({ workspaceId, status: 'loading' });
    void request<unknown>(memoryContextsPath(workspaceId, kind === 'all' ? {} : { kind }))
      .then(parseMemoryContextsResponse)
      .then(contexts => {
        if (generation !== requestGeneration.current) return;
        setSelectedId(contexts[0]?.id ?? null);
        setLoadState({ workspaceId, status: 'success', contexts });
      })
      .catch(error => {
        if (generation === requestGeneration.current) {
          setLoadState({ workspaceId, status: 'error', message: errorMessage(error) });
        }
      });
    return () => {
      if (generation === requestGeneration.current) requestGeneration.current += 1;
    };
  }, [kind, reloadToken, request, workspaceId]);

  const currentState: ContextLoadState = loadState.workspaceId === workspaceId
    ? loadState
    : { workspaceId, status: 'loading' };
  const contexts = currentState.status === 'success' ? currentState.contexts : [];
  const selected = contexts.find(context => context.id === selectedId);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col sm:flex-row" data-agentos="memory-context-history">
      <aside aria-label="上下文使用记录列表" className="flex min-h-0 max-h-64 w-full shrink-0 flex-col border-b ui-border pb-4 pr-0 sm:max-h-none sm:w-72 sm:border-b-0 sm:border-r sm:pb-0 sm:pr-4">
        <div className="mb-3">
          <h3 className="font-medium ui-text">记忆上下文使用记录</h3>
          <p className="mt-1 text-[11px] ui-dim">只读查看运行时保存的历史快照和选择说明</p>
        </div>
        <label className="mb-3 flex flex-col gap-1 text-[11px] ui-dim">
          记录类型
          <select aria-label="筛选上下文记录类型" value={kind} onChange={event => setKind(event.target.value as MemoryContextKind | 'all')} className="rounded-lg border ui-border bg-[var(--app-surface)] px-3 py-2 text-xs ui-text outline-none focus:border-[var(--app-accent)]">
            <option value="all">全部类型</option>
            {MEMORY_CONTEXT_KINDS.map(contextKind => <option key={contextKind} value={contextKind}>{KIND_LABELS[contextKind]}</option>)}
          </select>
        </label>
        <div aria-live="polite" className="min-h-0 flex-1 space-y-2 overflow-y-auto">
          {currentState.status === 'loading' ? <p role="status" className="p-2 text-xs ui-dim">正在加载使用记录…</p> : null}
          {contexts.map(context => (
            <button
              key={context.id}
              type="button"
              aria-pressed={selectedId === context.id}
              onClick={() => setSelectedId(context.id)}
              className={`w-full rounded-xl border p-3 text-left ${selectedId === context.id ? 'border-[var(--app-accent)] bg-[var(--app-accent)]/10' : 'ui-border ui-button-ghost'}`}
            >
              <div className="truncate text-xs font-medium ui-text">{KIND_LABELS[context.kind]}</div>
              <div className="mt-1 truncate text-[11px] ui-accent">{context.ownerId ?? '负责人未记录'}</div>
              <div className="mt-1 truncate text-[11px] ui-dim">{context.createdAt} · {context.totalTokens} tokens</div>
            </button>
          ))}
          {currentState.status === 'success' && contexts.length === 0 ? <p className="rounded-xl border border-dashed ui-border p-4 text-xs leading-5 ui-dim">此类型暂无上下文使用记录。</p> : null}
        </div>
      </aside>

      <section aria-label="上下文使用记录详情" className="min-w-0 flex-1 overflow-y-auto pl-0 pt-4 sm:pl-5 sm:pt-0">
        {currentState.status === 'error' ? (
          <div role="alert" className="rounded-xl border border-[var(--app-danger)]/30 bg-[var(--app-danger)]/10 p-4 text-sm text-[var(--app-danger)]">
            <p>加载记忆使用记录失败：{currentState.message}</p>
            <button type="button" onClick={() => setReloadToken(value => value + 1)} className="ui-button-ghost mt-3 rounded-lg border ui-border px-3 py-2 text-xs">重试</button>
          </div>
        ) : currentState.status === 'loading' ? (
          <p role="status" className="p-4 text-sm ui-dim">正在加载使用记录…</p>
        ) : contexts.length === 0 ? (
          <div className="rounded-xl border border-dashed ui-border p-6 text-sm ui-dim">暂无可查看的上下文使用记录。</div>
        ) : selected ? (
          <MemoryContextDetails context={selected} />
        ) : (
          <div className="rounded-xl border border-dashed ui-border p-6 text-sm ui-dim">从左侧选择一条上下文使用记录。</div>
        )}
      </section>
    </div>
  );
}
