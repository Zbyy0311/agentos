import type { ApprovalGrant } from '@agentos/shared';

export function ApprovalGrantPanel({ grants, onRevoke }: { grants: ApprovalGrant[]; onRevoke?(grantId: string): void }) {
  return <section className="space-y-2"><h3 className="font-medium ui-text">授权范围</h3>{grants.length === 0 ? <p className="text-xs ui-dim">暂无长期授权</p> : grants.map(grant => <div key={grant.id} className="flex items-center justify-between rounded-lg border ui-border px-3 py-2 text-xs"><span className="ui-text-soft">{grant.toolPattern} · {grant.maximumRisk}</span>{!grant.revokedAt && onRevoke && <button type="button" onClick={() => onRevoke(grant.id)} className="ui-button-ghost rounded px-2 py-1">撤销</button>}</div>)}</section>;
}
