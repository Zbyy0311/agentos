import type { AgentProfile, Conversation, ExecutionStatus } from '@agentos/shared';
import type { MouseEvent } from 'react';

const avatarColors = ['bg-blue-600', 'bg-violet-600', 'bg-emerald-600', 'bg-amber-600'];

interface AgentListProps {
  agents: AgentProfile[];
  selectedAgentId: string | null;
  activeStatus?: ExecutionStatus;
  groups: Conversation[];
  selectedGroupId: string | null;
  onSelect(agentId: string): void;
  onSelectGroup(groupId: string): void;
  onCreateGroup(): void;
  onContextMenu(conversationId: string, event: MouseEvent<HTMLButtonElement>): void;
  onBackToWorkspace(): void;
}

export function AgentList({ agents, selectedAgentId, activeStatus, groups, selectedGroupId, onSelect, onSelectGroup, onCreateGroup, onContextMenu, onBackToWorkspace }: AgentListProps) {
  return <aside className="w-52 shrink-0 overflow-y-auto border-r border-slate-800/80 bg-[#0f1721] px-3 py-4">
    <div className="mb-6 px-2">
      <div className="text-lg font-semibold tracking-tight text-slate-100">AgentOS</div>
      <div className="mt-1 text-xs text-slate-500">当前工作区的协作成员</div>
      <button type="button" onClick={onBackToWorkspace} className="mt-3 text-xs text-blue-400 transition hover:text-blue-300">← 返回工作区</button>
    </div>
    <div className="mb-2 px-2 text-[11px] font-medium uppercase tracking-[0.16em] text-slate-500">智能体</div>
    <div className="space-y-1">
      {agents.map((agent, index) => {
        const selected = agent.id === selectedAgentId;
        const active = selected && activeStatus && !['completed', 'failed', 'cancelled'].includes(activeStatus);
        return <button type="button" key={agent.id} onClick={() => onSelect(agent.id)} className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition ${selected ? 'bg-slate-800/90 text-white ring-1 ring-slate-700' : 'text-slate-300 hover:bg-slate-800/60'}`}>
          <span className={`relative grid h-9 w-9 shrink-0 place-items-center rounded-full text-sm font-semibold text-white ${avatarColors[index % avatarColors.length]}`}>
            {agent.name.slice(0, 1).toUpperCase()}
            <span className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[#0f1721] ${active ? 'bg-amber-400' : agent.enabled ? 'bg-emerald-400' : 'bg-slate-600'}`} />
          </span>
          <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{agent.name}</span><span className="mt-0.5 block truncate text-xs text-slate-500">{agent.roleTitle}</span></span>
        </button>;
      })}
      {agents.length === 0 && <div className="px-2 py-3 text-xs leading-5 text-slate-600">暂无可用 Agent</div>}
    </div>
    <div className="mt-8 border-t border-slate-800/80 pt-5">
      <div className="mb-2 flex items-center justify-between px-2 text-[11px] font-medium uppercase tracking-[0.16em] text-slate-500"><span>团队分组</span><button type="button" onClick={onCreateGroup} className="text-base font-normal hover:text-slate-200">+</button></div>
      <div className="space-y-1">
        {groups.map(group => <button type="button" key={group.id} onClick={() => onSelectGroup(group.id)} onContextMenu={event => onContextMenu(group.id, event)} className={`w-full truncate rounded-lg px-3 py-2 text-left text-sm transition ${selectedGroupId === group.id ? 'bg-slate-800 text-slate-100' : 'text-slate-500 hover:bg-slate-800/70 hover:text-slate-300'}`}>👥 {group.title}</button>)}
        {groups.length === 0 && <div className="rounded-lg px-3 py-2 text-xs leading-5 text-slate-600">点击 + 创建协作群聊</div>}
      </div>
    </div>
  </aside>;
}
