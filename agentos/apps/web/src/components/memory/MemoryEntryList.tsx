'use client';

import { MEMORY_CATEGORIES, type MemoryCategory } from '@agentos/shared';
import { memoryCategoryLabel, memoryScopeLabel, memoryStatusLabel, type MemoryEntryDto, type MemoryEntryStatusFilter } from '@/lib/memoryEntries';
import { CompactSelect } from '../chat/CompactSelect';

export type MemoryEntryCategoryFilter = MemoryCategory | 'all';

interface MemoryEntryListProps {
  entries: readonly MemoryEntryDto[];
  selectedId?: string;
  status: MemoryEntryStatusFilter;
  category: MemoryEntryCategoryFilter;
  query: string;
  loading: boolean;
  saving: boolean;
  onStatusChange(value: MemoryEntryStatusFilter): void;
  onCategoryChange(value: MemoryEntryCategoryFilter): void;
  onQueryChange(value: string): void;
  onSelect(entry: MemoryEntryDto): void;
  onCreate(): void;
}

const statusOptions = [
  { value: 'active', label: '生效中' },
  { value: 'archived', label: '已归档' },
  { value: 'conflicted', label: '存在冲突' },
  { value: 'expired', label: '已过期' },
  { value: 'superseded', label: '已被替代' },
  { value: 'rejected', label: '已拒绝' },
  { value: 'deleted', label: '已删除' },
  { value: 'all', label: '全部状态' },
];

export function MemoryEntryList({
  entries, selectedId, status, category, query, loading, saving,
  onStatusChange, onCategoryChange, onQueryChange, onSelect, onCreate,
}: MemoryEntryListProps) {
  const categoryOptions = [
    { value: 'all', label: '全部类别' },
    ...MEMORY_CATEGORIES.map(value => ({ value, label: memoryCategoryLabel(value) })),
  ];

  return <aside aria-label="正式记忆列表" className="flex h-80 min-h-0 max-h-[40vh] w-full shrink-0 flex-col border-b ui-border pb-4 pr-0 sm:h-auto sm:max-h-none sm:w-72 sm:border-b-0 sm:border-r sm:pb-0 sm:pr-4">
    <div className="mb-4 flex items-center justify-between gap-2">
      <h3 className="font-medium ui-text">正式记忆</h3>
      <button type="button" disabled={saving} onClick={onCreate} className="ui-button-ghost rounded-lg px-2 py-1 text-xs ui-accent disabled:opacity-50">+ 新建</button>
    </div>
    <input aria-label="搜索正式记忆" value={query} onChange={event => onQueryChange(event.target.value)} placeholder="搜索记忆" className="mb-3 rounded-lg border ui-border bg-transparent px-3 py-2 text-xs outline-none focus:border-[var(--app-accent)]" />
    <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-1">
      <CompactSelect label="状态" value={status} options={statusOptions} disabled={saving} onChange={value => onStatusChange(value as MemoryEntryStatusFilter)} />
      <CompactSelect label="类别" value={category} options={categoryOptions} disabled={saving} onChange={value => onCategoryChange(value as MemoryEntryCategoryFilter)} />
    </div>
    <div aria-live="polite" className="min-h-0 flex-1 space-y-2 overflow-y-auto">
      {loading && <div role="status" className="p-2 text-xs ui-dim">正在加载正式记忆…</div>}
      {entries.map(entry => <button
        type="button" key={entry.id} disabled={saving || loading} onClick={() => onSelect(entry)}
        className={`w-full rounded-xl border p-3 text-left disabled:opacity-60 ${selectedId === entry.id ? 'border-[var(--app-accent)] bg-[var(--app-accent)]/10' : 'ui-border ui-button-ghost'}`}
      >
        <div className="truncate text-sm font-medium ui-text">{entry.title}</div>
        <div className="mt-1 flex flex-wrap gap-x-2 text-[11px] ui-accent"><span>{memoryCategoryLabel(entry.category)}</span><span>{memoryScopeLabel(entry.scope)}</span></div>
        <div className="mt-1 flex flex-wrap gap-1 text-[10px] ui-dim"><span>{memoryStatusLabel(entry.status)}</span>{entry.pinned && <span>· 已置顶</span>}</div>
        <div className="mt-1 line-clamp-2 text-xs leading-5 ui-muted">{entry.summary.trim() || entry.content}</div>
      </button>)}
      {!loading && entries.length === 0 && <div className="rounded-xl border border-dashed ui-border p-4 text-xs leading-5 ui-dim">暂无匹配的正式记忆</div>}
    </div>
  </aside>;
}
