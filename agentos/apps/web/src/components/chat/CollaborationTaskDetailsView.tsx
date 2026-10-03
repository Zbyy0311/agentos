'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentProfile, CollaborationProgress, CollaborationProgressStage, CollaborationStatus } from '@agentos/shared';
import { useApi } from '@/lib/useApi';
import { listRuntimeApprovals, resolveRuntimeApproval, type RuntimeApprovalDecision, type RuntimeApprovalRequest } from '@/lib/runtimeApprovals';
import type { CollaborationProgressState } from '@/lib/useCollaborationProgress';
import { collaborationControlBlockReason, collaborationMutationRequest, readPendingCollaborationControl } from '@/lib/collaborationControl';
import { collaborationCandidatePreviewKey, type CollaborationCandidatePreviewIdentity } from '@/lib/collaborationCandidatePreview';
import { CollaborationRecoveryPanel } from './CollaborationRecoveryPanel';
import { CollaborationCandidatePreviewPanel } from './CollaborationCandidatePreviewPanel';

const STATUS_LABELS: Record<CollaborationStatus, string> = {
  awaiting_confirmation: '待用户确认', queued: '已排队', running: '执行中', reviewing: '评审中',
  changes_requested: '待返工', awaiting_application: '评审通过 · 待应用', applied: '已应用',
  failed: '执行失败', blocked: '已阻塞', cancelled: '已取消',
};

const STAGE_LABELS: Record<string, string> = { plan: '规划', implement: '实施', review: '评审', security: '安全检查' };

function stageLabel(stage: CollaborationProgressStage): string {
  return STAGE_LABELS[stage.stageKey] ?? stage.label ?? stage.stageKey;
}

function stageStatusLabel(status: CollaborationProgressStage['status']): string {
  return ({ pending: '未开始', ready: '待执行', starting: '启动中', running: '执行中', waiting_approval: '待审批', paused: '已暂停', completed: '已完成', failed: '失败', cancelled: '已取消', skipped: '已跳过', unknown: '未知' } as Record<CollaborationProgressStage['status'], string>)[status];
}

function testStatusLabel(status: string): string {
  return ({ not_run: '未执行', running: '执行中', passed: '测试通过', failed: '测试失败', evidence_missing: '缺少测试证据', unknown: '状态未知' } as Record<string, string>)[status] ?? status;
}

function statusLabel(progress: CollaborationProgress, approval: RuntimeApprovalRequest | null): string {
  if (approval || progress.currentStage?.status === 'waiting_approval') return '待审批';
  if (progress.currentStage?.status === 'paused') return '已暂停';
  if (progress.task.status === 'running' && progress.waitingReason) return progress.waitingReason.includes('审批') ? '待审批' : '等待用户';
  return STATUS_LABELS[progress.task.status] ?? progress.task.status;
}

function agentName(agents: AgentProfile[], id: string): string {
  return agents.find(agent => agent.id === id)?.name ?? id;
}

function timeLabel(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function StagePublicOutput({ stage }: { readonly stage: CollaborationProgressStage }) {
  if (!stage.publicOutput) {
    const reason = stage.publicOutputReason ?? (stage.publicOutputStatus === 'not_started' ? '尚未开始'
      : stage.publicOutputStatus === 'not_recorded' ? '阶段已结束，但没有保存公开输出'
        : stage.publicOutputStatus === 'invalid' ? '公开输出无效，未用于评审或测试结论'
          : stage.publicOutputStatus === 'unavailable' ? '历史阶段的公开输出不可用'
            : '该阶段暂未提供公开输出');
    return <p className="mt-2 text-xs leading-5 ui-dim">{reason}</p>;
  }

  if (stage.publicOutput.length <= 280) {
    return <p className="mt-2 whitespace-pre-wrap text-xs leading-5 ui-text-soft">{stage.publicOutput}</p>;
  }

  return <details className="mt-2 min-w-0">
    <summary className="cursor-pointer list-none rounded-lg bg-[var(--app-surface-soft)] px-3 py-2 text-xs leading-5 ui-text-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--app-accent)]">
      <span className="line-clamp-2 whitespace-pre-wrap">{stage.publicOutput}</span>
      <span className="mt-1 inline-block text-[11px] ui-accent">展开完整公开输出（{stage.publicOutput.length} 字）</span>
    </summary>
    <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-5 ui-text-soft">{stage.publicOutput}</p>
  </details>;
}

export function CollaborationTaskDetailsView(props: {
  readonly workspaceId: string;
  readonly apiBase: string;
  readonly state: CollaborationProgressState;
  readonly agents: AgentProfile[];
  readonly activeRunId?: string;
  readonly onBack: () => void;
  readonly onOpenRun: (runId: string) => void;
  readonly focusTaskId?: string | null;
  readonly onTaskTitleFocused?: () => void;
}) {
  const { request } = useApi();
  const progress = props.state.progress;
  const [selectedRunId, setSelectedRunId] = useState(props.activeRunId ?? progress?.currentRunId ?? '');
  const [approval, setApproval] = useState<RuntimeApprovalRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [error, setError] = useState('');
  const [previewTarget, setPreviewTarget] = useState<CollaborationCandidatePreviewIdentity | null>(null);
  const [previewedCandidateKey, setPreviewedCandidateKey] = useState<string | null>(null);
  const taskTitleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    setPreviewTarget(null);
    setPreviewedCandidateKey(null);
  }, [props.workspaceId, progress?.task.id]);

  useEffect(() => {
    if (!props.focusTaskId || !progress || props.focusTaskId !== progress.task.id) return;
    taskTitleRef.current?.focus();
    props.onTaskTitleFocused?.();
  }, [progress?.task.id, props.focusTaskId, props.onTaskTitleFocused]);

  useEffect(() => {
    const requested = props.activeRunId ?? progress?.currentRunId ?? '';
    if (requested && progress?.runs.some(run => run.runId === requested)) setSelectedRunId(requested);
  }, [progress?.currentRunId, progress?.runs, props.activeRunId]);

  useEffect(() => {
    if (!progress?.currentRunId) {
      setApproval(null);
      return undefined;
    }
    const controller = new AbortController();
    void listRuntimeApprovals(props.apiBase, props.workspaceId, controller.signal)
      .then(result => {
        if (controller.signal.aborted) return;
        setApproval(result.requests.find(item => item.runId === progress.currentRunId && item.status === 'pending') ?? null);
      })
      .catch(() => {
        if (!controller.signal.aborted) setApproval(null);
      });
    return () => controller.abort();
  }, [progress?.currentRunId, progress?.currentStage?.status, props.apiBase, props.workspaceId, props.state.refreshRevision]);

  const currentRun = progress?.runs.find(run => run.runId === selectedRunId) ?? progress?.runs.find(run => run.runId === progress.currentRunId) ?? progress?.runs.at(-1);
  const currentStage = progress?.currentStage;
  const displayStatus = progress ? statusLabel(progress, approval) : '';
  const nextAction = useMemo(() => {
    if (!progress) return '';
    if (approval || currentStage?.status === 'waiting_approval') return '查看审批';
    if (progress.task.status === 'awaiting_confirmation') return '检查并确认任务';
    if (progress.task.status === 'awaiting_application') return '检查并应用';
    if (progress.task.status === 'failed' || progress.task.status === 'blocked') return '查看原因';
    if (progress.task.status === 'running' || progress.task.status === 'reviewing' || progress.task.status === 'queued') return '查看进展';
    return '';
  }, [approval, currentStage?.status, progress]);

  if (!progress) return <section className="rounded-2xl border ui-border bg-[var(--app-surface)] p-6 text-sm ui-muted">正在加载协作任务…</section>;

  const task = progress.task;
  const runIds = progress.runs.map(run => run.runId);
  const canCancel = ['queued', 'running', 'reviewing', 'changes_requested'].includes(task.status);
  const pendingControlReason = collaborationControlBlockReason(readPendingCollaborationControl(task));
  const currentCandidate = task.currentCandidateId
    ? progress.candidates.find(candidate => candidate.id === task.currentCandidateId)
    : undefined;
  const currentCandidateIdentity = currentCandidate ? {
    workspaceId: props.workspaceId, taskId: task.id, candidateId: currentCandidate.id,
    baseCommit: task.baseCommit, diffHash: currentCandidate.diffHash, contentHash: currentCandidate.contentHash,
  } : undefined;
  const currentCandidateKey = currentCandidateIdentity ? collaborationCandidatePreviewKey(currentCandidateIdentity) : undefined;
  const currentCandidateWasPreviewed = currentCandidateKey !== undefined && previewedCandidateKey === currentCandidateKey;
  const activePreviewTarget = previewTarget?.workspaceId === props.workspaceId && previewTarget.taskId === task.id
    && previewTarget.candidateId === task.currentCandidateId && previewTarget.diffHash === currentCandidate?.diffHash
    && previewTarget.contentHash === currentCandidate?.contentHash
    ? previewTarget : null;
  const mutate = async (action: 'confirm' | 'cancel' | 'apply') => {
    if (pendingControlReason) return;
    if (action === 'apply' && (!currentCandidateIdentity || !currentCandidateWasPreviewed)) {
      setError('请先加载并检查当前冻结候选的文件差异，再应用该候选');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await request(`/api/workspaces/${encodeURIComponent(props.workspaceId)}/collaboration/tasks/${encodeURIComponent(task.id)}/${action}`, {
        ...collaborationMutationRequest(task.id, task.version, action,
          action === 'apply' && currentCandidateIdentity
            ? { id: currentCandidateIdentity.candidateId, baseCommit: currentCandidateIdentity.baseCommit, contentHash: currentCandidateIdentity.contentHash }
            : undefined),
      });
      props.state.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '协作任务操作失败');
    } finally {
      setBusy(false);
    }
  };

  const decideApproval = async (decision: RuntimeApprovalDecision) => {
    if (!approval) return;
    setApprovalBusy(true);
    setError('');
    try {
      await resolveRuntimeApproval(props.apiBase, props.workspaceId, approval.id, { expectedVersion: approval.version, decision, decidedBy: 'workspace-ui' });
      setApproval(null);
      props.state.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '审批操作失败');
    } finally {
      setApprovalBusy(false);
    }
  };

  return <section className="rounded-2xl border ui-border bg-[var(--app-surface)] p-5 shadow-[var(--app-shadow-soft)]" aria-label="协作任务详情">
    <header className="flex flex-wrap items-start justify-between gap-3 border-b ui-border pb-4">
      <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="text-[11px] tracking-[0.14em] ui-accent">COLLABORATION</span><span className="rounded-full border ui-border px-2 py-0.5 text-[11px] ui-muted">{displayStatus}</span>{nextAction && <span className="text-[11px] ui-dim">下一步：{nextAction}</span>}</div><h1 ref={taskTitleRef} tabIndex={-1} className="mt-2 text-lg font-semibold ui-text">{task.title}</h1><details className="mt-1 max-w-3xl"><summary className="cursor-pointer list-none text-xs leading-5 ui-muted"><span className="line-clamp-2">{task.objective}</span><span className="mt-1 inline-block ui-accent">展开完整目标</span></summary><p className="mt-2 whitespace-pre-wrap text-sm leading-6 ui-text-soft">{task.objective}</p></details></div>
      <button type="button" className="ui-button-ghost rounded-lg px-3 py-1.5 text-xs" onClick={props.onBack}>返回对话</button>
    </header>

    <div className="mt-4 flex flex-wrap items-center gap-2">
      <label className="text-xs ui-muted" htmlFor="collaboration-history">历史协作任务</label>
      <select id="collaboration-history" aria-label="选择历史协作任务" value={props.state.selectedTaskId ?? ''} onChange={event => props.state.selectTask(event.target.value)} className="ui-input min-w-0 max-w-full rounded-lg px-2 py-2 text-xs ui-text">
        {props.state.tasks.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
      </select>
      {props.state.hasMoreTasks && <button type="button" disabled={props.state.loadingMoreTasks} onClick={props.state.loadMoreTasks} className="ui-button-ghost rounded-lg px-3 py-2 text-xs">{props.state.loadingMoreTasks ? '加载历史中…' : '加载更多历史任务'}</button>}
    </div>

    <div className="mt-4 grid gap-3 text-xs ui-muted sm:grid-cols-3"><span>基线：<code>{task.baseCommit.slice(0, 10)}</code></span><span>返工轮次：<strong className="ui-text">{task.reworkRound}/{task.maxReworkRounds}</strong></span><span>当前阶段：<strong className="ui-text">{currentStage ? stageLabel(currentStage) : '未开始'}</strong></span></div>
    {pendingControlReason && <div role="status" className="mt-4 rounded-xl border border-[var(--app-warning)]/40 bg-[var(--app-warning)]/10 px-3 py-3 text-sm ui-text-soft">{pendingControlReason}</div>}
    {progress.waitingReason && <div className="mt-4 rounded-xl border border-[var(--app-warning)]/40 bg-[var(--app-warning)]/10 px-3 py-3 text-sm ui-text-soft">{progress.waitingReason}{approval && <span className="ml-1">请在此处决定是否继续。</span>}</div>}

    {approval && <div className="mt-4 rounded-xl border border-[var(--app-warning)]/40 bg-[var(--app-surface-soft)] p-4"><div className="text-sm font-medium ui-text">执行审批</div><p className="mt-2 text-sm leading-6 ui-text-soft">{approval.description}</p><div className="mt-3 flex flex-wrap justify-end gap-2"><button type="button" disabled={approvalBusy} className="ui-button-secondary rounded-lg px-3 py-2 text-xs" onClick={() => { void decideApproval('reject'); }}>拒绝执行</button><button type="button" disabled={approvalBusy} className="ui-button-primary rounded-lg px-3 py-2 text-xs" onClick={() => { void decideApproval('approve_once'); }}>{approvalBusy ? '处理中…' : '批准本次执行'}</button></div></div>}

    <div className="mt-5 grid gap-4 lg:grid-cols-2"><section className="rounded-xl border ui-border p-4"><h2 className="text-sm font-medium ui-text">计划与分工</h2><div className="mt-3 grid gap-2 text-xs ui-muted"><span>规划：<strong className="ui-text">{agentName(props.agents, task.plannerAgentId)}</strong></span><span>实施：<strong className="ui-text">{agentName(props.agents, task.implementerAgentId)}</strong></span><span>评审：<strong className="ui-text">{agentName(props.agents, task.reviewerAgentId)}</strong></span></div><div className="mt-4"><div className="text-xs font-medium ui-text-soft">修改范围</div><ul className="mt-2 list-disc space-y-1 pl-5 text-xs leading-5 ui-muted">{task.scope.map(item => <li key={item}>{item}</li>)}</ul></div><div className="mt-4"><div className="text-xs font-medium ui-text-soft">验收命令</div><div className="mt-2 space-y-2">{task.acceptanceCommands.map(command => <code key={command} className="block overflow-x-auto rounded-lg border ui-border bg-[var(--app-surface-soft)] px-2.5 py-2 text-[11px] ui-text-soft">{command}</code>)}</div></div></section>
      <section className="rounded-xl border ui-border p-4"><div className="flex items-center justify-between gap-3"><h2 className="text-sm font-medium ui-text">执行轮次</h2><span className="text-xs ui-muted">{runIds.length} 个 Run</span></div><select aria-label="选择执行轮次" value={selectedRunId} onChange={event => { setSelectedRunId(event.target.value); props.onOpenRun(event.target.value); }} className="ui-input mt-3 w-full rounded-lg px-2 py-2 text-xs ui-text">{runIds.map(runId => <option key={runId} value={runId}>{runId}</option>)}</select>{currentRun && <div className="mt-3 grid gap-2 text-xs ui-muted"><span>状态：<strong className="ui-text">{currentRun.status}</strong></span><span>事件：<strong className="ui-text">{currentRun.highWatermark}</strong></span>{currentRun.failureMessage && <span className="text-[var(--app-danger)]">{currentRun.failureMessage}</span>}</div>}<button type="button" disabled={!selectedRunId} className="ui-button-secondary mt-4 rounded-lg px-3 py-2 text-xs disabled:opacity-50" onClick={() => selectedRunId && props.onOpenRun(selectedRunId)}>查看技术详情</button></section></div>

    <section className="mt-5"><h2 className="text-sm font-medium ui-text">阶段与交接</h2><ol className="mt-3 grid gap-2">{(currentRun?.stages ?? []).map(stage => <li key={`${stage.runId}:${stage.stageId}`} className="rounded-xl border ui-border p-3"><div className="flex flex-wrap items-center gap-2 text-sm"><span className="font-medium ui-text">{stageLabel(stage)}</span><span className="text-xs ui-muted">{stageStatusLabel(stage.status)}</span><span className="ml-auto text-[11px] ui-dim">{timeLabel(stage.startedAt ?? stage.completedAt)}</span></div><div className="mt-1 text-xs ui-muted">{stage.agent ? `${stage.agent.name} · ${stage.agent.roleTitle}` : '未绑定 Agent'}</div>{stage.failureMessage && <p className="mt-2 text-xs leading-5 text-[var(--app-danger)]">{stage.failureMessage}</p>}<StagePublicOutput stage={stage} />{stage.evidence.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{stage.evidence.map((item, index) => <span key={`${item.kind}-${item.label}-${index}`} className="rounded-md border ui-border px-2 py-1 text-[11px] ui-muted">{item.kind === 'test' ? `${item.label} · ${testStatusLabel(item.status ?? 'unknown')}` : `${item.label}${item.status ? ` · ${item.status}` : ''}`}</span>)}</div>}</li>)}</ol></section>

    {progress.candidates.length > 0 && <section className="mt-5 rounded-xl border ui-border p-4"><h2 className="text-sm font-medium ui-text">交付证据</h2><div className="mt-3 grid gap-2">{progress.candidates.map(candidate => {
      const isCurrentCandidate = candidate.id === task.currentCandidateId;
      const identity: CollaborationCandidatePreviewIdentity = { workspaceId: props.workspaceId, taskId: task.id,
        candidateId: candidate.id, baseCommit: task.baseCommit, diffHash: candidate.diffHash, contentHash: candidate.contentHash };
      const isOpen = activePreviewTarget?.candidateId === candidate.id && activePreviewTarget.contentHash === candidate.contentHash;
      return <div key={candidate.id} className="rounded-lg border ui-border px-3 py-3 text-xs"><div className="flex flex-wrap items-center gap-2 ui-text-soft"><span>候选版本 · 第 {candidate.round + 1} 轮</span><span className="ui-muted">{testStatusLabel(candidate.testStatus)}</span>{candidate.testExitCode !== undefined && <span className="ui-muted">退出码 {candidate.testExitCode}</span>}</div><div className="mt-2 break-all text-[11px] ui-dim">冻结候选内容 SHA-256：<code title={candidate.contentHash}>{candidate.contentHash}</code></div>{candidate.testCommand && <code className="mt-2 block overflow-x-auto whitespace-pre-wrap text-[11px] ui-muted">{candidate.testCommand}</code>}{candidate.reviewConclusion && <div className="mt-2 ui-muted">评审：{candidate.reviewConclusion === 'approved' ? '通过' : '要求修改'}{candidate.reviewSummary ? ` · ${candidate.reviewSummary}` : ''}</div>}{isCurrentCandidate && <><button type="button" className="ui-button-secondary mt-3 rounded-lg px-3 py-2 text-xs" onClick={() => setPreviewTarget(isOpen ? null : identity)}>{isOpen ? '收起候选预览' : '查看冻结文件与差异'}</button>{isOpen && <CollaborationCandidatePreviewPanel apiBase={props.apiBase} identity={identity} onLoaded={setPreviewedCandidateKey} />}</>}</div>;
    })}</div></section>}

    {error && <div role="alert" className="ui-error mt-4 rounded-xl border px-3 py-2 text-sm">{error}</div>}
    {(['failed', 'blocked', 'queued'].includes(task.status)) && <CollaborationRecoveryPanel
      workspaceId={props.workspaceId}
      taskId={task.id}
      taskStatus={task.status}
      refreshRevision={props.state.refreshRevision}
      onRecovered={result => {
        if (result.action === 'new-linked-task') props.state.selectTask(result.task.id);
        props.state.refresh();
      }}
    />}
    <footer className="mt-5 flex flex-wrap items-center justify-end gap-2 border-t ui-border pt-4">{task.status === 'awaiting_confirmation' && <button type="button" disabled={busy || Boolean(pendingControlReason)} className="ui-button-primary rounded-lg px-3 py-2 text-xs disabled:opacity-50" onClick={() => { void mutate('confirm'); }}>{busy ? '启动中…' : '确认并启动'}</button>}{task.status === 'awaiting_application' && <button type="button" disabled={busy || Boolean(pendingControlReason) || !currentCandidateWasPreviewed} className="ui-button-primary rounded-lg px-3 py-2 text-xs disabled:opacity-50" onClick={() => { void mutate('apply'); }}>{busy ? '应用中…' : currentCandidateWasPreviewed ? '确认应用已预览候选' : '先查看候选差异'}</button>}{canCancel && <button type="button" disabled={busy || Boolean(pendingControlReason)} className="ui-button-secondary rounded-lg px-3 py-2 text-xs disabled:opacity-50" onClick={() => { void mutate('cancel'); }}>取消任务</button>}</footer>
  </section>;
}
