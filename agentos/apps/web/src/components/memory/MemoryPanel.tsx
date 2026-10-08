'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi } from '@/lib/useApi';
import type { MemoryWorkspaceKnowledgePromotionResponseV1 } from '@agentos/shared';
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
import {
  isMemoryVersionConflict,
  memoryEntryLifecyclePath,
  memoryEntryWorkspacePromotionPath,
  memoryEntryWorkspacePromotionPayload,
  memoryVersionConflictGuidance,
  workspaceResponseIsCurrent,
  type MemoryEntryLifecyclePayload,
} from '@/lib/memoryManagement';
import { uiLayerClass } from '@/lib/uiLayers';
import { LegacyMemoryBrowser } from './LegacyMemoryBrowser';
import { MemoryContextHistory } from './MemoryContextHistory';
import { MemoryConflictManagement } from './MemoryConflictManagement';
import { MemoryEntryEditor } from './MemoryEntryEditor';
import { MemoryEntryList, type MemoryEntryCategoryFilter } from './MemoryEntryList';
import { MemoryFeedbackActions } from './MemoryFeedbackActions';
import { MemoryMaintenance } from './MemoryMaintenance';
import { MemoryPreferenceManagement } from './MemoryPreferenceManagement';
import { MemoryReviewQueue } from './MemoryReviewQueue';

interface MemoryPanelProps {
  workspaceId: string;
  onClose(): void;
  onOpenRun(runId: string): void;
}

type PanelTab = 'entries' | 'review' | 'conflicts' | 'preferences' | 'feedback' | 'maintenance' | 'legacy' | 'history';

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
  const [staleEntry, setStaleEntry] = useState(false);
  const listGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const selectedIdRef = useRef<string | undefined>();
  const savingRef = useRef(false);
  const currentWorkspaceId = useRef(workspaceId);
  currentWorkspaceId.current = workspaceId;

  const loadEntries = useCallback(async () => {
    const generation = ++listGeneration.current;
    const filters = memoryEntryListQuery(status, category, query);
    setListLoading(true);
    setError('');
    try {
      const result = await request<{ entries: MemoryEntryDto[] }>(memoryEntriesPath(workspaceId, filters));
      if (workspaceResponseIsCurrent(workspaceId, currentWorkspaceId.current, generation, listGeneration.current)) setEntries(result.entries);
    } catch (loadError) {
      if (workspaceResponseIsCurrent(workspaceId, currentWorkspaceId.current, generation, listGeneration.current)) setError(asMessage(loadError));
    } finally {
      if (workspaceResponseIsCurrent(workspaceId, currentWorkspaceId.current, generation, listGeneration.current)) setListLoading(false);
    }
  }, [category, query, request, status, workspaceId]);

  useEffect(() => {
    void loadEntries();
    return () => { listGeneration.current += 1; };
  }, [loadEntries]);

  useEffect(() => () => { detailGeneration.current += 1; }, [workspaceId]);

  const selectEntry = async (entry: Pick<MemoryEntryDto, 'id'>) => {
    if (savingRef.current || listLoading) return;
    const generation = ++detailGeneration.current;
    selectedIdRef.current = entry.id;
    setSelectedId(entry.id);
    setSelected(null);
    setIsNew(false);
    setDetailLoading(true);
    setError('');
    setNotice('');
    setStaleEntry(false);
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
    setStaleEntry(false);
  };

  const saveEntry = async (values: MemoryEntryFormValues) => {
    if (savingRef.current || detailLoading) return;
    const target = selected;
    if (!isNew && !target) return;
    savingRef.current = true;
    setSaving(true);
    setError('');
    setNotice('');
    setStaleEntry(false);
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
      setError([asMessage(saveError), memoryVersionConflictGuidance(saveError)].filter(Boolean).join(' '));
      setStaleEntry(isMemoryVersionConflict(saveError));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const applyLifecycle = async (payload: MemoryEntryLifecyclePayload) => {
    const target = selected;
    if (!target || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError('');
    setNotice('');
    setStaleEntry(false);
    try {
      const response = await request<{ entry: MemoryEntryDto }>(memoryEntryLifecyclePath(workspaceId, target.id), {
        method: 'POST',
        body: payload,
      });
      setSelected(response.entry);
      setSelectedId(response.entry.id);
      const label = payload.action === 'archive' ? '已归档' : payload.action === 'restore' ? '已恢复' : payload.action === 'delete' ? '已软删除' : payload.action === 'revalidate' ? '已重新验证' : '有效期已更新';
      setNotice(`正式记忆${label}。`);
      if (payload.action === 'archive') setStatus('archived');
      if (payload.action === 'delete') setStatus('deleted');
      if (payload.action === 'restore' || payload.action === 'revalidate') setStatus('active');
      await loadEntries();
    } catch (lifecycleError) {
      setError([asMessage(lifecycleError), memoryVersionConflictGuidance(lifecycleError)].filter(Boolean).join(' '));
      setStaleEntry(isMemoryVersionConflict(lifecycleError));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const promoteToWorkspaceKnowledge = async () => {
    const target = selected;
    if (!target || savingRef.current || detailLoading) return;
    savingRef.current = true;
    setSaving(true);
    setError('');
    setNotice('');
    setStaleEntry(false);
    try {
      const response = await request<MemoryWorkspaceKnowledgePromotionResponseV1<MemoryEntryDto>>(
        memoryEntryWorkspacePromotionPath(workspaceId, target.id),
        { method: 'POST', body: memoryEntryWorkspacePromotionPayload(target) },
      );
      selectedIdRef.current = response.entry.id;
      setSelectedId(response.entry.id);
      setSelected(response.entry);
      setIsNew(false);
      setStatus('active');
      setNotice(response.outcome === 'created'
        ? '已创建工作区知识；原任务、Run 或会话记忆仍保留。'
        : '工作区知识已存在；原任务、Run 或会话记忆仍保留。');
      await loadEntries();
    } catch (promotionError) {
      setError([asMessage(promotionError), memoryVersionConflictGuidance(promotionError)].filter(Boolean).join(' '));
      setStaleEntry(isMemoryVersionConflict(promotionError));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const reloadSelected = () => {
    if (!selected || savingRef.current) return;
    void selectEntry(selected);
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
            <button type="button" role="tab" aria-selected={tab === 'review'} onClick={() => setTab('review')} className={`rounded-md px-3 py-1.5 text-xs ${tab === 'review' ? 'bg-[var(--app-accent)]/10 ui-accent' : 'ui-muted'}`}>候选审查</button>
            <button type="button" role="tab" aria-selected={tab === 'conflicts'} onClick={() => setTab('conflicts')} className={`rounded-md px-3 py-1.5 text-xs ${tab === 'conflicts' ? 'bg-[var(--app-accent)]/10 ui-accent' : 'ui-muted'}`}>冲突管理</button>
            <button type="button" role="tab" aria-selected={tab === 'preferences'} onClick={() => setTab('preferences')} className={`rounded-md px-3 py-1.5 text-xs ${tab === 'preferences' ? 'bg-[var(--app-accent)]/10 ui-accent' : 'ui-muted'}`}>偏好建议</button>
            <button type="button" role="tab" aria-selected={tab === 'feedback'} onClick={() => setTab('feedback')} className={`rounded-md px-3 py-1.5 text-xs ${tab === 'feedback' ? 'bg-[var(--app-accent)]/10 ui-accent' : 'ui-muted'}`}>反馈与自动策略</button>
            <button type="button" role="tab" aria-selected={tab === 'maintenance'} onClick={() => setTab('maintenance')} className={`rounded-md px-3 py-1.5 text-xs ${tab === 'maintenance' ? 'bg-[var(--app-accent)]/10 ui-accent' : 'ui-muted'}`}>维护建议</button>
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
            entry={selected} isNew={isNew} loading={detailLoading} saving={saving} error={error} stale={staleEntry} notice={notice}
            onSave={values => { void saveEntry(values); }} onReload={reloadSelected} onLifecycle={payload => { void applyLifecycle(payload); }} onOpenRun={onOpenRun}
            onPromoteToWorkspaceKnowledge={() => { void promoteToWorkspaceKnowledge(); }}
          />
        </> : tab === 'maintenance'
          ? <MemoryMaintenance key={workspaceId} workspaceId={workspaceId} onOpenEntry={id => { setTab('entries'); void selectEntry({ id }); }} />
          : tab === 'legacy'
          ? <LegacyMemoryBrowser key={workspaceId} workspaceId={workspaceId} onOpenRun={onOpenRun} />
          : tab === 'history'
            ? <MemoryContextHistory key={workspaceId} workspaceId={workspaceId} />
          : tab === 'conflicts'
            ? <MemoryConflictManagement key={workspaceId} workspaceId={workspaceId} />
            : tab === 'review'
              ? <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs ui-dim">
                  <span>在此处理待审候选；冲突条目已单独列在冲突管理中。</span>
                  <button type="button" onClick={() => setTab('conflicts')} className="ui-button-ghost rounded-lg border ui-border px-3 py-2 ui-accent">管理冲突</button>
                </div>
                <MemoryReviewQueue key={workspaceId} workspaceId={workspaceId} embedded />
              </div>
              : tab === 'feedback'
                ? <MemoryFeedbackActions key={workspaceId} workspaceId={workspaceId} />
          : <MemoryPreferenceManagement key={workspaceId} workspaceId={workspaceId} onOpenRun={onOpenRun} />}
      </div>
    </div>
  </div>;
}
