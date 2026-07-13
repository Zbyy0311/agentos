import type { AgentExecution, AgentProfile, ExecutionEvent, ExecutionStatus } from '@agentos/shared';

const statusLabel: Record<ExecutionStatus, string> = {
  queued: '排队中', preparing_context: '准备上下文', running_cli: '调用 CLI', streaming_response: '生成回复', completed: '完成', failed: '失败', cancelled: '已取消',
};

const statusColor: Record<ExecutionStatus, string> = {
  queued: 'bg-slate-500', preparing_context: 'bg-blue-500', running_cli: 'bg-amber-400', streaming_response: 'bg-blue-500', completed: 'bg-emerald-500', failed: 'bg-red-500', cancelled: 'bg-slate-500',
};

interface ExecutionInspectorProps {
  agent?: AgentProfile;
  groupTitle?: string;
  events: ExecutionEvent[];
  executions: AgentExecution[];
  activeStatus?: ExecutionStatus;
  onEdit?(): void;
}

export function ExecutionInspector({ agent, groupTitle, events, executions, activeStatus, onEdit }: ExecutionInspectorProps) {
  const latest = executions[0];
  const status = activeStatus ?? latest?.status;
  const elapsed = latest?.startedAt ? Math.max(0, Math.round((Date.now() - new Date(latest.startedAt).getTime()) / 1000)) : 0;
  const permissions = agent?.permissions ?? [];

  return <aside className="w-64 shrink-0 overflow-y-auto border-l border-slate-800/80 bg-[#0f1721] px-4 py-5">
    <div className="mb-6 flex items-center justify-between"><h2 className="text-sm font-semibold text-slate-100">执行状态</h2>{agent && <button type="button" onClick={onEdit} className="text-xs text-slate-500 transition hover:text-slate-200">编辑身份</button>}</div>
    {groupTitle ? <div className="mb-6 flex items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-full bg-violet-600 text-sm font-semibold text-white">群</span><div className="min-w-0"><div className="truncate text-sm font-medium text-slate-100">{groupTitle}</div><div className="mt-0.5 text-xs text-slate-500">群聊协作</div></div></div> : agent ? <>
      <div className="mb-6 flex items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-full bg-blue-600 text-sm font-semibold text-white">{agent.name.slice(0, 1)}</span><div className="min-w-0"><div className="truncate text-sm font-medium text-slate-100">{agent.name}</div><div className="mt-0.5 truncate text-xs text-slate-500">{agent.roleTitle}</div></div></div>
      <section className="mb-6"><h3 className="mb-3 text-[11px] font-medium uppercase tracking-[0.15em] text-slate-500">权限</h3><div className="space-y-2 text-xs text-slate-300">
        {(['read', 'write', 'review'] as const).map(permission => <div key={permission} className="flex items-center gap-2"><span className={`grid h-4 w-4 place-items-center rounded-full text-[10px] ${permissions.includes(permission) ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-600'}`}>{permissions.includes(permission) ? '✓' : '–'}</span>{permission === 'read' ? '读取项目文件' : permission === 'write' ? '修改项目文件' : '代码审查'}</div>)}
      </div></section>
    </> : <div className="text-sm leading-6 text-slate-600">选择一个 Agent 或群聊查看执行状态。</div>}
    {(agent || groupTitle) && <><section className="border-t border-slate-800/80 pt-5"><div className="mb-4 flex items-center justify-between"><h3 className="text-[11px] font-medium uppercase tracking-[0.15em] text-slate-500">状态时间线</h3>{status && <span className="text-xs text-slate-400">{statusLabel[status]}</span>}</div>
      {events.length > 0 ? <ol className="space-y-0">{events.map((event, index) => <li key={event.id} className="relative flex gap-3 pb-5 last:pb-0"><span className={`relative z-10 mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full ring-4 ring-[#0f1721] ${statusColor[event.status]}`} />{index < events.length - 1 && <span className="absolute left-[5px] top-3 h-full w-px bg-slate-800" />}<div className="min-w-0"><div className="text-xs leading-5 text-slate-200">{event.activity}</div><div className="mt-0.5 text-[11px] text-slate-600">{statusLabel[event.status]} · {new Date(event.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</div>{event.content && event.status !== 'streaming_response' && <div className="mt-1 line-clamp-2 text-[11px] leading-5 text-slate-500">{event.content}</div>}</div></li>)}</ol> : <div className="rounded-xl border border-dashed border-slate-800 p-4 text-xs leading-5 text-slate-600">发送消息后，这里会显示执行进度与结果。</div>}
    </section>{latest?.startedAt && <div className="mt-6 border-t border-slate-800/80 pt-4 text-xs text-slate-500">已用时间<span className="ml-2 font-medium text-slate-300">{String(Math.floor(elapsed / 60)).padStart(2, '0')}:{String(elapsed % 60).padStart(2, '0')}</span></div>}</>}
  </aside>;
}
