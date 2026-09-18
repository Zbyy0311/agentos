'use client';

import { useCallback, useEffect, useState } from 'react';
import type { MemoryRecord } from '@agentos/shared';
import { useApi } from '@/lib/useApi';
import { memoryQuery, type MemoryFormValues } from '@/lib/memories';
import { MemoryEditor, type MemoryWithContent } from './MemoryEditor';
import { MemoryList, type MemoryFilter } from './MemoryList';
import { ModalShell } from '@/components/feedback/ModalShell';
import { StatusNotice } from '@/components/feedback/StatusNotice';

interface MemoryPanelProps { workspaceId: string; onClose(): void; onOpenRun(runId: string): void; }

export function MemoryPanel({ workspaceId, onClose, onOpenRun }: MemoryPanelProps) {
  const { request } = useApi();
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [selected, setSelected] = useState<MemoryWithContent | null>(null);
  const [selectedId, setSelectedId] = useState<string>();
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [filter, setFilter] = useState<MemoryFilter>('all');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { const timer = window.setTimeout(() => setDebouncedQuery(query), 300); return () => window.clearTimeout(timer); }, [query]);
  const load = useCallback(async () => { const status = filter === 'archived' ? 'archived' : 'active'; const type = filter === 'all' || filter === 'archived' ? 'all' : filter; const params = memoryQuery(status, type, debouncedQuery); const result = await request<{ memories: MemoryRecord[] }>(`/api/workspaces/${workspaceId}/memories${params ? `?${params}` : ''}`); setMemories(result.memories); }, [debouncedQuery, filter, request, workspaceId]);
  useEffect(() => { void load().catch(loadError => setError(loadError instanceof Error ? loadError.message : String(loadError))); }, [load]);
  const select = async (memory: MemoryRecord) => { setSelectedId(memory.id); try { const result = await request<{ memory: MemoryWithContent }>(`/api/workspaces/${workspaceId}/memories/${memory.id}`); setSelected(result.memory); setError(''); } catch (loadError) { setError(loadError instanceof Error ? loadError.message : String(loadError)); } };
  const save = async (values: MemoryFormValues) => { setSaving(true); setError(''); try { const path = selected ? `/api/workspaces/${workspaceId}/memories/${selected.id}` : `/api/workspaces/${workspaceId}/memories`; const result = await request<{ memory: MemoryWithContent }>(path, { method: selected ? 'PATCH' : 'POST', body: values }); setSelected(result.memory); setSelectedId(result.memory.id); await load(); } catch (saveError) { setError(saveError instanceof Error ? saveError.message : String(saveError)); } finally { setSaving(false); } };
  const archive = async () => { if (!selected || !window.confirm(`确定归档“${selected.title}”吗？`)) return; setSaving(true); try { await request(`/api/workspaces/${workspaceId}/memories/${selected.id}/archive`, { method: 'POST' }); setSelected(null); setSelectedId(undefined); await load(); } catch (archiveError) { setError(archiveError instanceof Error ? archiveError.message : String(archiveError)); } finally { setSaving(false); } };
  return <ModalShell title="项目知识" eyebrow="WORKSPACE KNOWLEDGE" description="管理当前工作区中可被检索和注入的正式记忆。" onClose={onClose} size="lg">
    <div className="space-y-4">
      {error && !selected && <StatusNotice tone="error" title="项目知识加载失败">{error}</StatusNotice>}
      <div className="ui-panel flex min-h-[28rem] flex-col gap-4 rounded-2xl border p-4 md:min-h-[34rem] md:flex-row">
        <MemoryList memories={memories} selectedId={selectedId} filter={filter} onFilterChange={setFilter} query={query} onQueryChange={setQuery} onSelect={memory => { void select(memory); }} onCreate={() => { setSelected(null); setSelectedId(undefined); setError(''); }} />
        <MemoryEditor memory={selected} saving={saving} error={error} onSave={values => { void save(values); }} onArchive={selected ? () => { void archive(); } : undefined} onOpenRun={onOpenRun} />
      </div>
    </div>
  </ModalShell>;
}
