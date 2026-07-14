'use client';

interface MemorySourceLinksProps {
  sourceRunIds: string[];
  onOpenRun(runId: string): void;
}

export function MemorySourceLinks({ sourceRunIds, onOpenRun }: MemorySourceLinksProps) {
  if (sourceRunIds.length === 0) return <span className="text-xs ui-dim">暂无来源 Run</span>;
  return <div className="flex flex-wrap gap-2">{sourceRunIds.map(runId => <button type="button" key={runId} onClick={() => onOpenRun(runId)} className="rounded-md border ui-border px-2 py-1 text-[11px] ui-accent hover:border-[var(--app-accent)]">Run {runId.slice(0, 8)}</button>)}</div>;
}
