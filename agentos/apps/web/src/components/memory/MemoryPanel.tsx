'use client';

import { useCallback, useEffect, useState } from 'react';
import type { MemoryRecord } from '@agentos/shared';
import { useApi } from '@/lib/useApi';
import { memoryQuery, type MemoryFormValues } from '@/lib/memories';
import { MemoryEditor, type MemoryWithContent } from './MemoryEditor';
import { MemoryList, type MemoryFilter } from './MemoryList';

interface MemoryPanelProps { workspaceId: string; onClose(): void; onOpenRun(runId: string): void; }

export function MemoryPanel({ workspaceId, onClose, onOpenRun }: MemoryPanelProps) {
  const { request } = useApi();
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [selected, setSelected] = useState<MemoryWithContent | null>(null);
  const [selectedId, setSelectedId] = useState<string>();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<MemoryFilter>('all');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => { const status = filter === 'archived' ? 'archived' : 'active'; const type = filter === 'all' || filter === 'archived' ? 'all' : filter; const params = memoryQuery(status, type, query); const result = await request<{ memories: MemoryRecord[] }>(`/api/workspaces/${workspaceId}/memories${params ? `?${params}` : ''}`); setMemories(result.memories); }, [filter, query, request, workspaceId]);
  useEffect(() => { void load().catch(loadError => setError(loadError instanceof Error ? loadError.message : String(loadError))); }, [load]);
  const select = async (memory: MemoryRecord) => { setSelectedId(memory.id); try { const result = await request<{ memory: MemoryWithContent }>(`/api/workspaces/${workspaceId}/memories/${memory.id}`); setSelected(result.memory); setError(''); } catch (loadError) { setError(loadError instanceof Error ? loadError.message : String(loadError)); } };
  const save = async (values: MemoryFormValues) => { setSaving(true); setError(''); try { const path = selected ? `/api/workspaces/${workspaceId}/memories/${selected.id}` : `/api/workspaces/${workspaceId}/memories`; const result = await request<{ memory: MemoryWithContent }>(path, { method: selected ? 'PATCH' : 'POST', body: values }); setSelected(result.memory); setSelectedId(result.memory.id); await load(); } catch (saveError) { setError(saveError instanceof Error ? saveError.message : String(saveError)); } finally { setSaving(false); } };
  const archive = async () => { if (!selected || !window.confirm(`确定归档“${selected.title}”吗？`)) return; setSaving(true); try { await request(`/api/workspaces/${workspaceId}/memories/${selected.id}/archive`, { method: 'POST' }); setSelected(null); setSelectedId(undefined); await load(); } catch (archiveError) { setError(archiveError instanceof Error ? archiveError.message : String(archiveError)); } finally { setSaving(false); } };
  return <div className="fixed inset-0 z-[70] bg-[var(--app-surface)] p-6"><div className="mx-auto flex h-full max-w-6xl flex-col"><div className="mb-5 flex items-center justify-between"><div><div className="text-[11px] tracking-[0.16em] ui-dim">WORKSPACE KNOWLEDGE</div><h2 className="mt-1 text-xl font-semibold ui-text">项目知识</h2></div><button type="button" onClick={onClose} className="ui-button-ghost rounded-lg px-3 py-2 text-sm">返回聊天</button></div><div className="ui-panel flex min-h-0 flex-1 rounded-2xl border p-5">{error && !selected && <div className="absolute top-20 left-1/2 rounded-lg border border-[var(--app-danger)]/30 p-3 text-xs text-[var(--app-danger)]">{error}</div>}<MemoryList memories={memories} selectedId={selectedId} filter={filter} onFilterChange={setFilter} query={query} onQueryChange={setQuery} onSelect={memory => { void select(memory); }} onCreate={() => { setSelected(null); setSelectedId(undefined); setError(''); }} /><MemoryEditor memory={selected} saving={saving} error={error} onSave={values => { void save(values); }} onArchive={selected ? () => { void archive(); } : undefined} onOpenRun={onOpenRun} /></div></div></div>;
}
