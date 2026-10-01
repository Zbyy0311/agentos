'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi } from '@/lib/useApi';
import {
  memoryEntriesPath,
  memoryEntryCreatePayload,
  memoryEntryListQuery,
  memoryEntryPath,
  memoryEntryUpdatePayload,
  type MemoryEntryDto,
  type MemoryEntryFormValues,
  type MemoryEntryStatusFilter,
} from '@/lib/memoryEntries';
import { uiLayerClass } from '@/lib/uiLayers';
import { LegacyMemoryBrowser } from './LegacyMemoryBrowser';
import { MemoryContextHistory } from './MemoryContextHistory';
import { MemoryEntryEditor } from './MemoryEntryEditor';
import { MemoryEntryList, type MemoryEntryCategoryFilter } from './MemoryEntryList';

interface MemoryPanelProps {
  workspaceId: string;
  onClose(): void;
  onOpenRun(runId: string): void;
}

type PanelTab = 'entries' | 'legacy' | 'history';

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function MemoryPanel(props: MemoryPanelProps) {
  return <MemoryPanelWorkspace key={props.workspaceId} {...props} />;
}

function MemoryPanelWorkspace({ workspaceId, onClose, onOpenRun }: MemoryPanelProps) {
  const { request } = useApi();
  const [tab, setTab] = useState<PanelTab>('entries');
  const [entries, setEntries] = useState<MemoryEntryDto[]>([]);
  const [selected, setSelected] = useState<MemoryEntryDto | null>(null);
  const [selectedId, setSelectedId] = useState<string>();
  const [isNew, setIsNew] = useState(false);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<MemoryEntryStatusFilter>('active');
  const [category, setCategory] = useState<MemoryEntryCategoryFilter>('all');
  const [listLoading, setListLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const listGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const selectedIdRef = useRef<string | undefined>();
  const savingRef = useRef(false);

  const loadEntries = useCallback(async () => {
    const generation = ++listGeneration.current;
    const filters = memoryEntryListQuery(status, category, query);
    setListLoading(true);
    setError('');
    try {
      const result = await request<{ entries: MemoryEntryDto[] }>(memoryEntriesPath(workspaceId, filters));
      if (generation === listGeneration.current) setEntries(result.entries);
    } catch (loadError) {
      if (generation === listGeneration.current) setError(asMessage(loadError));
    } finally {
      if (generation === listGeneration.current) setListLoading(false);
    }
  }, [category, query, request, status, workspaceId]);

  useEffect(() => {
    void loadEntries();
    return () => { listGeneration.current += 1; };
  }, [loadEntries]);

  useEffect(() => () => { detailGeneration.current += 1; }, [workspaceId]);

  const selectEntry = async (entry: MemoryEntryDto) => {
    if (savingRef.current || listLoading) return;
    const generation = ++detailGeneration.current;
    selectedIdRef.current = entry.id;
    setSelectedId(entry.id);
    setSelected(null);
    setIsNew(false);
    setDetailLoading(true);
    setError('');
    setNotice('');
    try {
      const result = await request<{ entry: MemoryEntryDto }>(memoryEntryPath(workspaceId, entry.id));
      if (generation !== detailGeneration.current || selectedIdRef.current !== entry.id) return;
      setSelected(result.entry);
    } catch (loadError) {
      if (generation === detailGeneration.current) setError(asMessage(loadError));
    } finally {
      if (generation === detailGeneration.current) setDetailLoading(false);
    }
  };

  const createEntry = () => {
    if (savingRef.current) return;
    detailGeneration.current += 1;
    selectedIdRef.current = undefined;
    setSelectedId(undefined);
    setSelected(null);
    setIsNew(true);
    setDetailLoading(false);
    setError('');
    setNotice('');
  };

  const saveEntry = async (values: MemoryEntryFormValues) => {
    if (savingRef.current || detailLoading) return;
    const target = selected;
    if (!isNew && !target) return;
    savingRef.current = true;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const response = target
        ? await request<{ entry: MemoryEntryDto }>(memoryEntryPath(workspaceId, target.id), {
          method: 'PATCH',
          body: memoryEntryUpdatePayload(target, values),
        })
        : await request<{ entry: MemoryEntryDto; converged: boolean }>(memoryEntriesPath(workspaceId), {
          method: 'POST',
          body: memoryEntryCreatePayload(values),
        });
      const savedEntry = response.entry;
      selectedIdRef.current = savedEntry.id;
      setSelectedId(savedEntry.id);
      setSelected(savedEntry);
      setIsNew(false);
      setNotice(target ? '正式记忆已保存。保存只影响后续上下文；实际选取仍由范围匹配和上下文预算决定。' : '正式记忆已保存。它可供后续上下文使用；实际选取仍由范围匹配和上下文预算决定。');
      if (!target) {
        setStatus('active');
        setCategory('all');
        setQuery('');
      }
      await loadEntries();
    } catch (saveError) {
      setError(asMessage(saveError));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const archiveEntry = async () => {
    const target = selected;
    if (!target || target.status !== 'active' || savingRef.current) return;
    if (!window.confirm(`确定归档“${target.title}”吗？`)) return;
    savingRef.current = true;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await request<{ entry: MemoryEntryDto }>(`${memoryEntryPath(workspaceId, target.id)}/archive`, {
        method: 'POST',
        body: { expectedVersion: target.version },
      });
      selectedIdRef.current = undefined;
      setSelectedId(undefined);
      setSelected(null);
      setIsNew(false);
      setNotice('正式记忆已归档。');
      if (status === 'active') setStatus('archived');
      await loadEntries();
    } catch (archiveError) {
      setError(asMessage(archiveError));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const startCreate = () => {
    createEntry();
    setStatus('active');
    setCategory('all');
    setQuery('');
  };

  return <div className={`fixed inset-0 ${uiLayerClass('workspaceSurface')} bg-[var(--app-surface)] p-6`}>
    <div className="mx-auto flex h-full max-w-6xl flex-col">
      <div className="mb-5 flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center sm:gap-4">
        <div><div className="text-[11px] tracking-[0.16em] ui-dim">WORKSPACE KNOWLEDGE</div><h2 className="mt-1 text-xl font-semibold ui-text">项目知识</h2></div>
        <div className="flex flex-wrap items-center justify-end gap-2 self-end sm:self-auto">
          <div role="tablist" aria-label="项目知识来源" className="flex flex-wrap rounded-lg border ui-border p-1">
            <button type="button" role="tab" aria-selected={tab === 'entries'} onClick={() => setTab('entries')} className={`rounded-md px-3 py-1.5 text-xs ${tab === 'entries' ? 'bg-[var(--app-accent)]/10 ui-accent' : 'ui-muted'}`}>正式记忆</button>
            <button type="button" role="tab" aria-selected={tab === 'legacy'} onClick={() => setTab('legacy')} className={`rounded-md px-3 py-1.5 text-xs ${tab === 'legacy' ? 'bg-[var(--app-accent)]/10 ui-accent' : 'ui-muted'}`}>旧版记录</button>
            <button type="button" role="tab" aria-selected={tab === 'history'} onClick={() => setTab('history')} className={`rounded-md px-3 py-1.5 text-xs ${tab === 'history' ? 'bg-[var(--app-accent)]/10 ui-accent' : 'ui-muted'}`}>使用记录</button>
          </div>
          <button type="button" onClick={onClose} className="ui-button-ghost rounded-lg px-3 py-2 text-sm">返回聊天</button>
        </div>
      </div>
      <div className="ui-panel flex min-h-0 flex-1 flex-col rounded-2xl border p-4 sm:flex-row sm:p-5">
        {tab === 'entries' ? <>
          <MemoryEntryList
            entries={entries} selectedId={selectedId} status={status} category={category} query={query}
            loading={listLoading} saving={saving}
            onStatusChange={setStatus} onCategoryChange={setCategory} onQueryChange={setQuery}
            onSelect={entry => { void selectEntry(entry); }} onCreate={startCreate}
          />
          <MemoryEntryEditor
            key={isNew ? 'new-entry' : selected ? `${selected.id}:${selected.version}` : 'empty-entry'}
            entry={selected} isNew={isNew} loading={detailLoading} saving={saving} error={error} notice={notice}
            onSave={values => { void saveEntry(values); }} onArchive={selected?.status === 'active' ? () => { void archiveEntry(); } : undefined} onOpenRun={onOpenRun}
          />
        </> : tab === 'legacy'
          ? <LegacyMemoryBrowser key={workspaceId} workspaceId={workspaceId} onOpenRun={onOpenRun} />
          : <MemoryContextHistory key={workspaceId} workspaceId={workspaceId} />}
      </div>
    </div>
  </div>;
}
