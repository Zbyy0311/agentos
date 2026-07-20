'use client';

import type { MemoryRecord, MemoryType } from '@agentos/shared';
import { memoryTypeLabels, memoryPreview } from '@/lib/memories';

export type MemoryFilter = 'all' | 'archived' | MemoryType;

interface MemoryListProps {
  memories: MemoryRecord[];
  selectedId?: string;
  filter: MemoryFilter;
  onFilterChange(filter: MemoryFilter): void;
  query: string;
  onQueryChange(query: string): void;
  onSelect(memory: MemoryRecord): void;
  onCreate(): void;
}

export function MemoryList({ memories, selectedId, filter, onFilterChange, query, onQueryChange, onSelect, onCreate }: MemoryListProps) {
  return <div className="flex min-h-0 w-72 shrink-0 flex-col border-r ui-border pr-4"><div className="mb-4 flex items-center justify-between"><h3 className="font-medium ui-text">项目知识</h3><button type="button" onClick={onCreate} className="ui-button-ghost rounded-lg px-2 py-1 text-xs ui-accent">+ 新建</button></div><input value={query} onChange={event => onQueryChange(event.target.value)} placeholder="搜索记忆" className="mb-3 rounded-lg border ui-border bg-transparent px-3 py-2 text-xs outline-none focus:border-[var(--app-accent)]" /><select value={filter} onChange={event => onFilterChange(event.target.value as MemoryFilter)} className="mb-4 rounded-lg border ui-border bg-transparent px-3 py-2 text-xs ui-text"><option value="all">全部类型</option>{(Object.keys(memoryTypeLabels) as MemoryType[]).map(key => <option key={key} value={key}>{memoryTypeLabels[key]}</option>)}<option value="archived">已归档</option></select><div className="min-h-0 flex-1 space-y-2 overflow-y-auto">{memories.map(memory => <button type="button" key={memory.id} onClick={() => onSelect(memory)} className={`w-full rounded-xl border p-3 text-left ${selectedId === memory.id ? 'border-[var(--app-accent)] bg-[var(--app-accent)]/10' : 'ui-border ui-button-ghost'}`}><div className="truncate text-sm font-medium ui-text">{memory.title}</div><div className="mt-1 text-[11px] ui-accent">{memoryTypeLabels[memory.type]}</div><div className="mt-1 line-clamp-2 text-xs leading-5 ui-muted">{memoryPreview(memory)}</div></button>)}{memories.length === 0 && <div className="rounded-xl border border-dashed ui-border p-4 text-xs leading-5 ui-dim">暂无匹配记忆</div>}</div></div>;
}
