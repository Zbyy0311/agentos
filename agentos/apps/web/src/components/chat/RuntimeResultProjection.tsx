'use client';

import { useState } from 'react';
import type { RunFileChange } from '@agentos/shared';
import type { RuntimeResultProjection } from '@/lib/runtimeProjection';
import { ArtifactShelf } from '@/components/runs/ArtifactShelf';
import { RunTaskTree } from '@/components/runs/RunTaskTree';

type ResultView = 'steps' | 'files' | 'artifacts' | 'details';

const statusLabels: Record<RuntimeResultProjection['run']['status'], string> = {
  queued: '排队中', running: '执行中', waiting_user: '等待补充', completed: '已完成', failed: '失败', cancelled: '已取消',
};

const statusColors: Record<RuntimeResultProjection['run']['status'], string> = {
  queued: 'var(--app-dim)', running: 'var(--app-accent)', waiting_user: 'var(--app-info)', completed: 'var(--app-success)', failed: 'var(--app-danger)', cancelled: 'var(--app-dim)',
};

const changeLabels: Record<RunFileChange['changeType'], string> = {
  created: '新增', modified: '修改', deleted: '删除', renamed: '重命名',
};

export function RuntimeResultProjection({ projection, apiBase, onOpenDetails }: { projection: RuntimeResultProjection; apiBase: string; onOpenDetails?(): void }) {
  const [view, setView] = useState<ResultView>('steps');
  const visibleArtifacts = projection.artifacts.filter(artifact => artifact.type !== 'log');
  const tabs: Array<{ id: ResultView; label: string; count?: number }> = [
    { id: 'steps', label: '步骤', count: projection.steps.length },
    { id: 'files', label: '文件', count: projection.fileChanges.length },
    { id: 'artifacts', label: '产物', count: visibleArtifacts.length },
    { id: 'details', label: '详情' },
  ];
  const runLabel = statusLabels[projection.run.status];
  const summary = projection.run.failureReason ?? projection.run.resultSummary;

  return <section data-runtime-result={projection.run.id} aria-label="运行结果" className="runtime-result border ui-border bg-[var(--app-surface)] px-3 py-3 sm:px-4">
    <header className="flex min-w-0 items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2 text-xs font-semibold ui-text"><span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: statusColors[projection.run.status] }} />运行结果<span className="font-normal ui-muted">· {runLabel}</span></div>
        {summary && <p className="mt-1 line-clamp-2 text-xs leading-5 ui-text-soft">{summary}</p>}
      </div>
      {onOpenDetails && <button type="button" onClick={onOpenDetails} className="ui-button-ghost shrink-0 rounded-lg border ui-border px-2 py-1 text-[11px]">查看详情</button>}
    </header>
    <div className="mt-3 flex min-w-0 flex-wrap gap-1" role="tablist" aria-label="运行结果视图">
      {tabs.map(tab => <button key={tab.id} type="button" role="tab" aria-selected={view === tab.id} onClick={() => setView(tab.id)} className={`ui-button-ghost rounded-lg px-2.5 py-1.5 text-[11px] ${view === tab.id ? 'ui-selected' : ''}`}>
        {tab.label}{tab.count === undefined ? '' : ` · ${tab.count}`}
      </button>)}
    </div>
    <div className="mt-3 min-w-0" role="tabpanel">
      {view === 'steps' && <RunTaskTree steps={projection.steps} emptyLabel="当前 Run 没有结构化步骤观测。" />}
      {view === 'files' && <FileChanges changes={projection.fileChanges} />}
      {view === 'artifacts' && <ArtifactShelf artifacts={projection.artifacts} apiBase={apiBase} />}
      {view === 'details' && <dl className="grid gap-2 text-xs leading-5 sm:grid-cols-2"><Detail label="Run" value={projection.run.id} /><Detail label="关联消息" value={projection.sourceMessage?.id ?? '未关联'} /><Detail label="执行数" value={String(projection.executions.length)} /><Detail label="事件数" value={String(projection.events.length)} /><Detail label="文件观测" value={projection.fileChanges.length ? '已记录' : '未记录'} /><Detail label="产物数" value={String(visibleArtifacts.length)} /></dl>}
    </div>
  </section>;
}

function FileChanges({ changes }: { changes: readonly RunFileChange[] }) {
  if (changes.length === 0) return <p className="rounded-lg border border-dashed ui-border px-3 py-3 text-xs leading-5 ui-dim">当前 Run 未提供文件观测。</p>;
  return <ul aria-label="文件变化" className="space-y-1.5">{changes.map(change => <li key={`${change.path}:${change.changeType}`} className="flex min-w-0 items-center gap-2 rounded-lg border ui-border px-2.5 py-2 text-xs"><span className="shrink-0 ui-accent">{changeLabels[change.changeType]}</span><code className="min-w-0 truncate ui-text-soft" title={change.path}>{change.path}</code></li>)}</ul>;
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 border-b ui-border pb-1.5"><dt className="ui-dim">{label}</dt><dd className="truncate font-medium ui-text" title={value}>{value}</dd></div>;
}
