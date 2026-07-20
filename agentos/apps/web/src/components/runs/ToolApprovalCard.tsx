import type { ToolApprovalRequest, ApprovalDecision } from '@agentos/shared';

export function ToolApprovalCard({ request, onResolve, disabled = false }: { request: ToolApprovalRequest; onResolve(decision: ApprovalDecision): void; disabled?: boolean }) {
  return <section className="rounded-xl border border-[var(--app-warning)]/50 bg-[var(--app-warning)]/10 p-3 text-sm">
    <div className="font-medium ui-text">工具需要授权：{request.toolName}</div>
    <div className="mt-1 text-xs ui-muted">风险：{request.riskLevel}{request.commandSummary ? ` · ${request.commandSummary}` : ''}</div>
    {request.affectedPaths.length > 0 && <div className="mt-2 text-xs ui-text-soft">{request.affectedPaths.join('、')}</div>}
    <div className="mt-3 flex flex-wrap gap-2">{(['allow_once', 'allow_run', 'deny'] as ApprovalDecision[]).map(decision => <button key={decision} type="button" disabled={disabled} onClick={() => onResolve(decision)} className="ui-button-ghost rounded-lg border px-2.5 py-1.5 text-xs disabled:opacity-50">{decision === 'allow_once' ? '允许一次' : decision === 'allow_run' ? '允许本次运行' : '拒绝'}</button>)}</div>
  </section>;
}
