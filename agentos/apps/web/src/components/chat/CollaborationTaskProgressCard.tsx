'use client';

import type { AgentProfile, CollaborationProgress, CollaborationProgressStage, CollaborationStatus } from '@agentos/shared';
import type { CollaborationProgressConnection, CollaborationProgressState } from '@/lib/useCollaborationProgress';

const STATUS_LABELS: Record<CollaborationStatus, string> = {
  awaiting_confirmation: '待用户确认',
  queued: '已排队',
  running: '执行中',
  reviewing: '评审中',
  changes_requested: '待返工',
  awaiting_application: '评审通过 · 待应用',
  applied: '已应用',
  failed: '执行失败',
  blocked: '已阻塞',
  cancelled: '已取消',
};

const STAGE_LABELS: Record<string, string> = {
  plan: '规划',
  implement: '实施',
  review: '评审',
  security: '安全检查',
};

function statusLabel(status: CollaborationStatus): string {
  return STATUS_LABELS[status] ?? status;
}

function progressStatusLabel(progress: CollaborationProgress): string {
  if (progress.currentStage?.status === 'waiting_approval') return '待审批';
  if (progress.currentStage?.status === 'paused') return '已暂停';
  if (progress.task.status === 'running' && progress.waitingReason) return progress.waitingReason.includes('审批') ? '待审批' : '等待用户';
  return statusLabel(progress.task.status);
}

function actionLabel(progress: CollaborationProgress): string {
  if (progress.currentStage?.status === 'waiting_approval') return '查看审批';
  if (progress.task.status === 'awaiting_confirmation') return '检查并确认任务';
  if (progress.task.status === 'awaiting_application') return '检查并应用';
  if (progress.task.status === 'failed' || progress.task.status === 'blocked') return '查看原因';
  return '查看进展';
}

function stageLabel(stage: CollaborationProgressStage): string {
  return STAGE_LABELS[stage.stageKey] ?? stage.label ?? stage.stageKey;
}

function stageStatusLabel(status: CollaborationProgressStage['status']): string {
  const labels: Record<CollaborationProgressStage['status'], string> = {
    pending: '未开始', ready: '待执行', starting: '启动中', running: '执行中', waiting_approval: '待审批', paused: '已暂停', completed: '已完成', failed: '失败', cancelled: '已取消', skipped: '已跳过', unknown: '未知',
  };
  return labels[status];
}

function connectionLabel(connection: CollaborationProgressConnection): string {
  if (connection === 'connected') return '实时同步';
  if (connection === 'offline') return '连接中断，保留最近状态';
  if (connection === 'polling' || connection === 'connecting') return '正在同步';
  return '';
}

function shortTime(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function stageAgentLabel(stage: CollaborationProgressStage): string {
  if (!stage.agent) return '未绑定 Agent';
  return `${stage.agent.name} · ${stage.agent.roleTitle}`;
}

function stageOutputLabel(stage: CollaborationProgressStage): string {
  if (stage.publicOutputReason) return stage.publicOutputReason;
  switch (stage.publicOutputStatus) {
    case 'not_started': return '尚未开始';
    case 'not_recorded': return '阶段已结束，但没有保存公开输出';
    case 'invalid': return '公开输出无效，未用于评审或测试结论';
    case 'unavailable': return '历史阶段的公开输出不可用';
    default: return '该阶段暂未提供公开输出';
  }
}

function testLabel(status: string | undefined): string {
  if (status === 'passed') return '测试通过';
  if (status === 'failed') return '测试失败';
  if (status === 'running') return '测试执行中';
  if (status === 'evidence_missing') return '缺少测试证据';
  if (status === 'not_run') return '未执行测试';
  return status ?? '测试状态未知';
}

function ProgressStage({ stage }: { stage: CollaborationProgressStage }) {
  return <li className="collaboration-progress-stage rounded-xl border ui-border px-3 py-3" data-stage-status={stage.status}>
    <div className="flex min-w-0 items-start gap-3">
      <span aria-hidden="true" className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${stage.status === 'completed' ? 'bg-[var(--app-success)]' : stage.status === 'failed' || stage.status === 'cancelled' ? 'bg-[var(--app-danger)]' : stage.status === 'running' || stage.status === 'starting' || stage.status === 'waiting_approval' || stage.status === 'paused' ? 'bg-[var(--app-accent)]' : 'bg-[var(--app-dim)]'}`} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm"><span className="font-medium ui-text">{stageLabel(stage)}</span><span className="text-xs ui-muted">{stageStatusLabel(stage.status)}</span>{stage.attempt > 1 && <span className="text-xs ui-muted">attempt {stage.attempt}</span>}<span className="ml-auto text-[11px] ui-dim">{shortTime(stage.startedAt ?? stage.completedAt)}</span></div>
        <div className="mt-1 text-xs ui-muted">{stageAgentLabel(stage)}</div>
        {stage.failureMessage && <p className="mt-2 text-xs leading-5 text-[var(--app-danger)]">{stage.failureMessage}</p>}
        {stage.publicOutput ? <p className="mt-2 whitespace-pre-wrap text-xs leading-5 ui-text-soft">{stage.publicOutput}</p> : <p className="mt-2 text-xs ui-dim">{stageOutputLabel(stage)}</p>}
        {stage.evidence.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{stage.evidence.map((evidence, index) => <span key={`${evidence.kind}-${evidence.label}-${index}`} className="rounded-md border ui-border px-1.5 py-1 text-[11px] ui-muted">{evidence.kind === 'test' ? testLabel(evidence.status) : evidence.label}{evidence.kind !== 'test' && evidence.status ? ` · ${evidence.status}` : ''}</span>)}</div>}
      </div>
    </div>
  </li>;
}

function planStages(progress: CollaborationProgress, agents: AgentProfile[]): CollaborationProgressStage[] {
  const planner = progress.task.plannerAgentId;
  const implementer = progress.task.implementerAgentId;
  const reviewer = progress.task.reviewerAgentId;
  const nameOf = (id: string) => agents.find(agent => agent.id === id)?.name ?? id;
  const titleOf = (id: string, fallback: string) => agents.find(agent => agent.id === id)?.roleTitle ?? fallback;
  return [
    { runId: '', stageId: 'planned-plan', stageKey: 'plan', label: '规划', sequence: 0, attempt: 0, status: 'pending', agent: { agentId: planner, name: nameOf(planner), role: 'planner', roleTitle: titleOf(planner, '规划 Agent') }, evidence: [] },
    { runId: '', stageId: 'planned-implement', stageKey: 'implement', label: '实施', sequence: 1, attempt: 0, status: 'pending', agent: { agentId: implementer, name: nameOf(implementer), role: 'implementer', roleTitle: titleOf(implementer, '实施 Agent') }, evidence: [] },
    { runId: '', stageId: 'planned-review', stageKey: 'review', label: '评审', sequence: 2, attempt: 0, status: 'pending', agent: { agentId: reviewer, name: nameOf(reviewer), role: 'reviewer', roleTitle: titleOf(reviewer, '评审 Agent') }, evidence: [] },
  ];
}

export function CollaborationTaskProgressCard(props: {
  readonly state: CollaborationProgressState;
  readonly agents: AgentProfile[];
  readonly onOpenTask: () => void;
  readonly onCreateTask: () => void;
  readonly onOpenRuntime: (runId: string) => void;
}) {
  const progress = props.state.progress;
  if (!progress) return null;
  const currentRun = progress.runs.find(run => run.runId === progress.currentRunId) ?? progress.runs.at(-1);
  const stages = currentRun?.stages.length ? currentRun.stages : planStages(progress, props.agents);
  const connection = connectionLabel(props.state.connection);
  return <section className="collaboration-progress-card rounded-2xl border ui-border bg-[var(--app-surface-raised)] px-4 py-4 shadow-[var(--app-shadow-soft)]" aria-label="协作任务进度" aria-live="polite" data-collaboration-task={progress.task.id}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="text-[11px] tracking-[0.14em] ui-accent">COLLABORATION</span><span className="rounded-full border ui-border px-2 py-0.5 text-[11px] ui-muted">{progressStatusLabel(progress)}</span>{connection && <span className="text-[11px] ui-dim">· {connection}</span>}</div><h2 className="mt-2 truncate text-base font-semibold ui-text">{progress.task.title}</h2><p className="mt-1 line-clamp-2 text-xs leading-5 ui-muted">{progress.task.objective}</p></div>
      <div className="flex shrink-0 items-center gap-2"><button type="button" className="ui-button-ghost rounded-lg px-2.5 py-1.5 text-xs" onClick={props.onOpenTask}>{actionLabel(progress)}</button>{progress.currentRunId && <button type="button" className="ui-button-secondary rounded-lg px-2.5 py-1.5 text-xs" onClick={() => props.onOpenRuntime(progress.currentRunId!)}>查看执行证据</button>}<button type="button" className="ui-button-ghost rounded-lg px-2 py-1.5 text-xs" onClick={props.onCreateTask}>新建</button></div>
    </div>
    {props.state.tasks.length > 1 && <label className="mt-3 flex items-center gap-2 text-xs ui-muted"><span>历史任务</span><select aria-label="选择协作任务" value={props.state.selectedTaskId ?? ''} onChange={event => props.state.selectTask(event.target.value)} className="ui-input min-w-0 rounded-lg px-2 py-1.5 text-xs ui-text">{props.state.tasks.map(task => <option key={task.id} value={task.id}>{task.title} · {task.id === progress.task.id ? progressStatusLabel(progress) : statusLabel(task.status)}</option>)}</select>{props.state.hasMoreTasks && <button type="button" className="ui-button-ghost shrink-0 rounded-lg px-2 py-1.5 text-xs" disabled={props.state.loadingMoreTasks} onClick={props.state.loadMoreTasks}>{props.state.loadingMoreTasks ? '加载中…' : '更早任务'}</button>}</label>}
    <div className="mt-4 grid gap-2 text-xs ui-muted sm:grid-cols-3"><span>当前阶段：<strong className="font-medium ui-text">{progress.currentStage ? stageLabel(progress.currentStage) : '未开始'}</strong></span><span>负责 Agent：<strong className="font-medium ui-text">{progress.currentAgent?.name ?? '尚未执行'}</strong></span><span>返工轮次：<strong className="font-medium ui-text">{progress.task.reworkRound}/{progress.task.maxReworkRounds}</strong></span></div>
    {progress.waitingReason && <div className="mt-3 rounded-lg border border-[var(--app-warning)]/40 bg-[var(--app-warning)]/10 px-3 py-2 text-xs leading-5 ui-text-soft">{progress.waitingReason}</div>}
    {progress.warnings?.map((warning, index) => <div key={`warning-${index}`} role="status" className="mt-3 rounded-lg border border-[var(--app-danger)]/40 bg-[var(--app-danger)]/10 px-3 py-2 text-xs leading-5 text-[var(--app-danger)]">证据关联异常：{warning}</div>)}
    <ol className="mt-4 grid gap-2" aria-label="协作阶段">{stages.map(stage => <ProgressStage key={`${stage.runId}:${stage.stageId}`} stage={stage} />)}</ol>
    {progress.candidates.length > 0 && <div className="mt-3 flex flex-wrap gap-2 text-xs ui-muted"><span>候选版本 {progress.candidates.length} 个</span>{progress.candidates.slice(-3).map(candidate => <span key={candidate.id} className="rounded-md border ui-border px-2 py-1">第 {candidate.round + 1} 轮 · {testLabel(candidate.testStatus)}</span>)}</div>}
    {props.state.error && <div role="status" className="mt-3 text-xs text-[var(--app-warning)]">{props.state.error}</div>}
  </section>;
}
