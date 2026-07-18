'use client';

import { useMemo, useState } from 'react';
import type { AgentRunDetails } from '@agentos/shared';
import { buildExecutionArchive, filterExecutionArchive, type ArchiveItemKind } from '@/lib/executionArchive';

const kinds: ArchiveItemKind[] = ['step', 'status', 'tool', 'output', 'artifact', 'terminal'];

export function ExecutionArchive({ details }: { details: AgentRunDetails }) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<ArchiveItemKind | 'all'>('all');
  const [failuresOnly, setFailuresOnly] = useState(false);
  const [fileChangesOnly, setFileChangesOnly] = useState(false);
  const archive = useMemo(() => buildExecutionArchive(details), [details]);
  const filtered = useMemo(() => filterExecutionArchive(archive, { kinds: kind === 'all' ? [] : [kind], failuresOnly, fileChangesOnly, query }), [archive, fileChangesOnly, failuresOnly, kind, query]);
  return <section aria-label="Execution archive" className="space-y-3">
    <div className="flex flex-wrap items-center gap-2">
      <input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索执行档案" className="min-w-40 flex-1 rounded-lg border ui-border bg-transparent px-2.5 py-1.5 text-xs ui-text outline-none" />
      <select value={kind} onChange={event => setKind(event.target.value as ArchiveItemKind | 'all')} className="rounded-lg border ui-border bg-transparent px-2.5 py-1.5 text-xs ui-text"><option value="all">全部类型</option>{kinds.map(value => <option key={value} value={value}>{value}</option>)}</select>
      <label className="flex items-center gap-1 text-xs ui-text-soft"><input type="checkbox" checked={failuresOnly} onChange={event => setFailuresOnly(event.target.checked)} />失败</label>
      <label className="flex items-center gap-1 text-xs ui-text-soft"><input type="checkbox" checked={fileChangesOnly} onChange={event => setFileChangesOnly(event.target.checked)} />文件</label>
    </div>
    {filtered.length === 0 ? <p className="ui-dim">没有匹配的执行记录。</p> : <ol className="space-y-2">{filtered.map(item => <li key={item.id} className={`rounded-xl border px-3 py-2 text-xs ${item.failed ? 'border-[var(--app-danger)]/50' : 'ui-border'}`}><div className="flex items-center gap-2"><span className="font-mono ui-dim">#{item.sequence}</span><span className="font-medium ui-text">{item.title}</span><span className="ml-auto uppercase tracking-[0.12em] ui-dim">{item.kind}</span></div>{item.detail && <p className="mt-1 whitespace-pre-wrap break-words ui-text-soft">{item.detail}</p>}</li>)}</ol>}
  </section>;
}

