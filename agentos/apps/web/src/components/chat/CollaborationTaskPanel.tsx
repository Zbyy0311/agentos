'use client';

import { useEffect, useMemo, useState } from 'react';
import type { AgentProfile } from '@agentos/shared';
import { useApi } from '@/lib/useApi';
import { collaborationControlBlockReason, collaborationMutationRequest, readPendingCollaborationControl } from '@/lib/collaborationControl';
import { collaborationCandidatePreviewKey, type CollaborationCandidatePreviewIdentity } from '@/lib/collaborationCandidatePreview';
import { resolveRuntimeApproval, type RuntimeApprovalRequest, type RuntimeApprovalDecision } from '@/lib/runtimeApprovals';
import { CollaborationCandidatePreviewPanel } from './CollaborationCandidatePreviewPanel';

type CollaborationStatus = 'awaiting_confirmation' | 'queued' | 'running' | 'reviewing' | 'changes_requested' | 'awaiting_application' | 'applied' | 'failed' | 'blocked' | 'cancelled';
type CollaborationTask = {
  id: string; workspaceId: string; conversationId?: string; title: string; objective: string; scope: string[]; acceptanceCommands: string[];
  plannerAgentId: string; implementerAgentId: string; reviewerAgentId: string; status: CollaborationStatus;
  version: number; baseCommit: string; maxReworkRounds: number; reworkRound: number; failureReason?: string;
  canonicalRunId?: string; currentCandidateId?: string; updatedAt: string;
};
type CollaborationCandidate = { id: string; round: number; diffHash: string; contentHash: string; testStatus: string; testOutput?: string; reviewConclusion?: string; reviewSummary?: string; };
type CollaborationDetails = { task: CollaborationTask; candidates: CollaborationCandidate[]; reviews: Array<{ candidateId: string; conclusion: string; summary: string; }> };

const STATUS_LABELS: Record<CollaborationStatus, string> = {
  awaiting_confirmation: '待用户确认', queued: '已排队', running: '执行中', reviewing: '评审中',
  changes_requested: '待返工', awaiting_application: '评审通过，待应用', applied: '已应用', failed: '执行失败', blocked: '已阻塞', cancelled: '已取消',
};

function defaultAgent(agents: AgentProfile[], role: string, fallback?: AgentProfile): string {
  return agents.find(agent => agent.role === role && agent.enabled)?.id ?? fallback?.id ?? agents.find(agent => agent.enabled)?.id ?? '';
}

export function CollaborationTaskPanel({ workspaceId, groupName, agents, conversationId, startInCreateMode = false, onClose, onCreated }: { workspaceId: string; groupName: string; agents: AgentProfile[]; conversationId?: string; startInCreateMode?: boolean; onClose(): void; onCreated(taskId: string): void }) {
  const { API_BASE, request } = useApi();
  const enabled = useMemo(() => agents.filter(agent => agent.enabled), [agents]);
  const [title, setTitle] = useState(`为“${groupName}”创建协作开发任务`);
  const [objective, setObjective] = useState('');
  const [scope, setScope] = useState('');
  const [commands, setCommands] = useState('');
  const [plannerAgentId, setPlannerAgentId] = useState(() => defaultAgent(enabled, 'codex'));
  const [implementerAgentId, setImplementerAgentId] = useState(() => defaultAgent(enabled, 'kimi', enabled[1]));
  const [reviewerAgentId, setReviewerAgentId] = useState(() => defaultAgent(enabled, 'opencode', enabled[2]));
  const [details, setDetails] = useState<CollaborationDetails | null>(null);
  const [pendingApproval, setPendingApproval] = useState<RuntimeApprovalRequest | null>(null);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [previewTarget, setPreviewTarget] = useState<CollaborationCandidatePreviewIdentity | null>(null);
  const [previewedCandidateKey, setPreviewedCandidateKey] = useState<string | null>(null);

  useEffect(() => {
    if (enabled.length === 0) return;
    if (!enabled.some(agent => agent.id === plannerAgentId)) setPlannerAgentId(defaultAgent(enabled, 'codex'));
    if (!enabled.some(agent => agent.id === implementerAgentId)) setImplementerAgentId(defaultAgent(enabled, 'kimi', enabled[1]));
    if (!enabled.some(agent => agent.id === reviewerAgentId)) setReviewerAgentId(defaultAgent(enabled, 'opencode', enabled[2]));
  }, [enabled, plannerAgentId, implementerAgentId, reviewerAgentId]);

  const load = async (id: string) => {
    const result = await request<CollaborationDetails>(`/api/workspaces/${workspaceId}/collaboration/tasks/${id}`);
    setDetails(result);
    if (result.task.canonicalRunId) {
      const approvals = await request<{ requests: RuntimeApprovalRequest[] }>(`/api/workspaces/${workspaceId}/runtime-approvals`);
      setPendingApproval(approvals.requests.find(item => item.runId === result.task.canonicalRunId && item.status === 'pending') ?? null);
    } else {
      setPendingApproval(null);
    }
  };

  useEffect(() => {
    if (!details || ['awaiting_confirmation', 'applied', 'failed', 'blocked', 'cancelled'].includes(details.task.status)) return undefined;
    const timer = window.setInterval(() => { void load(details.task.id).catch(() => undefined); }, 2000);
    return () => window.clearInterval(timer);
  }, [details?.task.id, details?.task.status]);

  useEffect(() => {
    setPreviewTarget(null);
    setPreviewedCandidateKey(null);
  }, [workspaceId, details?.task.id]);

  const currentCandidate = details?.candidates.find(candidate => candidate.id === details.task.currentCandidateId);
  const currentCandidateKey = details && currentCandidate
    ? collaborationCandidatePreviewKey({ workspaceId, taskId: details.task.id, candidateId: currentCandidate.id,
      baseCommit: details.task.baseCommit, diffHash: currentCandidate.diffHash, contentHash: currentCandidate.contentHash })
    : undefined;
  const currentCandidateWasPreviewed = currentCandidateKey !== undefined && previewedCandidateKey === currentCandidateKey;

  const create = async () => {
    const normalizedTitle = title.trim();
    const normalizedObjective = objective.trim();
    const normalizedScope = scope.split('\n').map(value => value.trim()).filter(Boolean);
    const normalizedCommands = commands.split('\n').map(value => value.trim()).filter(Boolean);
    if (!normalizedTitle || !normalizedObjective || normalizedScope.length === 0 || normalizedCommands.length === 0) {
      setError('请填写任务标题、目标、修改范围和至少一条验收命令');
      return;
    }
    setBusy(true); setError('');
    try {
      const result = await request<{ task: CollaborationTask }>(`/api/workspaces/${workspaceId}/collaboration/tasks`, { method: 'POST', body: {
        conversationId, title: normalizedTitle, objective: normalizedObjective, scope: normalizedScope, acceptanceCommands: normalizedCommands, plannerAgentId, implementerAgentId, reviewerAgentId, maxReworkRounds: 2,
      } });
      onCreated(result.task.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '创建协作任务失败'); }
    finally { setBusy(false); }
  };

  const mutate = async (action: 'confirm' | 'cancel' | 'apply') => {
    if (!details) return;
    if (collaborationControlBlockReason(readPendingCollaborationControl(details.task))) return;
    const candidate = details.candidates.find(item => item.id === details.task.currentCandidateId);
    const candidateIdentity = candidate ? {
      workspaceId, taskId: details.task.id, candidateId: candidate.id, baseCommit: details.task.baseCommit, diffHash: candidate.diffHash, contentHash: candidate.contentHash,
    } : undefined;
    const candidateKey = candidateIdentity ? collaborationCandidatePreviewKey(candidateIdentity) : undefined;
    if (action === 'apply' && (!candidateIdentity || candidateKey !== previewedCandidateKey)) {
      setError('请先加载并检查当前冻结候选的文件差异，再应用该候选');
      return;
    }
    setBusy(true); setError('');
    try {
      const result = await request<{ task: CollaborationTask }>(`/api/workspaces/${workspaceId}/collaboration/tasks/${details.task.id}/${action}`, {
        ...collaborationMutationRequest(details.task.id, details.task.version, action,
          action === 'apply' && candidateIdentity
            ? { id: candidateIdentity.candidateId, baseCommit: candidateIdentity.baseCommit, contentHash: candidateIdentity.contentHash }
            : undefined),
      });
      await load(result.task.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '协作任务操作失败'); }
    finally { setBusy(false); }
  };

  const decideApproval = async (decision: RuntimeApprovalDecision) => {
    if (!pendingApproval || !details) return;
    setApprovalBusy(true); setError('');
    try {
      await resolveRuntimeApproval(API_BASE, workspaceId, pendingApproval.id, {
        expectedVersion: pendingApproval.version,
        decision,
        decidedBy: 'workspace-ui',
      });
      setPendingApproval(null);
      await load(details.task.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '运行时审批操作失败'); }
    finally { setApprovalBusy(false); }
  };

  const select = (label: string, value: string, onChange: (value: string) => void) => <label className="block text-xs ui-muted">{label}<select value={value} onChange={event => onChange(event.target.value)} className="ui-input mt-1 w-full rounded-lg px-2 py-2 text-sm ui-text"><option value="">未选择</option>{enabled.map(agent => <option key={agent.id} value={agent.id}>{agent.name} · {agent.roleTitle}</option>)}</select></label>;

  return <div className="ui-overlay-enter fixed inset-0 z-[105] grid place-items-center bg-[var(--app-overlay)] p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="collaboration-task-title">
    <section className="ui-panel-raised max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-2xl border p-5 shadow-[var(--app-shadow)]">
      <header className="ui-modal-sticky-header mb-5 flex items-start justify-between gap-4"><div><p className="text-xs tracking-[0.16em] ui-accent">COLLABORATION WORKFLOW</p><h2 id="collaboration-task-title" className="mt-2 text-lg font-semibold ui-text">协作开发任务</h2><p className="mt-1 text-xs ui-muted">创建任务后先检查计划；确认后才会创建隔离 Run 和工作树。</p></div><button type="button" className="ui-button-ghost rounded-lg px-2 py-1 text-sm" onClick={onClose}>关闭</button></header>
      {!details ? <>
        <label className="block text-sm ui-text-soft">任务标题<input value={title} onChange={event => setTitle(event.target.value)} className="ui-input mt-2 w-full rounded-xl px-3 py-2 text-sm" /></label>
        <label className="mt-4 block text-sm ui-text-soft">目标<textarea value={objective} onChange={event => setObjective(event.target.value)} className="ui-input mt-2 h-24 w-full resize-y rounded-xl px-3 py-2 text-sm" /></label>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">{select('规划 Agent', plannerAgentId, setPlannerAgentId)}{select('实施 Agent', implementerAgentId, setImplementerAgentId)}{select('评审 Agent', reviewerAgentId, setReviewerAgentId)}</div>
        <label className="mt-4 block text-sm ui-text-soft">修改范围（每行一项）<textarea placeholder="例如：apps/web/src/components/chat/CollaborationTaskProgressCard.tsx" value={scope} onChange={event => setScope(event.target.value)} className="ui-input mt-2 h-20 w-full resize-y rounded-xl px-3 py-2 text-sm" /></label>
        <label className="mt-4 block text-sm ui-text-soft">验收命令（每行一条）<textarea placeholder="例如：pnpm --filter @agentos/web test" value={commands} onChange={event => setCommands(event.target.value)} className="ui-input mt-2 h-20 w-full resize-y rounded-xl px-3 py-2 font-mono text-xs" /></label>
        {error && <div role="alert" className="ui-error mt-4 rounded-xl border px-3 py-2 text-sm">{error}</div>}
        <div className="ui-modal-sticky-footer mt-5 flex items-center justify-end gap-3"><button type="button" className="ui-button-secondary rounded-xl px-4 py-2 text-sm" onClick={onClose}>取消</button><button type="button" disabled={busy || enabled.length < 3} className="ui-button-primary rounded-xl px-4 py-2 text-sm disabled:opacity-50" onClick={() => { void create(); }}>{busy ? '创建中…' : '创建任务'}</button></div>
      </> : <>
        <div className="rounded-xl border ui-border bg-[var(--app-surface-soft)] p-4"><div className="flex items-center justify-between gap-3"><h3 className="font-medium ui-text">{details.task.title}</h3><span className="rounded-full border px-2 py-1 text-xs ui-accent">{pendingApproval ? '待审批' : STATUS_LABELS[details.task.status]}</span></div><p className="mt-3 whitespace-pre-wrap text-sm leading-6 ui-text-soft">{details.task.objective}</p><div className="mt-3 grid gap-2 text-xs ui-muted sm:grid-cols-2"><span>基线：<code>{details.task.baseCommit.slice(0, 10)}</code></span><span>返工：{details.task.reworkRound}/{details.task.maxReworkRounds}</span><span>规划：{agents.find(agent => agent.id === details.task.plannerAgentId)?.name ?? details.task.plannerAgentId}</span><span>实施/评审：{agents.find(agent => agent.id === details.task.implementerAgentId)?.name ?? details.task.implementerAgentId} / {agents.find(agent => agent.id === details.task.reviewerAgentId)?.name ?? details.task.reviewerAgentId}</span></div></div>
        {readPendingCollaborationControl(details.task) && <div role="status" className="mt-3 rounded-xl border border-[var(--app-warning)]/40 bg-[var(--app-warning)]/10 px-3 py-3 text-sm ui-text-soft">{collaborationControlBlockReason(readPendingCollaborationControl(details.task))}</div>}
        {pendingApproval && <div className="mt-3 rounded-xl border border-[var(--app-warning)]/40 bg-[var(--app-surface-raised)] p-4"><div className="text-sm font-medium ui-text">执行已暂停，等待你的审批</div><p className="mt-2 text-xs leading-5 ui-text-soft">{pendingApproval.description}</p><div className="mt-3 flex justify-end gap-2"><button type="button" disabled={approvalBusy} className="ui-button-ghost rounded-lg px-3 py-2 text-xs disabled:opacity-50" onClick={() => { void decideApproval('reject'); }}>拒绝执行</button><button type="button" disabled={approvalBusy} className="ui-button-primary rounded-lg px-3 py-2 text-xs disabled:opacity-50" onClick={() => { void decideApproval('approve_once'); }}>{approvalBusy ? '处理中…' : '批准本次执行'}</button></div></div>}
        {details.task.failureReason && <div className="ui-error mt-3 rounded-xl border px-3 py-2 text-sm">{details.task.failureReason}</div>}
        {details.candidates.map(candidate => {
          const isCurrentCandidate = candidate.id === details.task.currentCandidateId;
          const identity: CollaborationCandidatePreviewIdentity = { workspaceId, taskId: details.task.id,
            candidateId: candidate.id, baseCommit: details.task.baseCommit, diffHash: candidate.diffHash, contentHash: candidate.contentHash };
          const isOpen = previewTarget?.workspaceId === workspaceId && previewTarget.taskId === details.task.id
            && previewTarget.candidateId === candidate.id && previewTarget.diffHash === candidate.diffHash
            && previewTarget.contentHash === candidate.contentHash;
          return <div key={candidate.id} className="mt-3 rounded-xl border ui-border p-3 text-xs"><div className="flex justify-between ui-text-soft"><span>候选版本 · 第 {candidate.round + 1} 轮</span><span>{candidate.testStatus === 'passed' ? '测试通过' : '测试未通过'}</span></div><div className="mt-2 break-all text-[10px] ui-dim">内容 SHA-256 <code>{candidate.contentHash}</code></div>{candidate.reviewSummary && <p className="mt-2 whitespace-pre-wrap ui-muted">{candidate.reviewSummary}</p>}{isCurrentCandidate && <><button type="button" className="ui-button-secondary mt-3 rounded-lg px-3 py-2 text-xs" onClick={() => setPreviewTarget(isOpen ? null : identity)}>{isOpen ? '收起候选预览' : '查看冻结文件与差异'}</button>{isOpen && <CollaborationCandidatePreviewPanel apiBase={API_BASE} identity={identity} onLoaded={setPreviewedCandidateKey} />}</>}</div>;
        })}
        {error && <div role="alert" className="ui-error mt-3 rounded-xl border px-3 py-2 text-sm">{error}</div>}
        <div className="ui-modal-sticky-footer mt-5 flex flex-wrap justify-end gap-3"><button type="button" className="ui-button-secondary rounded-xl px-4 py-2 text-sm" onClick={onClose}>返回对话</button>{details.task.status === 'awaiting_confirmation' && <button type="button" disabled={busy || Boolean(readPendingCollaborationControl(details.task))} className="ui-button-primary rounded-xl px-4 py-2 text-sm disabled:opacity-50" onClick={() => { void mutate('confirm'); }}>{busy ? '确认中…' : '确认并开始实施'}</button>}{details.task.status === 'awaiting_application' && <button type="button" disabled={busy || Boolean(readPendingCollaborationControl(details.task)) || !currentCandidateWasPreviewed} className="ui-button-primary rounded-xl px-4 py-2 text-sm disabled:opacity-50" onClick={() => { void mutate('apply'); }}>{busy ? '应用中…' : currentCandidateWasPreviewed ? '确认应用已预览候选' : '先查看候选差异'}</button>}{['queued', 'running', 'reviewing', 'changes_requested'].includes(details.task.status) && <button type="button" disabled={busy || Boolean(readPendingCollaborationControl(details.task))} className="ui-button-secondary rounded-xl px-4 py-2 text-sm" onClick={() => { void mutate('cancel'); }}>取消任务</button>}</div>
      </>}
    </section>
  </div>;
}
