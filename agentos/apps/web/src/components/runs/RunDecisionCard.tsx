import type { PendingRunDecision, PartialWriteDecision } from '@agentos/shared';

interface RunDecisionCardProps {
  decision: PendingRunDecision;
  disabled?: boolean;
  onResolve(decision: PartialWriteDecision): void;
}

export function RunDecisionCard({ decision, disabled = false, onResolve }: RunDecisionCardProps) {
  if (decision.resolvedDecision) return null;
  return <div className="rounded-xl border border-[var(--app-warning)]/50 bg-[var(--app-warning)]/10 p-3 text-sm"><div className="font-medium ui-text">写入失败，需要你的决定</div><p className="mt-1 text-xs ui-muted">检测到文件变化：{decision.fileChanges.map(change => change.path).join('、')}</p><div className="mt-3 flex flex-wrap gap-2"><button type="button" disabled={disabled} onClick={() => onResolve('keep_and_continue')} className="ui-button-secondary rounded-lg px-2.5 py-1.5 text-xs">保留并继续</button><button type="button" disabled={disabled} onClick={() => onResolve('retry_current')} className="ui-button-secondary rounded-lg px-2.5 py-1.5 text-xs">重试当前步骤</button><button type="button" disabled={disabled} onClick={() => onResolve('abort')} className="rounded-lg border border-[var(--app-danger)]/50 px-2.5 py-1.5 text-xs text-[var(--app-danger)]">终止 Run</button></div></div>;
}
