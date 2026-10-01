'use client';

import { MEMORY_CONFLICT_DISPOSITIONS, type MemoryConflictDisposition, type MemoryConflictType } from '@agentos/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi } from '@/lib/useApi';
import {
  isMemoryVersionConflict,
  memoryConflictsPath,
  memoryConflictResolutionPath,
  memoryConflictResolutionPayload,
  memoryVersionConflictGuidance,
  workspaceResponseIsCurrent,
  type MemoryConflictDto,
  type MemoryConflictStatusFilter,
} from '@/lib/memoryManagement';
import { memoryCategoryLabel, memoryEntryPath, memoryScopeLabel, memoryStatusLabel, type MemoryEntryDto } from '@/lib/memoryEntries';

const statusOptions: readonly { value: MemoryConflictStatusFilter; label: string }[] = [
  { value: 'open', label: '待处理' },
  { value: 'resolved', label: '已处理' },
  { value: 'all', label: '全部冲突' },
];

const conflictTypeLabels: Partial<Record<MemoryConflictType, string>> = {
  contradiction: '内容矛盾',
  'overlapping-scope': '范围重叠',
  'authority-disagreement': '权威来源不一致',
  'temporal-disagreement': '时间信息不一致',
};

const dispositionLabels: Record<MemoryConflictDisposition, { label: string; explanation: string }> = {
  'keep-both': {
    label: '保留两条',
    explanation: '保留双方内容并解除本次冲突标记；若仍有其他待处理冲突，相关条目会继续标记为冲突。',
  },
  'supersede-earlier': {
    label: '替代较早条目',
    explanation: '将创建时间较早的条目标记为已替代，并解除较新条目的本次冲突标记。',
  },
  'supersede-later': {
    label: '替代较新条目',
    explanation: '将创建时间较新的条目标记为已替代，并解除较早条目的本次冲突标记。',
  },
  'promote-source': {
    label: '提升来源记录',
    explanation: '当前服务不会指定某一侧来源；状态处理与“保留两条”相同，并记录此处置值。',
  },
  'reject-both': {
    label: '拒绝两条',
    explanation: '将双方条目标记为已拒绝，不会删除条目。',
  },
};

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function EntrySide({ label, entry }: { label: string; entry: MemoryEntryDto }) {
  return <section className="min-w-0 rounded-xl border ui-border p-4" aria-label={`${label}条目详情`}>
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        <div className="text-[11px] ui-dim">{label} · {entry.id}</div>
        <h4 className="mt-1 break-words font-semibold ui-text">{entry.title}</h4>
      </div>
      <span className="shrink-0 rounded-full border ui-border px-2 py-1 text-[11px] ui-text-soft">{memoryStatusLabel(entry.status)}</span>
    </div>
    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs ui-dim">
      <span>{memoryCategoryLabel(entry.category)}</span>
      <span>{memoryScopeLabel(entry.scope)}</span>
      <span>置信度 {Math.round(entry.confidence * 100)}%</span>
    </div>
    {entry.summary.trim() && <p className="mt-3 whitespace-pre-wrap break-words text-sm ui-text-soft">{entry.summary}</p>}
    <p className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-6 ui-text-soft">{entry.content}</p>
    {entry.tags.length > 0 && <p className="mt-3 text-xs ui-dim">标签：{entry.tags.join('、')}</p>}
    <div className="mt-3 border-t ui-border pt-3 text-xs ui-dim">
      <span>来源：</span>
      {entry.sources.length === 0
        ? <span>暂无来源记录</span>
        : entry.sources.map((source, index) => <span key={`${source.kind}:${source.id}:${index}`}>
          {index > 0 && '、'}{source.kind}:{source.id}
        </span>)}
    </div>
  </section>;
}

export function MemoryConflictManagement({ workspaceId }: { workspaceId: string }) {
  const { request } = useApi();
  const [status, setStatus] = useState<MemoryConflictStatusFilter>('open');
  const [conflicts, setConflicts] = useState<MemoryConflictDto[]>([]);
  const [entriesById, setEntriesById] = useState<Record<string, MemoryEntryDto>>({});
  const [selectedDisposition, setSelectedDisposition] = useState<Record<string, MemoryConflictDisposition>>({});
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [notice, setNotice] = useState('');
  const activeWorkspaceId = useRef(workspaceId);
  const workspaceGeneration = useRef(0);
  const loadGeneration = useRef(0);
  activeWorkspaceId.current = workspaceId;
  const activeStatus = useRef(status);
  activeStatus.current = status;

  useEffect(() => {
    const generation = workspaceGeneration.current + 1;
    workspaceGeneration.current = generation;
    return () => {
      if (workspaceGeneration.current === generation) workspaceGeneration.current += 1;
    };
  }, [workspaceId]);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    setError('');
    setStale(false);
    setNotice('');
    try {
      const result = await request<{ conflicts: MemoryConflictDto[] }>(memoryConflictsPath(workspaceId, status));
      if (!workspaceResponseIsCurrent(workspaceId, activeWorkspaceId.current, generation, loadGeneration.current)) return;
      const entryIds = [...new Set(result.conflicts.flatMap(conflict => [conflict.entryAId, conflict.entryBId]))];
      const entryResults = await Promise.all(entryIds.map(async entryId => {
        const response = await request<{ entry: MemoryEntryDto }>(memoryEntryPath(workspaceId, entryId));
        return [entryId, response.entry] as const;
      }));
      if (!workspaceResponseIsCurrent(workspaceId, activeWorkspaceId.current, generation, loadGeneration.current)) return;
      setConflicts(result.conflicts);
      setEntriesById(Object.fromEntries(entryResults) as Record<string, MemoryEntryDto>);
    } catch (loadError) {
      if (workspaceResponseIsCurrent(workspaceId, activeWorkspaceId.current, generation, loadGeneration.current)) {
        setError(asMessage(loadError));
      }
    } finally {
      if (workspaceResponseIsCurrent(workspaceId, activeWorkspaceId.current, generation, loadGeneration.current)) setLoading(false);
    }
  }, [request, status, workspaceId]);

  useEffect(() => {
    setConflicts([]);
    setEntriesById({});
    void load();
    return () => { loadGeneration.current += 1; };
  }, [load]);

  const resolve = async (conflict: MemoryConflictDto) => {
    if (busyId || conflict.status !== 'open') return;
    const disposition = selectedDisposition[conflict.id] ?? MEMORY_CONFLICT_DISPOSITIONS[0];
    const workspaceEpoch = workspaceGeneration.current;
    const requestedStatus = status;
    setBusyId(conflict.id);
    setError('');
    setNotice('');
    setStale(false);
    try {
      await request<{ conflict: MemoryConflictDto }>(memoryConflictResolutionPath(workspaceId, conflict.id), {
        method: 'POST',
        body: memoryConflictResolutionPayload(conflict, disposition),
      });
      if (!workspaceResponseIsCurrent(workspaceId, activeWorkspaceId.current, workspaceEpoch, workspaceGeneration.current)
        || activeStatus.current !== requestedStatus) return;
      await load();
      if (workspaceResponseIsCurrent(workspaceId, activeWorkspaceId.current, workspaceEpoch, workspaceGeneration.current)
        && activeStatus.current === requestedStatus) setNotice('冲突处置已保存，列表已按当前筛选重新加载。');
    } catch (resolveError) {
      if (!workspaceResponseIsCurrent(workspaceId, activeWorkspaceId.current, workspaceEpoch, workspaceGeneration.current)) return;
      setError([asMessage(resolveError), memoryVersionConflictGuidance(resolveError)].filter(Boolean).join(' '));
      setStale(isMemoryVersionConflict(resolveError));
    } finally {
      if (workspaceResponseIsCurrent(workspaceId, activeWorkspaceId.current, workspaceEpoch, workspaceGeneration.current)) setBusyId(undefined);
    }
  };

  return <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-agentos="memory-conflict-management">
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h3 className="font-semibold ui-text">冲突管理</h3>
        <p className="mt-1 text-xs ui-dim">逐条比较双方正式记忆及来源，再选择当前服务支持的处置方式。</p>
      </div>
      <label className="flex items-center gap-2 text-xs ui-text-soft">
        <span>显示</span>
        <select aria-label="冲突状态筛选" value={status} onChange={event => setStatus(event.target.value as MemoryConflictStatusFilter)} className="ui-input rounded-lg border px-3 py-2 text-xs">
          {statusOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
    </div>
    {error && <div role="alert" className="mb-3 rounded-lg border border-[var(--app-danger)]/30 p-3 text-sm text-[var(--app-danger)]">
      <p>{error}</p>
      <button type="button" onClick={() => { void load(); }} className="mt-2 rounded-lg border ui-border px-3 py-2 text-xs ui-accent">{stale ? '重新加载最新版本' : '重试加载冲突'}</button>
    </div>}
    {notice && <p role="status" className="mb-3 rounded-lg border ui-border p-3 text-sm ui-text-soft">{notice}</p>}
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
      {loading
        ? <p role="status" className="p-6 text-center text-sm ui-dim">正在加载冲突及双方条目…</p>
        : conflicts.length === 0
          ? <div className="ui-panel rounded-2xl border p-8 text-center text-sm ui-dim">当前筛选下没有冲突记录</div>
          : conflicts.map(conflict => {
            const entryA = entriesById[conflict.entryAId];
            const entryB = entriesById[conflict.entryBId];
            const disposition = selectedDisposition[conflict.id] ?? MEMORY_CONFLICT_DISPOSITIONS[0];
            const busy = busyId === conflict.id;
            return <article key={conflict.id} className="ui-panel rounded-2xl border p-4 sm:p-5" data-conflict-id={conflict.id}>
              <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="font-semibold ui-text">{conflictTypeLabels[conflict.conflictType] ?? conflict.conflictType}</h4>
                    <span className="rounded-full border ui-border px-2 py-1 text-[11px] ui-text-soft">{conflict.status === 'open' ? '待处理' : '已处理'}</span>
                    {conflict.disposition && <span className="text-xs ui-dim">处置：{dispositionLabels[conflict.disposition].label}</span>}
                  </div>
                  <p className="mt-1 text-xs ui-dim">ID {conflict.id} · 版本 {conflict.version} · 创建于 {new Date(conflict.createdAt).toLocaleString()}</p>
                  {conflict.resolvedAt && <p className="mt-1 text-xs ui-dim">处理于 {new Date(conflict.resolvedAt).toLocaleString()}</p>}
                </div>
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                {entryA ? <EntrySide label="条目 A" entry={entryA} /> : <p role="status" className="rounded-xl border ui-border p-4 text-sm ui-dim">无法读取条目 A：{conflict.entryAId}</p>}
                {entryB ? <EntrySide label="条目 B" entry={entryB} /> : <p role="status" className="rounded-xl border ui-border p-4 text-sm ui-dim">无法读取条目 B：{conflict.entryBId}</p>}
              </div>
              {conflict.status === 'open' && <div className="mt-4 rounded-xl border ui-border p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                  <label className="block min-w-0 flex-1 text-xs ui-text-soft">
                    处置方式
                    <select aria-label={`冲突 ${conflict.id} 的处置方式`} value={disposition}
                      disabled={busy || Boolean(busyId)}
                      onChange={event => setSelectedDisposition(current => ({ ...current, [conflict.id]: event.target.value as MemoryConflictDisposition }))}
                      className="ui-input mt-1 block w-full rounded-lg border px-3 py-2 text-sm">
                      {MEMORY_CONFLICT_DISPOSITIONS.map(option => <option key={option} value={option}>{dispositionLabels[option].label}</option>)}
                    </select>
                  </label>
                  <button type="button" disabled={busy || Boolean(busyId) || !entryA || !entryB} onClick={() => { void resolve(conflict); }}
                    className="ui-button-primary shrink-0 rounded-lg px-4 py-2 text-sm disabled:opacity-50">
                    {busy ? '正在保存…' : '确认处置'}
                  </button>
                </div>
                <p className="mt-2 text-xs leading-5 ui-dim">{dispositionLabels[disposition].explanation}</p>
                {disposition === 'supersede-earlier' || disposition === 'supersede-later'
                  ? <p className="mt-1 text-[11px] ui-dim">较早/较新按创建时间判断；时间相同时由条目 ID 决定先后。</p>
                  : null}
              </div>}
            </article>;
          })}
    </div>
  </div>;
}
