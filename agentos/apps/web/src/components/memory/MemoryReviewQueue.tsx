'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi } from '@/lib/useApi';
import { uiLayerClass } from '@/lib/uiLayers';
import {
  isMemoryVersionConflict,
  memoryCandidateReviewPath,
  memoryCandidatesPath,
  memoryVersionConflictGuidance,
  workspaceResponseIsCurrent,
} from '@/lib/memoryManagement';

/**
 * MF-5 forward Memory Candidate review queue (12-UI-Architecture section 14).
 *
 * Consumes the MF-2 forward tables through the MF-5 API:
 *   GET  /api/workspaces/:id/memory/candidates?outcome=review-required
 *   POST /api/workspaces/:id/memory/candidates/:candidateId/review
 *
 * Review actions are version-guarded (expectedVersion) and never delete the
 * Candidate. Supported outcomes here: accept, reject, merge-with-existing.
 * edit-and-accept is intentionally not offered: the merged review contract
 * records the outcome without applying edited fields, and presenting an edit
 * form that silently does not edit would be dishonest UI. The legacy
 * COMPATIBILITY candidate queue remains untouched.
 */

export interface ForwardMemoryCandidateDto {
  readonly id: string;
  readonly scope: string;
  readonly category: string;
  readonly authority: string;
  readonly confidence: number;
  readonly importance: number;
  readonly title: string;
  readonly summary: string;
  readonly content: string;
  readonly tags: readonly string[];
  readonly outcome: string;
  readonly decision: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly sources: readonly { readonly kind: string; readonly id: string }[];
}

export type ReviewOutcome = 'accept' | 'reject' | 'merge-with-existing';

export function artifactContentUrl(apiRoot: string, workspaceId: string, artifactId: string): string {
  return `${apiRoot}/api/workspaces/${encodeURIComponent(workspaceId)}/artifacts/${encodeURIComponent(artifactId)}/content`;
}

/** Pure body builder, unit-tested without a DOM. */
export function buildReviewBody(candidate: ForwardMemoryCandidateDto, outcome: ReviewOutcome, mergedIntoEntryId?: string): Record<string, unknown> {
  return {
    expectedVersion: candidate.version,
    outcome,
    ...(outcome === 'merge-with-existing' && mergedIntoEntryId !== undefined && mergedIntoEntryId.trim().length > 0
      ? { mergedIntoEntryId: mergedIntoEntryId.trim() }
      : {}),
  };
}

interface MemoryReviewQueueProps {
  workspaceId: string;
  onClose?(): void;
  embedded?: boolean;
}

export function MemoryReviewQueue({ workspaceId, onClose, embedded = false }: MemoryReviewQueueProps) {
  const { API_BASE, request } = useApi();
  const [candidates, setCandidates] = useState<ForwardMemoryCandidateDto[]>([]);
  const [mergeTargets, setMergeTargets] = useState<Record<string, string>>({});
  const [mergingId, setMergingId] = useState<string>();
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [loading, setLoading] = useState(true);
  const activeWorkspaceId = useRef(workspaceId);
  const workspaceGeneration = useRef(0);
  const loadGeneration = useRef(0);
  activeWorkspaceId.current = workspaceId;

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    setError('');
    setStale(false);
    try {
      const result = await request<{ candidates: ForwardMemoryCandidateDto[] }>(memoryCandidatesPath(workspaceId));
      if (workspaceResponseIsCurrent(workspaceId, activeWorkspaceId.current, generation, loadGeneration.current)) setCandidates(result.candidates);
    } catch (loadError) {
      if (workspaceResponseIsCurrent(workspaceId, activeWorkspaceId.current, generation, loadGeneration.current)) {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    } finally {
      if (workspaceResponseIsCurrent(workspaceId, activeWorkspaceId.current, generation, loadGeneration.current)) setLoading(false);
    }
  }, [request, workspaceId]);

  useEffect(() => {
    const generation = ++workspaceGeneration.current;
    setCandidates([]);
    setMergeTargets({});
    setMergingId(undefined);
    void load();
    return () => {
      if (workspaceGeneration.current === generation) workspaceGeneration.current += 1;
      loadGeneration.current += 1;
    };
  }, [load]);

  const review = async (candidate: ForwardMemoryCandidateDto, outcome: ReviewOutcome) => {
    const generation = workspaceGeneration.current;
    setBusyId(candidate.id); setError(''); setStale(false);
    try {
      await request(memoryCandidateReviewPath(workspaceId, candidate.id), {
        method: 'POST',
        body: buildReviewBody(candidate, outcome, mergeTargets[candidate.id]),
      });
      if (!workspaceResponseIsCurrent(workspaceId, activeWorkspaceId.current, generation, workspaceGeneration.current)) return;
      setCandidates(current => current.filter(item => item.id !== candidate.id));
      setMergingId(undefined);
    } catch (reviewError) {
      if (!workspaceResponseIsCurrent(workspaceId, activeWorkspaceId.current, generation, workspaceGeneration.current)) return;
      const message = reviewError instanceof Error ? reviewError.message : String(reviewError);
      setError([message, memoryVersionConflictGuidance(reviewError)].filter(Boolean).join(' '));
      setStale(isMemoryVersionConflict(reviewError));
    } finally {
      if (workspaceResponseIsCurrent(workspaceId, activeWorkspaceId.current, generation, workspaceGeneration.current)) setBusyId(undefined);
    }
  };

  const shellClass = embedded
    ? 'flex min-h-0 min-w-0 flex-1 flex-col'
    : `fixed inset-0 ${uiLayerClass('workspaceSurface')} bg-[var(--app-surface)] p-6`;

  return (
    <div className={shellClass} data-agentos="memory-review-queue">
      <div className={`mx-auto flex min-h-0 h-full w-full flex-col ${embedded ? '' : 'max-w-5xl'}`}>
        <div className="mb-5 flex items-center justify-between">
          <div>
            <div className="text-[11px] tracking-[0.16em] ui-dim">MEMORY REVIEW</div>
            <h2 className="mt-1 text-xl font-semibold ui-text">记忆候选审查</h2>
          </div>
          {onClose && <button type="button" onClick={onClose} className="ui-button-ghost rounded-lg px-3 py-2 text-sm">关闭</button>}
        </div>
        {error && <p className="mb-3 rounded-lg border border-[var(--app-danger)]/30 p-3 text-sm text-[var(--app-danger)]">{error}</p>}
        {error && !stale && <button type="button" onClick={() => { void load(); }} className="mb-3 self-start rounded-lg border ui-border px-3 py-2 text-xs ui-accent">重试加载候选</button>}
        {stale && <button type="button" onClick={() => { void load(); }} className="mb-3 self-start rounded-lg border ui-border px-3 py-2 text-xs ui-accent">重新加载最新版本</button>}
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
          {loading
            ? <p role="status" className="p-4 text-center text-sm ui-dim">正在加载待审查候选…</p>
            : candidates.length === 0
            ? <div className="ui-panel rounded-2xl border p-8 text-center text-sm ui-dim">暂无待审查候选</div>
            : candidates.map(candidate => (
              <article key={candidate.id} className="ui-panel rounded-2xl border p-5" data-candidate-id={candidate.id}>
                <div className="mb-3">
                  <span className="rounded-full border px-2 py-1 text-xs ui-text-soft">{candidate.scope} · {candidate.category}</span>
                  <span className="ml-2 text-xs ui-dim">
                    {candidate.authority} · 置信 {candidate.confidence} · 重要 {candidate.importance} · 判定 {candidate.decision ?? '—'}
                  </span>
                  <h3 className="mt-2 font-semibold ui-text">{candidate.title}</h3>
                </div>
                {candidate.content.length > 0 && <p className="text-sm ui-text-soft">{candidate.content}</p>}
                {candidate.sources.length > 0 && (
                  <p className="mt-2 text-xs ui-dim">
                    来源：
                    {candidate.sources.map((source, index) => {
                      const label = `${source.kind}:${source.id}`;
                      return (
                        <span key={label}>
                          {index > 0 && '、'}
                          {source.kind === 'artifact' ? (
                            <a href={artifactContentUrl(API_BASE, workspaceId, source.id)} target="_blank" rel="noreferrer"
                              className="underline underline-offset-2 focus-visible:outline focus-visible:outline-2">{label}</a>
                          ) : label}
                        </span>
                      );
                    })}
                  </p>
                )}
                {mergingId === candidate.id && (
                  <label className="mt-3 block text-xs ui-text-soft">
                    合并目标 Entry ID（同一 Workspace 内已存在的正式记忆）
                    <input
                      value={mergeTargets[candidate.id] ?? ''}
                      onChange={event => setMergeTargets(current => ({ ...current, [candidate.id]: event.target.value }))}
                      className="ui-input mt-1 w-full rounded-lg border px-3 py-2 text-sm"
                      placeholder="mem_..."
                    />
                  </label>
                )}
                <div className="mt-4 flex justify-end gap-2">
                  {mergingId === candidate.id ? (
                    <>
                      <button type="button" disabled={busyId === candidate.id} onClick={() => setMergingId(undefined)} className="ui-button-ghost rounded-lg px-3 py-2 text-sm disabled:opacity-50">取消</button>
                      <button
                        type="button"
                        disabled={busyId === candidate.id || (mergeTargets[candidate.id] ?? '').trim().length === 0}
                        onClick={() => { void review(candidate, 'merge-with-existing'); }}
                        className="ui-button-primary rounded-lg px-3 py-2 text-sm disabled:opacity-50"
                      >确认合并</button>
                    </>
                  ) : (
                    <>
                      <button type="button" disabled={busyId === candidate.id} onClick={() => { void review(candidate, 'reject'); }} className="ui-button-ghost rounded-lg px-3 py-2 text-sm disabled:opacity-50">拒绝</button>
                      <button type="button" disabled={busyId === candidate.id} onClick={() => setMergingId(candidate.id)} className="ui-button-ghost rounded-lg px-3 py-2 text-sm disabled:opacity-50">合并到已有</button>
                      <button type="button" disabled={busyId === candidate.id} onClick={() => { void review(candidate, 'accept'); }} className="ui-button-primary rounded-lg px-3 py-2 text-sm disabled:opacity-50">接受</button>
                    </>
                  )}
                </div>
              </article>
            ))}
        </div>
      </div>
    </div>
  );
}
