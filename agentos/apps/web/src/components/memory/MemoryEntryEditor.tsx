'use client';

import { useState } from 'react';
import { MEMORY_CATEGORIES, type MemoryCategory } from '@agentos/shared';
import {
  memoryAuthorityLabel,
  memoryCategoryLabel,
  memoryEntryUnitToScore,
  memoryScopeLabel,
  validateMemoryEntryForm,
  type MemoryEntryDto,
  type MemoryEntryFormValues,
} from '@/lib/memoryEntries';
import { MemoryEntryLifecycle } from './MemoryEntryLifecycle';
import type { MemoryEntryLifecyclePayload } from '@/lib/memoryManagement';
import { CompactSelect } from '../chat/CompactSelect';
import { MemoryMarkdownPreview } from './MemoryMarkdownPreview';

interface MemoryEntryEditorProps {
  entry: MemoryEntryDto | null;
  isNew: boolean;
  loading: boolean;
  saving: boolean;
  error: string;
  stale?: boolean;
  notice?: string;
  onSave(values: MemoryEntryFormValues): void;
  onReload?(): void;
  onLifecycle?(payload: MemoryEntryLifecyclePayload): void;
  onOpenRun(runId: string): void;
}

const empty: MemoryEntryFormValues = {
  category: 'knowledge', title: '', summary: '', content: '', tags: [],
  confidence: 100, importance: 50, pinned: false,
};

function fromEntry(entry: MemoryEntryDto): MemoryEntryFormValues {
  return {
    category: entry.category,
    title: entry.title,
    summary: entry.summary,
    content: entry.content,
    tags: [...entry.tags],
    confidence: memoryEntryUnitToScore(entry.confidence),
    importance: memoryEntryUnitToScore(entry.importance),
    pinned: entry.pinned,
  };
}

export function MemoryEntryEditor({ entry, isNew, loading, saving, error, stale, notice, onSave, onReload, onLifecycle, onOpenRun }: MemoryEntryEditorProps) {
  const [values, setValues] = useState<MemoryEntryFormValues>(() => entry ? fromEntry(entry) : empty);
  const [validationError, setValidationError] = useState('');

  const update = <K extends keyof MemoryEntryFormValues>(key: K, value: MemoryEntryFormValues[K]) => {
    setValues(current => ({ ...current, [key]: value }));
    setValidationError('');
  };

  const submit = () => {
    const validation = validateMemoryEntryForm(values);
    if (validation) {
      setValidationError(validation);
      return;
    }
    onSave(values);
  };

  const knownCategory = !entry || MEMORY_CATEGORIES.includes(entry.category);
  const editable = knownCategory && (isNew || entry?.status === 'active' || entry?.status === 'archived');
  const categoryOptions = [
    ...MEMORY_CATEGORIES.map(category => ({ value: category, label: memoryCategoryLabel(category) })),
    ...(entry && !MEMORY_CATEGORIES.includes(entry.category) ? [{ value: entry.category, label: `未识别类别（${entry.category}）` }] : []),
  ];
  const identity = entry ? [
    `范围：${memoryScopeLabel(entry.scope)}`,
    `权威：${memoryAuthorityLabel(entry.authority)}`,
    `版本：${entry.version}`,
    entry.ownerAgentId && `Agent：${entry.ownerAgentId}`,
    entry.ownerConversationId && `会话：${entry.ownerConversationId}`,
    entry.ownerTaskId && `任务：${entry.ownerTaskId}`,
    entry.ownerRunId && `Run：${entry.ownerRunId}`,
  ].filter(Boolean) : [];

  return <section aria-label="正式记忆编辑器" className="min-w-0 flex-1 overflow-y-auto pl-0 pt-4 sm:pl-5 sm:pt-0">
    <div className="mb-5 flex items-center justify-between gap-4">
      <div><div className="text-[11px] tracking-[0.14em] ui-dim">CANONICAL MEMORY ENTRY</div><h3 className="mt-1 text-lg font-semibold ui-text">{isNew ? '新建正式记忆' : entry ? '正式记忆详情' : '选择一条正式记忆'}</h3></div>
    </div>
    <p className="mb-4 text-xs leading-5 ui-dim">保存后的记忆供后续上下文使用；运行时会按范围等条件和上下文预算决定是否选取。</p>
    {loading && <p role="status" className="mb-3 text-xs ui-dim">正在加载所选记忆…</p>}
    {notice && <p role="status" className="mb-3 rounded-lg border ui-border p-3 text-xs ui-accent">{notice}</p>}
    {error && <p role="alert" className="mb-3 rounded-lg border border-[var(--app-danger)]/30 bg-[var(--app-danger)]/10 p-3 text-xs text-[var(--app-danger)]">{error}</p>}
    {stale && onReload && <button type="button" disabled={saving || loading} onClick={onReload} className="mb-3 rounded-lg border ui-border px-3 py-2 text-xs ui-accent disabled:opacity-50">重新加载最新版本</button>}
    {validationError && <p role="alert" className="mb-3 rounded-lg border border-[var(--app-danger)]/30 bg-[var(--app-danger)]/10 p-3 text-xs text-[var(--app-danger)]">{validationError}</p>}
    {!entry && !isNew ? <div className="rounded-xl border border-dashed ui-border p-6 text-sm ui-dim">从左侧选择记忆，或新建一条记忆。</div> : <>
      {entry && <div className="mb-4 flex flex-wrap gap-2 text-[11px] ui-dim">{identity.map((item, index) => <span key={`${entry.id}:${index}`} className="rounded-full border ui-border px-2 py-1">{item}</span>)}</div>}
      {!knownCategory && entry ? <p className="mb-4 rounded-lg border ui-border p-3 text-xs ui-dim">当前版本不支持编辑此类别，内容仅供查看。</p> : !editable && entry ? <p className="mb-4 rounded-lg border ui-border p-3 text-xs ui-dim">此状态的记忆为只读。仅生效中或已归档的记忆可以编辑。</p> : null}
      <fieldset disabled={!editable || saving || loading} className="border-0 p-0 disabled:opacity-75">
        <div className="grid gap-4 md:grid-cols-2">
          <label className="text-xs ui-muted">标题<input value={values.title} onChange={event => update('title', event.target.value)} className="mt-1 w-full rounded-lg border ui-border bg-transparent px-3 py-2 text-sm ui-text" /></label>
          <CompactSelect label="类别" value={values.category} options={categoryOptions} onChange={value => update('category', value as MemoryCategory)} />
        </div>
        <label className="mt-4 block text-xs ui-muted">摘要<textarea aria-label="摘要" value={values.summary} onChange={event => update('summary', event.target.value)} rows={2} className="mt-1 w-full rounded-lg border ui-border bg-transparent px-3 py-2 text-sm ui-text" /></label>
        <label className="mt-4 block text-xs ui-muted">Markdown 正文<textarea aria-label="Markdown 正文" value={values.content} onChange={event => update('content', event.target.value)} rows={10} className="mt-1 w-full rounded-lg border ui-border bg-transparent px-3 py-2 font-mono text-sm ui-text" /></label>
        <section className="mt-4"><h4 className="mb-2 text-xs ui-muted">Markdown 只读预览</h4><MemoryMarkdownPreview content={values.content} /></section>
        <label className="mt-4 block text-xs ui-muted">标签（逗号分隔）<input value={values.tags.join(', ')} onChange={event => update('tags', event.target.value.split(',').map(tag => tag.trim()).filter(Boolean))} className="mt-1 w-full rounded-lg border ui-border bg-transparent px-3 py-2 text-sm ui-text" /></label>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="text-xs ui-muted">重要性（0–100）<input type="number" min={0} max={100} step="any" value={Number.isNaN(values.importance) ? '' : values.importance} onChange={event => update('importance', event.target.value === '' ? Number.NaN : Number(event.target.value))} className="mt-1 w-full rounded-lg border ui-border bg-transparent px-3 py-2 text-sm ui-text" /></label>
          <label className="text-xs ui-muted">置信度（0–100）<input type="number" min={0} max={100} step="any" value={Number.isNaN(values.confidence) ? '' : values.confidence} onChange={event => update('confidence', event.target.value === '' ? Number.NaN : Number(event.target.value))} className="mt-1 w-full rounded-lg border ui-border bg-transparent px-3 py-2 text-sm ui-text" /></label>
        </div>
        {entry && <label className="mt-4 flex items-center gap-2 text-xs ui-muted"><input type="checkbox" checked={values.pinned} onChange={event => update('pinned', event.target.checked)} />置顶</label>}
        <div className="mt-5 flex justify-end"><button type="button" disabled={saving || loading} onClick={submit} className="rounded-lg bg-[var(--app-accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{saving ? '保存中…' : '保存记忆'}</button></div>
      </fieldset>
      {entry && entry.sources.length > 0 && <section className="mt-5 border-t ui-border pt-4"><h4 className="mb-2 text-xs ui-muted">来源记录（只读）</h4><div className="flex flex-wrap gap-2">{entry.sources.map((source, index) => source.kind === 'run'
        ? <button type="button" key={`${source.kind}:${source.id}:${index}`} onClick={() => onOpenRun(source.id)} className="rounded-md border ui-border px-2 py-1 text-[11px] ui-accent hover:border-[var(--app-accent)]">Run {source.id.slice(0, 8)}</button>
        : <span key={`${source.kind}:${source.id}:${index}`} className="rounded-md border ui-border px-2 py-1 text-[11px] ui-accent">{source.kind}: {source.id}</span>)}</div></section>}
      {entry && onLifecycle && <MemoryEntryLifecycle entry={entry} saving={saving || loading} onApply={onLifecycle} />}
    </>}
  </section>;
}
