'use client';

import type { RunStep } from '@agentos/shared';
import { toRunTaskTree } from '@/lib/runSteps';

const statusLabel: Record<RunStep['status'], string> = {
  pending: '等待中', running: '执行中', waiting: '等待输入', completed: '已完成', failed: '失败', cancelled: '已取消', skipped: '已跳过',
};

const statusClass: Record<RunStep['status'], string> = {
  pending: 'ui-dim', running: 'text-[var(--app-accent)]', waiting: 'text-[var(--app-info)]', completed: 'text-[var(--app-success)]', failed: 'text-[var(--app-danger)]', cancelled: 'ui-dim', skipped: 'ui-dim',
};

export function RunTaskTree({ steps, emptyLabel = '任务步骤将在执行后显示。' }: { steps: readonly RunStep[]; emptyLabel?: string }) {
  const items = toRunTaskTree(steps);
  return <section aria-label="任务进度" className="run-task-tree mt-5 border-t ui-border pt-5">
    <div className="mb-3 flex items-center justify-between"><h3 className="signal-section-label">任务进度</h3><span className="text-[11px] ui-dim">{items.length} 步</span></div>
    {items.length === 0 ? <div className="rounded-xl border border-dashed ui-border p-3 text-[11px] leading-5 ui-dim">{emptyLabel}</div> : <ol className="space-y-2">
      {items.map(item => <li key={item.id} className="flex items-start gap-2 rounded-xl border ui-border px-2.5 py-2">
        <span aria-hidden="true" className={`mt-0.5 text-xs ${statusClass[item.status]}`}>{item.status === 'completed' ? '✓' : item.status === 'failed' ? '!' : item.status === 'running' ? '●' : '○'}</span>
        <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><span className="truncate text-xs font-medium ui-text">{item.title}</span><span className={`ml-auto shrink-0 text-[10px] ${statusClass[item.status]}`}>{statusLabel[item.status]}</span></div>
          <div className="mt-1 flex gap-2 text-[10px] ui-dim"><span>{item.stableStepKey}</span>{item.attempt > 1 && <span>第 {item.attempt} 次</span>}{item.durationMs !== undefined && <span>{formatDuration(item.durationMs)}</span>}</div>
        </div>
      </li>)}
    </ol>}
  </section>;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${(durationMs / 1000).toFixed(1)}s`;
  return `${Math.round(durationMs / 1000)}s`;
}
