import type { AgentExecution, AgentProfile, ExecutionEvent, ExecutionStatus } from '@agentos/shared';

type VisibleExecutionEvent = ExecutionEvent & { agentId?: string; agentName?: string };

const statusLabel: Record<ExecutionStatus, string> = { queued: '排队中', preparing_context: '准备上下文', running_cli: '调用 CLI', streaming_response: '生成回复', completed: '完成', failed: '失败', cancelled: '已取消' };
const statusColor: Record<ExecutionStatus, string> = { queued: 'bg-[var(--app-dim)]', preparing_context: 'bg-[var(--app-info)]', running_cli: 'bg-[var(--app-warning)]', streaming_response: 'bg-[var(--app-accent)]', completed: 'bg-[var(--app-success)]', failed: 'bg-[var(--app-danger)]', cancelled: 'bg-[var(--app-dim)]' };

interface ExecutionInspectorProps {
  agent?: AgentProfile;
  groupTitle?: string;
  events: VisibleExecutionEvent[];
  executions: AgentExecution[];
  activeStatus?: ExecutionStatus;
  onEdit?(): void;
}

export function ExecutionInspector({ agent, groupTitle, events, executions, activeStatus, onEdit }: ExecutionInspectorProps) {
  const latest = executions[0];
  const status = activeStatus ?? latest?.status;
  const elapsed = latest?.startedAt ? Math.max(0, Math.round((Date.now() - new Date(latest.startedAt).getTime()) / 1000)) : 0;
  const permissions = agent?.permissions ?? [];

  return <aside className="inspector-sidebar ui-panel w-64 shrink-0 overflow-y-auto border-l px-4 py-5">
    <div className="mb-6 flex items-center justify-between"><h2 className="text-sm font-semibold ui-text">执行状态</h2>{agent && <button type="button" onClick={onEdit} className="ui-button-ghost rounded-lg px-2 py-1 text-xs">编辑身份</button>}</div>
    {groupTitle ? <div className="mb-6 flex items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-xl bg-[var(--app-info)] text-sm font-semibold text-white">群</span><div className="min-w-0"><div className="truncate text-sm font-medium ui-text">{groupTitle}</div><div className="mt-0.5 text-xs ui-muted">群聊协作</div></div></div> : agent ? <>
      <div className="mb-6 flex items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-xl bg-[var(--app-accent)] text-sm font-semibold text-white">{agent.name.slice(0, 1)}</span><div className="min-w-0"><div className="truncate text-sm font-medium ui-text">{agent.name}</div><div className="mt-0.5 truncate text-xs ui-muted">{agent.roleTitle}</div></div></div>
      <section className="mb-6"><h3 className="mb-3 text-[11px] font-medium tracking-[0.14em] ui-dim">PERMISSIONS</h3><div className="space-y-2 text-xs ui-text-soft">{(['read', 'write', 'review'] as const).map(permission => <div key={permission} className="flex items-center gap-2"><span className={`grid h-4 w-4 place-items-center rounded-full text-[10px] ${permissions.includes(permission) ? 'bg-[color:var(--app-success)]/20 text-[var(--app-success)]' : 'bg-[var(--app-surface-soft)] ui-dim'}`}>{permissions.includes(permission) ? '✓' : '·'}</span>{permission === 'read' ? '读取项目文件' : permission === 'write' ? '修改项目文件' : '代码审查'}</div>)}</div></section>
    </> : <div className="text-sm leading-6 ui-dim">选择一个 Agent 或群聊查看执行状态。</div>}
    {(agent || groupTitle) && <><section className="border-t ui-border pt-5"><div className="mb-4 flex items-center justify-between"><h3 className="text-[11px] font-medium tracking-[0.14em] ui-dim">TIMELINE</h3>{status && <span className="text-xs ui-muted">{statusLabel[status]}</span>}</div>{events.length > 0 ? <ol className="space-y-0">{events.map((event, index) => <li key={event.id} className="relative flex gap-3 pb-5 last:pb-0"><span className={`relative z-10 mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full ring-4 ring-[var(--app-surface)] ${statusColor[event.status]}`} />{index < events.length - 1 && <span className="absolute left-[5px] top-3 h-full w-px bg-[var(--app-border)]" />}<div className="min-w-0"><div className="text-xs leading-5 ui-text-soft">{event.agentName && <span className="font-medium ui-accent">{event.agentName} · </span>}{event.activity}</div><div className="mt-0.5 text-[11px] ui-dim">{statusLabel[event.status]} · {new Date(event.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</div>{event.content && event.status !== 'streaming_response' && <div className="mt-1 line-clamp-2 text-[11px] leading-5 ui-muted">{event.content}</div>}</div></li>)}</ol> : <div className="rounded-xl border border-dashed ui-border p-4 text-xs leading-5 ui-dim">发送消息后，这里会显示执行进度与结果。</div>}</section>{latest?.startedAt && <div className="mt-6 border-t ui-border pt-4 text-xs ui-muted">已用时间<span className="ml-2 font-medium ui-text-soft">{String(Math.floor(elapsed / 60)).padStart(2, '0')}:{String(elapsed % 60).padStart(2, '0')}</span></div>}</>}
  </aside>;
}
