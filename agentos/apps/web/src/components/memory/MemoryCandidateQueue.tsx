'use client';

import { useCallback, useEffect, useState } from 'react';
import type { MemoryCandidate } from '@agentos/shared';
import { useApi } from '@/lib/useApi';
import { ModalShell } from '@/components/feedback/ModalShell';
import { StatusNotice } from '@/components/feedback/StatusNotice';

interface MemoryCandidateQueueProps {
  workspaceId: string;
  onClose(): void;
  onOpenRun(runId: string): void;
}

type Draft = Pick<MemoryCandidate, 'title' | 'summary' | 'content'>;

export function MemoryCandidateQueue({ workspaceId, onClose, onOpenRun }: MemoryCandidateQueueProps) {
  const { request } = useApi();
  const [candidates, setCandidates] = useState<MemoryCandidate[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const result = await request<{ candidates: MemoryCandidate[] }>(`/api/workspaces/${workspaceId}/memory-candidates?status=pending`);
    setCandidates(result.candidates);
    setDrafts(Object.fromEntries(result.candidates.map(candidate => [candidate.id, { title: candidate.title, summary: candidate.summary, content: candidate.content }])));
  }, [request, workspaceId]);

  useEffect(() => { void load().catch(loadError => setError(loadError instanceof Error ? loadError.message : String(loadError))); }, [load]);

  const review = async (candidate: MemoryCandidate, action: 'accept' | 'reject') => {
    setBusyId(candidate.id); setError('');
    try {
      await request(`/api/workspaces/${workspaceId}/memory-candidates/${candidate.id}/${action}`, {
        method: 'POST', body: action === 'accept' ? drafts[candidate.id] : undefined,
      });
      setCandidates(current => current.filter(item => item.id !== candidate.id));
    } catch (reviewError) { setError(reviewError instanceof Error ? reviewError.message : String(reviewError)); }
    finally { setBusyId(undefined); }
  };

  return <ModalShell title="待审核记忆候选" eyebrow="MEMORY REVIEW" description="确认前请检查候选内容和来源；接受操作会写入正式记忆。" onClose={onClose} size="lg">
    <div className="space-y-4">
      {error && <StatusNotice tone="error" title="记忆候选操作失败">{error}</StatusNotice>}
      <div className="space-y-4">{candidates.length === 0 ? <div className="ui-panel rounded-2xl border p-8 text-center text-sm ui-dim">暂无待审核候选</div> : candidates.map(candidate => { const draft = drafts[candidate.id] ?? { title: candidate.title, summary: candidate.summary, content: candidate.content }; return <article key={candidate.id} className="ui-panel rounded-2xl border p-5"><div className="mb-3 flex items-start justify-between gap-4"><div><span className="rounded-full border px-2 py-1 text-xs ui-text-soft">{candidate.type}</span><span className="ml-2 text-xs ui-dim">置信度 {candidate.confidence}</span><h3 className="mt-2 font-semibold ui-text">{candidate.title}</h3></div><button type="button" onClick={() => onOpenRun(candidate.runId)} className="ui-button-ghost rounded-lg px-2 py-1 text-xs">查看来源 Run</button></div><div className="grid gap-3 md:grid-cols-2"><label className="text-xs ui-text-soft">标题<input value={draft.title} onChange={event => setDrafts(current => ({ ...current, [candidate.id]: { ...draft, title: event.target.value } }))} className="ui-input mt-1 w-full rounded-lg border px-3 py-2 text-sm" /></label><label className="text-xs ui-text-soft">摘要<input value={draft.summary} onChange={event => setDrafts(current => ({ ...current, [candidate.id]: { ...draft, summary: event.target.value } }))} className="ui-input mt-1 w-full rounded-lg border px-3 py-2 text-sm" /></label><label className="text-xs ui-text-soft md:col-span-2">正文<textarea value={draft.content} onChange={event => setDrafts(current => ({ ...current, [candidate.id]: { ...draft, content: event.target.value } }))} className="ui-input mt-1 min-h-28 w-full rounded-lg border px-3 py-2 text-sm" /></label></div>{candidate.conflictingMemoryIds.length > 0 && <p className="mt-3 text-xs text-[var(--app-warning)]">可能冲突的正式记忆：{candidate.conflictingMemoryIds.join('、')}</p>}<div className="mt-4 flex justify-end gap-2"><button type="button" disabled={busyId === candidate.id} onClick={() => { void review(candidate, 'reject'); }} className="ui-button-ghost rounded-lg px-3 py-2 text-sm disabled:opacity-50">拒绝</button><button type="button" disabled={busyId === candidate.id} onClick={() => { void review(candidate, 'accept'); }} className="ui-button-primary rounded-lg px-3 py-2 text-sm disabled:opacity-50">编辑后接受</button></div></article>; })}</div>
    </div>
  </ModalShell>;
}
