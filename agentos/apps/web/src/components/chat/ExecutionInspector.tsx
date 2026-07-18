import { useEffect, useState } from 'react';
import type { AgentEvent, AgentExecution, AgentProfile, ExecutionEvent, ExecutionStatus } from '@agentos/shared';
import { getElapsedSeconds, shouldRefreshElapsed } from '@/lib/executionElapsed';
import { summarizeExecutionInspector } from '@/lib/executionInspector';

type VisibleExecutionEvent = ExecutionEvent & { agentId?: string; agentName?: string };

const statusLabel: Record<ExecutionStatus, string> = { queued: '排队中', preparing_context: '准备上下文', running_cli: '调用 CLI', streaming_response: '生成回复', waiting_user: '等待用户补充', completed: '完成', failed: '失败', cancelled: '已取消' };
const statusColor: Record<ExecutionStatus, string> = { queued: 'bg-[var(--app-dim)]', preparing_context: 'bg-[var(--app-info)]', running_cli: 'bg-[var(--app-warning)]', streaming_response: 'bg-[var(--app-accent)]', waiting_user: 'bg-[var(--app-info)]', completed: 'bg-[var(--app-success)]', failed: 'bg-[var(--app-danger)]', cancelled: 'bg-[var(--app-dim)]' };

function formatTokens(value: number | undefined): string {
  if (value === undefined) return '—';
  if (value >= 1000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(value);
}

function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) return '—';
  if (durationMs < 1000) return `${(durationMs / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}

function toolIcon(toolName: string): string {
  if (/read/i.test(toolName)) return '📄';
  if (/edit|write|patch|change/i.test(toolName)) return '🔧';
  return '▣';
}

function actionTone(state: 'working' | 'completed' | 'failed' | 'waiting'): string {
  if (state === 'completed') return 'var(--app-success)';
  if (state === 'failed') return 'var(--app-danger)';
  if (state === 'waiting') return 'var(--app-info)';
  return 'var(--app-accent)';
}

interface ExecutionInspectorProps {
  agent?: AgentProfile;
  groupTitle?: string;
  events: VisibleExecutionEvent[];
  runtimeEvents?: AgentEvent[];
  executions: AgentExecution[];
  activeStatus?: ExecutionStatus;
  activeStartedAt?: string;
  onEdit?(): void;
  onOpenRunDetails?(runId: string): void;
}

export function ExecutionInspector({ agent, groupTitle, events, runtimeEvents = [], executions, activeStatus, activeStartedAt, onEdit, onOpenRunDetails }: ExecutionInspectorProps) {
  const latest = executions[0];
  const status = activeStatus ?? latest?.status;
  const [, setClock] = useState(Date.now());
  const elapsedStartedAt = activeStartedAt ?? latest?.startedAt;
  const terminalStatus = status && ['completed', 'failed', 'cancelled'].includes(status);
  const elapsedCompletedAt = terminalStatus ? latest?.completedAt : undefined;
  useEffect(() => {
    if (!shouldRefreshElapsed(activeStatus ?? latest?.status, Boolean(elapsedStartedAt))) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [activeStatus, elapsedStartedAt, latest?.status]);
  const elapsed = elapsedStartedAt
    ? getElapsedSeconds({ startedAt: elapsedStartedAt, completedAt: elapsedCompletedAt })
    : 0;
  const executionSummary = summarizeExecutionInspector({
    status,
    startedAt: elapsedStartedAt,
    completedAt: elapsedCompletedAt,
    events,
    runtimeEvents,
  });
  const permissions = agent?.permissions ?? [];

  return <aside data-signal-inspector className="inspector-sidebar signal-inspector ui-panel w-64 shrink-0 overflow-y-auto border-l px-4 py-5">
    <div className="mb-6 flex items-center justify-between"><div><div className="signal-section-label mb-1">RUN STATUS</div><h2 className="text-sm font-semibold ui-text">执行状态</h2></div>{agent && <button type="button" onClick={onEdit} className="ui-button-ghost rounded-lg px-2 py-1 text-xs">编辑身份</button>}</div>
    {groupTitle ? <div className="signal-inspector-summary mb-6 flex items-center gap-3 p-3"><span className="grid h-9 w-9 place-items-center rounded-xl bg-[var(--app-info)] text-sm font-semibold text-white">群</span><div className="min-w-0"><div className="truncate text-sm font-medium ui-text">{groupTitle}</div><div className="mt-0.5 text-xs ui-muted">群聊协作</div></div></div> : agent ? <>
      <div className="signal-inspector-summary mb-6 flex items-center gap-3 p-3"><span className="grid h-9 w-9 place-items-center rounded-xl bg-[var(--app-accent)] text-sm font-semibold text-white">{agent.name.slice(0, 1)}</span><div className="min-w-0"><div className="truncate text-sm font-medium ui-text">{agent.name}</div><div className="mt-0.5 truncate text-xs ui-muted">{agent.roleTitle}</div></div></div>
      <section className="mb-6"><h3 className="signal-section-label mb-3">PERMISSIONS</h3><div className="space-y-2 text-xs ui-text-soft">{(['read', 'write', 'review'] as const).map(permission => <div key={permission} className="flex items-center gap-2"><span className={`grid h-4 w-4 place-items-center rounded-full text-[10px] ${permissions.includes(permission) ? 'bg-[color:var(--app-success)]/20 text-[var(--app-success)]' : 'bg-[var(--app-surface-soft)] ui-dim'}`}>{permissions.includes(permission) ? '✓' : '·'}</span>{permission === 'read' ? '读取项目文件' : permission === 'write' ? '修改项目文件' : '代码审查'}</div>)}</div></section>
    </> : <div className="text-sm leading-6 ui-dim">选择一个 Agent 或群聊查看执行状态。</div>}
    {(agent || groupTitle) && <>
      <section className="border-t ui-border pt-5">
        <div className="mb-4 flex items-center justify-between"><h3 className="signal-section-label">当前动作</h3>{status && <span className="rounded-full border ui-border px-2 py-1 text-xs ui-muted">{statusLabel[status]}</span>}</div>
        <div className="rounded-xl border ui-border bg-[var(--app-surface-raised)] p-3" aria-label="当前动作">
          <div className="flex items-center gap-2 text-xs font-semibold ui-text"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: actionTone(executionSummary.currentAction.state) }} />{executionSummary.currentAction.label}</div>
          <div className="mt-2 text-xs leading-5 ui-text-soft">{executionSummary.currentAction.detail}{executionSummary.currentAction.target ? '：' : ''}</div>
          {executionSummary.currentAction.target && <code className="mt-1 block break-all rounded-md bg-[var(--app-bg)] px-2 py-1 text-[10px] leading-4 ui-accent">{executionSummary.currentAction.target}</code>}
        </div>
      </section>

      <section className="mt-5 border-t ui-border pt-5" aria-label="工具历史">
        <div className="mb-3 flex items-center justify-between"><h3 className="signal-section-label">工具历史</h3><span className="text-[11px] ui-dim">{executionSummary.tools.length} 个工具</span></div>
        {executionSummary.tools.length > 0 ? <div className="space-y-2">{executionSummary.tools.map(tool => <div key={tool.id} className="rounded-xl border ui-border px-2.5 py-2">
          <div className="flex items-center gap-2"><span aria-hidden="true" className="text-sm">{toolIcon(tool.toolName)}</span><span className="min-w-0 truncate text-xs font-medium ui-text">{tool.toolName}</span><span className={`ml-auto text-[10px] ${tool.status === 'failed' ? 'text-[var(--app-danger)]' : tool.status === 'success' ? 'text-[var(--app-success)]' : 'ui-accent'}`}>{tool.status === 'running' ? '进行中' : tool.status === 'success' ? '成功' : '失败'}</span></div>
          {tool.target && <code className="mt-1 block truncate text-[10px] ui-muted">{tool.target}</code>}
          <div className="mt-1 flex items-center justify-between text-[10px] ui-dim"><span>{tool.summary ?? '工具调用'}</span>{tool.durationMs !== undefined && <span className="ml-2 shrink-0">耗时 {formatDuration(tool.durationMs)}</span>}</div>
        </div>)}</div> : <div className="rounded-xl border border-dashed ui-border p-3 text-[11px] leading-5 ui-dim">工具调用将在这里显示。</div>}
      </section>

      <section className="mt-5 grid grid-cols-3 gap-1.5 border-t ui-border pt-5" aria-label="执行统计">
        <div className="rounded-lg border ui-border px-2 py-2"><div className="text-[10px] ui-dim">消耗</div><div className="mt-1 text-xs font-semibold ui-text">Tokens {formatTokens(executionSummary.usage?.totalTokens)}</div></div>
        <div className="rounded-lg border ui-border px-2 py-2"><div className="text-[10px] ui-dim">Duration</div><div className="mt-1 text-xs font-semibold ui-text">{formatDuration(executionSummary.durationMs ?? (elapsedStartedAt ? elapsed * 1000 : undefined))}</div></div>
        <div className="rounded-lg border ui-border px-2 py-2"><div className="text-[10px] ui-dim">Files</div><div className="mt-1 text-xs font-semibold ui-text">+{executionSummary.files.added} -{executionSummary.files.removed}{executionSummary.files.changed ? <span className="ml-1 text-[10px] ui-dim">~{executionSummary.files.changed}</span> : null}</div></div>
      </section>

      <section className="mt-5 border-t ui-border pt-5"><div className="mb-4 flex items-center justify-between"><h3 className="signal-section-label">阶段摘要</h3>{latest?.runId && onOpenRunDetails && <button type="button" onClick={() => onOpenRunDetails(latest.runId)} className="rounded-lg border border-[var(--app-accent)]/40 px-2 py-1 text-[11px] ui-accent hover:bg-[var(--app-accent)]/10">查看详情</button>}</div>{events.length > 0 ? <ol className="signal-timeline space-y-0">{events.map((event, index) => <li key={event.id} className="signal-timeline-item relative flex gap-3 pb-5 last:pb-0"><span className={`signal-timeline-dot relative z-10 mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full ${statusColor[event.status]} ${index === events.length - 1 && !['completed', 'failed', 'cancelled'].includes(event.status) ? 'signal-timeline-dot-current' : ''}`} />{index < events.length - 1 && <span className="signal-timeline-line" />}<div className="min-w-0"><div className="text-xs leading-5 ui-text-soft">{event.agentName && <span className="font-medium ui-accent">{event.agentName} · </span>}{event.activity}</div><div className="mt-0.5 text-[11px] ui-dim">{statusLabel[event.status]} · {new Date(event.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</div>{event.content && event.status !== 'streaming_response' && <div className="mt-1 line-clamp-2 text-[11px] leading-5 ui-muted">{event.content}</div>}</div></li>)}</ol> : <div className="rounded-xl border border-dashed ui-border p-4 text-xs leading-5 ui-dim">发送消息后，这里会显示执行进度与结果。</div>}</section>{latest?.startedAt && <div className="mt-6 border-t ui-border pt-4 text-xs ui-muted">已用时间<span className="ml-2 font-medium ui-text-soft">{String(Math.floor(elapsed / 60)).padStart(2, '0')}:{String(elapsed % 60).padStart(2, '0')}</span></div>}
    </>}
  </aside>;
}
