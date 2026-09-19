'use client';

import { useEffect, useState } from 'react';
import type { AgentEvent, AgentExecution, AgentProfile, AgentRun, ExecutionEvent, ExecutionStatus, RunStep } from '@agentos/shared';
import { getElapsedSeconds, shouldRefreshElapsed } from '@/lib/executionElapsed';
import { summarizeExecutionInspector } from '@/lib/executionInspector';
import { RunTaskTree } from '@/components/runs/RunTaskTree';
import { RuntimeApprovalPanel } from '@/components/chat/RuntimeApprovalPanel';

type VisibleExecutionEvent = ExecutionEvent & { agentId?: string; agentName?: string };

const statusLabel: Record<ExecutionStatus, string> = {
  queued: '排队中', preparing_context: '准备上下文', running_cli: '调用 CLI', streaming_response: '生成回复', waiting_user: '等待用户补充', completed: '完成', failed: '失败', cancelled: '已取消',
};

const statusColor: Record<ExecutionStatus, string> = {
  queued: 'bg-[var(--app-dim)]', preparing_context: 'bg-[var(--app-info)]', running_cli: 'bg-[var(--app-warning)]', streaming_response: 'bg-[var(--app-accent)]', waiting_user: 'bg-[var(--app-info)]', completed: 'bg-[var(--app-success)]', failed: 'bg-[var(--app-danger)]', cancelled: 'bg-[var(--app-dim)]',
};

interface ExecutionInspectorProps {
  agent?: AgentProfile;
  groupTitle?: string;
  events: VisibleExecutionEvent[];
  runtimeEvents?: AgentEvent[];
  steps?: RunStep[];
  executions: AgentExecution[];
  runHistory?: AgentRun[];
  activeStatus?: ExecutionStatus;
  activeStartedAt?: string;
  apiBase?: string;
  workspaceId?: string;
  activeRunId?: string;
  onEdit?(): void;
  onOpenRunDetails?(runId: string): void;
  onRuntimeApprovalResolved?(): void;
  panelWidth?: number;
}

export function ExecutionInspector({ agent, groupTitle, events, runtimeEvents = [], steps = [], executions, runHistory = [], activeStatus, activeStartedAt, apiBase, workspaceId, activeRunId, onEdit, onOpenRunDetails, onRuntimeApprovalResolved, panelWidth }: ExecutionInspectorProps) {
  const latest = [...executions].sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())[0];
  const status = activeStatus ?? latest?.status;
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [, setClock] = useState(Date.now());
  const elapsedStartedAt = activeStartedAt ?? latest?.startedAt;
  const terminalStatus = status && ['completed', 'failed', 'cancelled'].includes(status);
  const elapsedCompletedAt = terminalStatus ? latest?.completedAt : undefined;
  useEffect(() => {
    if (!shouldRefreshElapsed(activeStatus ?? latest?.status, Boolean(elapsedStartedAt))) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [activeStatus, elapsedStartedAt, latest?.status]);
  const elapsed = elapsedStartedAt ? getElapsedSeconds({ startedAt: elapsedStartedAt, completedAt: elapsedCompletedAt }) : 0;
  const summary = summarizeExecutionInspector({ status, startedAt: elapsedStartedAt, completedAt: elapsedCompletedAt, events, runtimeEvents });
  const permissions = agent?.permissions ?? [];
  const hasExecutionEvidence = Boolean(status || latest || events.length || runtimeEvents.length || steps.length);
  const visibleTools = toolsExpanded ? summary.tools : summary.tools.slice(-8);

  return <aside data-signal-inspector data-layout-panel="inspector" className="inspector-sidebar signal-inspector ui-panel w-64 shrink-0 overflow-y-auto border-l px-4 py-5" style={panelWidth === undefined ? undefined : { width: `${panelWidth}px` }}>
    <div className="mb-6 flex items-center justify-between"><h2 className="text-sm font-semibold ui-text">执行状态</h2>{agent && <button type="button" onClick={onEdit} className="ui-button-ghost rounded-lg px-2 py-1 text-xs">编辑身份</button>}</div>
    {groupTitle ? <Identity title={groupTitle} subtitle="群聊协作" mark="群" /> : agent ? <>
      <Identity title={agent.name} subtitle={agent.roleTitle} mark={agent.name.slice(0, 1)} />
      <section className="mb-6"><h3 className="signal-section-label mb-3">权限</h3><div className="space-y-2 text-xs ui-text-soft">{(['read', 'write', 'review'] as const).map(permission => <div key={permission} className="flex items-center gap-2"><span className={`grid h-4 w-4 place-items-center rounded-full text-[10px] ${permissions.includes(permission) ? 'bg-[color:var(--app-success)]/20 text-[var(--app-success)]' : 'bg-[var(--app-surface-soft)] ui-dim'}`}>{permissions.includes(permission) ? '✓' : '·'}</span>{permission === 'read' ? '读取项目文件' : permission === 'write' ? '修改项目文件' : '代码审查'}</div>)}</div></section>
    </> : <div className="text-sm leading-6 ui-dim">选择 Agent 或群聊查看执行状态。</div>}
    {(agent || groupTitle) && <>
      {apiBase && workspaceId && activeRunId ? <RuntimeApprovalPanel apiBase={apiBase} workspaceId={workspaceId} runId={activeRunId} onResolved={onRuntimeApprovalResolved} /> : null}
      {runHistory.length > 1 && onOpenRunDetails && <section className="mb-5 border-t ui-border pt-5" aria-label="历史运行"><div className="mb-3 flex items-center justify-between"><h3 className="signal-section-label">历史运行</h3><span className="text-[11px] ui-dim">{runHistory.length} 次</span></div><div className="space-y-1.5">{(historyExpanded ? runHistory : runHistory.slice(0, 6)).map(run => <button key={run.id} type="button" onClick={() => onOpenRunDetails(run.id)} className="ui-button-ghost flex w-full min-w-0 items-center gap-2 rounded-lg border ui-border px-2.5 py-2 text-left text-xs"><span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: statusColorForRun(run.status) }} /><span className="min-w-0 flex-1 truncate">{run.objective || '未命名 Run'}</span><span className="shrink-0 ui-dim">{runStatusLabel(run.status)}</span></button>)}</div>{runHistory.length > 6 && <button type="button" className="ui-button-ghost mt-2 rounded px-1.5 py-0.5 text-[11px]" aria-expanded={historyExpanded} onClick={() => setHistoryExpanded(current => !current)}>{historyExpanded ? '收起历史' : '查看全部历史'}</button>}</section>}
      {hasExecutionEvidence ? <>
      <section className="border-t ui-border pt-5"><div className="mb-4 flex items-center justify-between"><h3 className="signal-section-label">当前动作</h3></div><div className="rounded-xl border ui-border bg-[var(--app-surface-raised)] p-3" aria-label="当前动作"><div className="flex items-center gap-2 text-xs font-semibold ui-text"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: actionTone(summary.currentAction.state) }} />{summary.currentAction.label}</div><div className="mt-2 text-xs leading-5 ui-text-soft">{summary.currentAction.detail}{summary.currentAction.target ? '：' : ''}</div>{summary.currentAction.target && <code className="mt-1 block break-all rounded-md bg-[var(--app-bg)] px-2 py-1 text-[10px] leading-4 ui-accent">{summary.currentAction.target}</code>}</div></section>
      {steps.length > 0 && <RunTaskTree steps={steps} />}
      {summary.tools.length > 0 && <section className="mt-5 border-t ui-border pt-5" aria-label="工具历史"><div className="mb-3 flex items-center justify-between"><h3 className="signal-section-label">工具历史</h3><div className="flex items-center gap-2 text-[11px] ui-dim"><span>{summary.tools.length} 个工具</span>{summary.tools.length > 8 && <button type="button" className="ui-button-ghost rounded px-1.5 py-0.5" aria-expanded={toolsExpanded} onClick={() => setToolsExpanded(current => !current)}>{toolsExpanded ? '收起' : '查看全部'}</button>}</div></div><div className="space-y-2">{visibleTools.map(tool => <div key={tool.id} className="rounded-xl border ui-border px-2.5 py-2"><div className="flex items-center gap-2"><span aria-hidden="true" className="text-sm">{toolIcon(tool.toolName)}</span><span className="min-w-0 truncate text-xs font-medium ui-text">{tool.toolName}</span><span className={`ml-auto text-[10px] ${tool.status === 'failed' ? 'text-[var(--app-danger)]' : tool.status === 'success' ? 'text-[var(--app-success)]' : 'ui-accent'}`}>{tool.status === 'running' ? '进行中' : tool.status === 'success' ? '成功' : '失败'}</span></div>{tool.target && <code className="mt-1 block truncate text-[10px] ui-muted">{tool.target}</code>}<div className="mt-1 flex items-center justify-between text-[10px] ui-dim"><span>{tool.summary ?? '工具调用'}</span>{tool.durationMs !== undefined && <span className="ml-2 shrink-0">耗时 {formatDuration(tool.durationMs)}</span>}</div></div>)}</div></section>}
      <section className="mt-5 border-t ui-border pt-5" aria-label="执行统计"><h3 className="signal-section-label mb-3">执行统计</h3><div className="space-y-2 text-xs"><Stat label="Tokens" value={formatTokens(summary.usage?.totalTokens, summary.usage?.source)} title={usageTitle(summary.usage?.source, summary.usage?.provider)} /><Stat label="耗时" value={formatDuration(summary.durationMs ?? (elapsedStartedAt ? elapsed * 1000 : undefined))} /><Stat label="文件" value={formatFiles(summary.files)} /></div></section>
      {events.length > 0 && <section className="mt-5 border-t ui-border pt-5"><div className="mb-4 flex items-center justify-between"><h3 className="signal-section-label">阶段摘要</h3>{latest?.runId && onOpenRunDetails && <button type="button" onClick={() => onOpenRunDetails(latest.runId)} className="rounded-lg border border-[var(--app-accent)]/40 px-2 py-1 text-[11px] ui-accent hover:bg-[var(--app-accent)]/10">查看详情</button>}</div><ol className="signal-timeline space-y-0">{events.map((event, index) => <li key={event.id} className="signal-timeline-item relative flex gap-3 pb-5 last:pb-0"><span className={`signal-timeline-dot relative z-10 mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full ${statusColor[event.status]} ${index === events.length - 1 && !['completed', 'failed', 'cancelled'].includes(event.status) ? 'signal-timeline-dot-current' : ''}`} />{index < events.length - 1 && <span className="signal-timeline-line" />}<div className="min-w-0"><div className="text-xs leading-5 ui-text-soft">{event.agentName && <span className="font-medium ui-accent">{event.agentName} · </span>}{event.activity}</div><div className="mt-0.5 text-[11px] ui-dim">{statusLabel[event.status]} · {new Date(event.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</div>{event.content && event.status !== 'streaming_response' && <div className="mt-1 line-clamp-2 text-[11px] leading-5 ui-muted">{event.content}</div>}</div></li>)}</ol></section>}
      </> : <div className="mt-5 border-t ui-border pt-5 text-xs leading-5 ui-dim">尚未开始；执行后这里会显示当前动作、步骤和结果。</div>}
    </>}
  </aside>;
}

function Identity({ title, subtitle, mark }: { title: string; subtitle: string; mark: string }) {
  return <div className="signal-inspector-summary mb-6 flex items-center gap-3 p-3"><span className="grid h-9 w-9 place-items-center rounded-xl bg-[var(--app-accent)] text-sm font-semibold text-white">{mark}</span><div className="min-w-0"><div className="truncate text-sm font-medium ui-text">{title}</div><div className="mt-0.5 truncate text-xs ui-muted">{subtitle}</div></div></div>;
}

function Stat({ label, value, title }: { label: string; value: string; title?: string }) { return <div className="flex items-center justify-between gap-3 border-b ui-border py-1.5 last:border-b-0" title={title}><span className="ui-dim">{label}</span><span className="text-right font-medium ui-text">{value}</span></div>; }
function formatTokens(value: number | undefined, source?: 'structured' | 'database_delta' | 'unavailable'): string { return source === 'unavailable' ? '不可用' : value === undefined ? '未提供' : value >= 1000 ? `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(value); }
function formatFiles(files: { added: number; removed: number; changed: number; observed: boolean }): string { return !files.observed ? '未记录' : files.added === 0 && files.removed === 0 && files.changed === 0 ? '无文件变更' : `+${files.added} -${files.removed}${files.changed ? ` ~${files.changed}` : ''}`; }
function usageTitle(source?: 'structured' | 'database_delta' | 'unavailable', provider?: string): string | undefined { if (!source) return undefined; const sourceLabel = source === 'structured' ? '结构化事件' : source === 'database_delta' ? '数据库增量' : 'Provider 未提供'; return `${provider ? `${provider} · ` : ''}${sourceLabel}`; }
function formatDuration(value: number | undefined): string { if (value === undefined) return '未提供'; if (value < 1000) return `${(value / 1000).toFixed(1)}s`; const seconds = Math.round(value / 1000); return seconds >= 60 ? `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`; }
function toolIcon(name: string): string { return /read/i.test(name) ? '📄' : /edit|write|patch|change/i.test(name) ? '🔧' : '▶'; }
function actionTone(state: 'working' | 'completed' | 'failed' | 'cancelled' | 'waiting'): string { return state === 'completed' ? 'var(--app-success)' : state === 'failed' ? 'var(--app-danger)' : state === 'cancelled' ? 'var(--app-dim)' : state === 'waiting' ? 'var(--app-info)' : 'var(--app-accent)'; }
function runStatusLabel(status: AgentRun['status']): string { return status === 'queued' ? '排队中' : status === 'running' ? '执行中' : status === 'waiting_user' ? '等待补充' : status === 'completed' ? '已完成' : status === 'cancelled' ? '已取消' : '失败'; }
function statusColorForRun(status: AgentRun['status']): string { return status === 'completed' ? 'var(--app-success)' : status === 'failed' ? 'var(--app-danger)' : status === 'waiting_user' ? 'var(--app-info)' : status === 'cancelled' ? 'var(--app-dim)' : 'var(--app-accent)'; }
