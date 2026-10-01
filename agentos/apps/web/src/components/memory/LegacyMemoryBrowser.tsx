'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MemoryRecord } from '@agentos/shared';
import { useApi } from '@/lib/useApi';
import { legacyMemoryFilename, legacyMemoryMarkdown } from '@/lib/memoryEntries';
import { memoryPreview, memoryTypeLabels } from '@/lib/memories';
import { MemoryMarkdownPreview } from './MemoryMarkdownPreview';
import { MemorySourceLinks } from './MemorySourceLinks';

interface LegacyMemoryDetail extends MemoryRecord {
  content: string;
}

interface LegacyMemoryBrowserProps {
  workspaceId: string;
  onOpenRun(runId: string): void;
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function LegacyMemoryBrowser({ workspaceId, onOpenRun }: LegacyMemoryBrowserProps) {
  const { request } = useApi();
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [selected, setSelected] = useState<LegacyMemoryDetail | null>(null);
  const [selectedId, setSelectedId] = useState<string>();
  const [query, setQuery] = useState('');
  const [loadingList, setLoadingList] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const listGeneration = useRef(0);
  const detailGeneration = useRef(0);

  const load = useCallback(async () => {
    const generation = ++listGeneration.current;
    const params = new URLSearchParams({ status: 'all' });
    if (query.trim()) params.set('query', query.trim());
    setLoadingList(true);
    setError('');
    try {
      const result = await request<{ memories: MemoryRecord[] }>(`/api/workspaces/${encodeURIComponent(workspaceId)}/memories?${params}`);
      if (generation === listGeneration.current) setMemories(result.memories);
    } catch (loadError) {
      if (generation === listGeneration.current) setError(asMessage(loadError));
    } finally {
      if (generation === listGeneration.current) setLoadingList(false);
    }
  }, [query, request, workspaceId]);

  useEffect(() => {
    void load();
    return () => { listGeneration.current += 1; };
  }, [load]);

  useEffect(() => () => { detailGeneration.current += 1; }, [workspaceId]);

  const select = async (memory: MemoryRecord) => {
    if (importing || loadingList) return;
    const generation = ++detailGeneration.current;
    setSelectedId(memory.id);
    setSelected(null);
    setLoadingDetail(true);
    setError('');
    setNotice('');
    try {
      const result = await request<{ memory: MemoryRecord & { content?: string }; content?: string }>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/memories/${encodeURIComponent(memory.id)}`,
      );
      if (generation !== detailGeneration.current) return;
      setSelected({ ...result.memory, content: result.content ?? result.memory.content ?? '' });
    } catch (detailError) {
      if (generation === detailGeneration.current) setError(asMessage(detailError));
    } finally {
      if (generation === detailGeneration.current) setLoadingDetail(false);
    }
  };

  const importToReview = async () => {
    if (!selected || importing) return;
    setImporting(true);
    setError('');
    setNotice('');
    try {
      const result = await request<{ imported?: readonly unknown[]; converged?: readonly unknown[] }>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/memory/import/confirm`,
        {
          method: 'POST',
          body: {
            fileName: legacyMemoryFilename(selected.id),
            content: legacyMemoryMarkdown(selected.title, selected.summary, selected.content),
          },
        },
      );
      const newCandidates = result.imported?.length ?? 0;
      const reused = result.converged?.length ?? 0;
      setNotice(`已提交到记忆审查${newCandidates || reused ? `：新建候选 ${newCandidates} 条，复用记录 ${reused} 条` : ''}；尚未正式生效。`);
    } catch (importError) {
      setError(asMessage(importError));
    } finally {
      setImporting(false);
    }
  };

  return <div className="flex min-h-0 min-w-0 flex-1 flex-col sm:flex-row">
    <aside aria-label="旧版记忆列表" className="flex min-h-0 max-h-56 w-full shrink-0 flex-col border-b ui-border pb-4 pr-0 sm:max-h-none sm:w-72 sm:border-b-0 sm:border-r sm:pb-0 sm:pr-4">
      <div className="mb-4"><h3 className="font-medium ui-text">旧版记录</h3><p className="mt-1 text-[11px] ui-dim">只读查看；不会自动迁移</p></div>
      <input aria-label="搜索旧版记录" disabled={importing} value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索旧版记录" className="mb-3 rounded-lg border ui-border bg-transparent px-3 py-2 text-xs outline-none focus:border-[var(--app-accent)] disabled:opacity-60" />
      <div aria-live="polite" className="min-h-0 flex-1 space-y-2 overflow-y-auto">
        {loadingList && <p role="status" className="p-2 text-xs ui-dim">正在加载旧版记录…</p>}
        {memories.map(memory => <button
          key={memory.id} type="button" disabled={importing || loadingList} onClick={() => { void select(memory); }}
          className={`w-full rounded-xl border p-3 text-left ${selectedId === memory.id ? 'border-[var(--app-accent)] bg-[var(--app-accent)]/10' : 'ui-border ui-button-ghost'}`}
        >
          <div className="truncate text-sm font-medium ui-text">{memory.title}</div>
          <div className="mt-1 text-[11px] ui-accent">{memoryTypeLabels[memory.type]} · {memory.status === 'archived' ? '已归档' : '生效中'}</div>
          <div className="mt-1 line-clamp-2 text-xs leading-5 ui-muted">{memoryPreview(memory)}</div>
        </button>)}
        {!loadingList && memories.length === 0 && <div className="rounded-xl border border-dashed ui-border p-4 text-xs leading-5 ui-dim">暂无旧版记录</div>}
      </div>
    </aside>
    <section aria-label="旧版记忆详情" className="min-w-0 flex-1 overflow-y-auto pl-0 pt-4 sm:pl-5 sm:pt-0">
      <div className="mb-5"><div className="text-[11px] tracking-[0.14em] ui-dim">LEGACY MEMORY · READ ONLY</div><h3 className="mt-1 text-lg font-semibold ui-text">{selected?.title ?? '旧版记录详情'}</h3></div>
      {error && <p role="alert" className="mb-3 rounded-lg border border-[var(--app-danger)]/30 bg-[var(--app-danger)]/10 p-3 text-xs text-[var(--app-danger)]">{error}</p>}
      {notice && <p role="status" className="mb-3 rounded-lg border ui-border p-3 text-xs ui-accent">{notice}</p>}
      {loadingDetail && <p role="status" className="mb-3 text-xs ui-dim">正在加载所选旧版记录…</p>}
      {!selected ? <div className="rounded-xl border border-dashed ui-border p-6 text-sm ui-dim">从左侧选择旧版记录查看详情。</div> : <>
        <div className="mb-4 flex flex-wrap gap-2 text-[11px] ui-dim"><span className="rounded-full border ui-border px-2 py-1">{memoryTypeLabels[selected.type]}</span><span className="rounded-full border ui-border px-2 py-1">{selected.status === 'archived' ? '已归档' : '生效中'}</span><span className="rounded-full border ui-border px-2 py-1">重要性 {selected.importance}</span><span className="rounded-full border ui-border px-2 py-1">置信度 {selected.confidence}</span></div>
        <h4 className="text-sm font-medium ui-text">摘要</h4><p className="mt-1 whitespace-pre-wrap text-sm leading-6 ui-text-soft">{selected.summary || '暂无摘要'}</p>
        <section className="mt-4"><h4 className="mb-2 text-xs ui-muted">旧版正文（只读）</h4><MemoryMarkdownPreview content={selected.content} /></section>
        <section className="mt-4"><h4 className="mb-2 text-xs ui-muted">标签</h4><div className="flex flex-wrap gap-2">{selected.tags.length ? selected.tags.map(tag => <span key={tag} className="rounded-full border ui-border px-2 py-1 text-[11px] ui-dim">{tag}</span>) : <span className="text-xs ui-dim">暂无标签</span>}</div></section>
        <section className="mt-4"><h4 className="mb-2 text-xs ui-muted">来源 Run</h4><MemorySourceLinks sourceRunIds={selected.sourceRunIds} onOpenRun={onOpenRun} /></section>
        <p className="mt-6 text-xs leading-5 ui-dim">仅导入标题、摘要和正文，提交为待审知识候选。旧类别、评分、标签和 Run 来源保留在原记录中。</p>
        <div className="mt-3 flex justify-end"><button type="button" disabled={importing || loadingDetail} onClick={() => { void importToReview(); }} className="rounded-lg bg-[var(--app-accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{importing ? '提交中…' : '导入文本到记忆审查'}</button></div>
      </>}
    </section>
  </div>;
}
