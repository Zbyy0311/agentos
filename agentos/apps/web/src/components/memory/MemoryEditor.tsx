'use client';

import { useEffect, useState } from 'react';
import type { MemoryRecord, MemoryType } from '@agentos/shared';
import { memoryTypeLabels, validateMemoryForm, type MemoryFormValues } from '@/lib/memories';
import { MemoryMarkdownPreview } from './MemoryMarkdownPreview';
import { MemorySourceLinks } from './MemorySourceLinks';

export type MemoryWithContent = MemoryRecord & { content: string };

interface MemoryEditorProps {
  memory: MemoryWithContent | null;
  saving: boolean;
  error: string;
  onSave(values: MemoryFormValues): void;
  onArchive?(): void;
  onOpenRun(runId: string): void;
}

const empty: MemoryFormValues = { type: 'overview', title: '', summary: '', content: '', tags: [], relatedFiles: [], importance: 50, confidence: 50 };

export function MemoryEditor({ memory, saving, error, onSave, onArchive, onOpenRun }: MemoryEditorProps) {
  const [values, setValues] = useState<MemoryFormValues>(empty);
  useEffect(() => { setValues(memory ? { type: memory.type, title: memory.title, summary: memory.summary, content: memory.content, tags: memory.tags, relatedFiles: memory.relatedFiles, importance: memory.importance, confidence: memory.confidence } : empty); }, [memory]);
  const update = <K extends keyof MemoryFormValues>(key: K, value: MemoryFormValues[K]) => setValues(current => ({ ...current, [key]: value }));
  const submit = () => { if (!validateMemoryForm(values)) onSave(values); };
  return <div className="min-w-0 flex-1 overflow-y-auto pl-5"><div className="mb-5 flex items-center justify-between"><div><div className="text-[11px] tracking-[0.14em] ui-dim">MEMORY RECORD</div><h3 className="mt-1 text-lg font-semibold ui-text">{memory ? '编辑项目知识' : '新建项目知识'}</h3></div>{memory && onArchive && <button type="button" onClick={onArchive} className="rounded-lg border border-[var(--app-danger)]/40 px-3 py-1.5 text-xs text-[var(--app-danger)]">归档</button>}</div>{error && <div className="mb-4 rounded-lg border border-[var(--app-danger)]/30 bg-[var(--app-danger)]/10 p-3 text-xs text-[var(--app-danger)]">{error}</div>}<div className="grid gap-4 sm:grid-cols-2"><label className="text-xs ui-muted">标题<input value={values.title} onChange={event => update('title', event.target.value)} className="mt-1 w-full rounded-lg border ui-border bg-transparent px-3 py-2 text-sm ui-text" /></label><label className="text-xs ui-muted">类型<select value={values.type} onChange={event => update('type', event.target.value as MemoryType)} className="mt-1 w-full rounded-lg border ui-border bg-transparent px-3 py-2 text-sm ui-text">{(Object.keys(memoryTypeLabels) as MemoryType[]).map(key => <option key={key} value={key}>{memoryTypeLabels[key]}</option>)}</select></label></div><label className="mt-4 block text-xs ui-muted">摘要<textarea value={values.summary} onChange={event => update('summary', event.target.value)} rows={2} className="mt-1 w-full rounded-lg border ui-border bg-transparent px-3 py-2 text-sm ui-text" /></label><label className="mt-4 block text-xs ui-muted">Markdown 正文<textarea value={values.content} onChange={event => update('content', event.target.value)} rows={12} className="mt-1 w-full rounded-lg border ui-border bg-transparent px-3 py-2 font-mono text-sm ui-text" /></label><section className="mt-4"><h4 className="mb-2 text-xs ui-muted">Markdown 只读预览</h4><MemoryMarkdownPreview content={values.content} /></section><div className="grid gap-4 sm:grid-cols-2"><label className="text-xs ui-muted">标签（逗号分隔）<input value={values.tags.join(', ')} onChange={event => update('tags', event.target.value.split(',').map(item => item.trim()).filter(Boolean))} className="mt-1 w-full rounded-lg border ui-border bg-transparent px-3 py-2 text-sm ui-text" /></label><label className="text-xs ui-muted">相关文件（逗号分隔）<input value={values.relatedFiles.join(', ')} onChange={event => update('relatedFiles', event.target.value.split(',').map(item => item.trim()).filter(Boolean))} className="mt-1 w-full rounded-lg border ui-border bg-transparent px-3 py-2 text-sm ui-text" /></label></div><div className="grid gap-4 sm:grid-cols-2"><label className="text-xs ui-muted">重要性<input type="number" min={0} max={100} value={values.importance} onChange={event => update('importance', Number(event.target.value))} className="mt-1 w-full rounded-lg border ui-border bg-transparent px-3 py-2 text-sm ui-text" /></label><label className="text-xs ui-muted">置信度<input type="number" min={0} max={100} value={values.confidence} onChange={event => update('confidence', Number(event.target.value))} className="mt-1 w-full rounded-lg border ui-border bg-transparent px-3 py-2 text-sm ui-text" /></label></div>{memory && <div className="mt-5 border-t ui-border pt-4"><div className="mb-2 text-xs ui-muted">来源 Run</div><MemorySourceLinks sourceRunIds={memory.sourceRunIds} onOpenRun={onOpenRun} /></div>}<div className="mt-6 flex justify-end"><button type="button" disabled={saving} onClick={submit} className="rounded-lg bg-[var(--app-accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{saving ? '保存中…' : '保存记忆'}</button></div></div>;
}
