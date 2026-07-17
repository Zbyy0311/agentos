import type { AgentProfile, Conversation, ExecutionStatus } from '@agentos/shared';
import type { MouseEvent } from 'react';
import { ThemeToggle } from '@/components/theme/ThemeToggle';

const avatarColors = ['bg-[var(--app-accent)]', 'bg-[var(--app-info)]', 'bg-[var(--app-success)]', 'bg-[var(--app-warning)]'];

interface AgentListProps {
  agents: AgentProfile[];
  panelWidth?: number;
  selectedAgentId: string | null;
  activeStatus?: ExecutionStatus;
  groups: Conversation[];
  selectedGroupId: string | null;
  onSelect(agentId: string): void;
  onSelectGroup(groupId: string): void;
  onCreateGroup(): void;
  onContextMenu(conversationId: string, event: MouseEvent<HTMLButtonElement>): void;
  onBackToWorkspace(): void;
  onOpenMemories(): void;
  onOpenPreferences(): void;
}

export function AgentList({ agents, panelWidth, selectedAgentId, activeStatus, groups, selectedGroupId, onSelect, onSelectGroup, onCreateGroup, onContextMenu, onBackToWorkspace, onOpenMemories, onOpenPreferences }: AgentListProps) {
  return <aside data-signal-agent-rail className="workspace-sidebar signal-rail ui-panel flex w-60 shrink-0 flex-col overflow-y-auto border-r px-3 py-4" style={panelWidth === undefined ? undefined : { width: `${panelWidth}px` }}>
    <div className="mb-6 px-2">
      <div className="flex items-center justify-between gap-2">
        <div className="signal-mark grid h-8 w-8 place-items-center rounded-lg bg-[var(--app-accent)] text-[11px] font-bold text-white">A/</div>
        <div className="workspace-theme-label"><ThemeToggle /></div>
      </div>
      <div className="workspace-copy mt-4 text-base font-semibold tracking-tight ui-text">AgentOS</div>
      <div className="workspace-copy mt-1 text-xs leading-5 ui-muted">当前工作区的协作成员</div>
      <button type="button" onClick={onBackToWorkspace} className="workspace-return-label ui-button-ghost mt-4 rounded-lg border ui-border px-2.5 py-1.5 text-xs hover:border-[var(--app-accent)]">← 返回工作区</button>
    </div>

    <div className="workspace-nav-label signal-section-label mb-2 px-2">AGENTS</div>
    <div className="space-y-1">
      {agents.map((agent, index) => {
        const selected = agent.id === selectedAgentId;
        const active = selected && activeStatus && !['completed', 'failed', 'cancelled'].includes(activeStatus);
        return <button type="button" key={agent.id} onClick={() => onSelect(agent.id)} className={`workspace-agent-button signal-agent-button flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition ${selected ? 'ui-selected' : 'ui-button-ghost'}`}>
          <span className={`relative grid h-9 w-9 shrink-0 place-items-center rounded-xl text-sm font-semibold text-white ${avatarColors[index % avatarColors.length]}`}>
            {agent.name.slice(0, 1).toUpperCase()}
            <span className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--app-surface)] ${active ? 'bg-[var(--app-warning)]' : agent.enabled ? 'bg-[var(--app-success)]' : 'bg-[var(--app-dim)]'}`} />
          </span>
          <span className="workspace-agent-copy min-w-0 flex-1"><span className="block truncate text-sm font-medium">{agent.name}</span><span className="mt-0.5 block truncate text-xs ui-muted">{agent.roleTitle}</span></span>
        </button>;
      })}
      {agents.length === 0 && <div className="workspace-copy px-2 py-3 text-xs leading-5 ui-dim">暂无可用 Agent</div>}
    </div>

    <div className="mt-8 border-t ui-border pt-5">
      <div className="workspace-nav-label signal-section-label mb-2 flex items-center justify-between px-2"><span>GROUPS</span><button type="button" onClick={onCreateGroup} className="ui-button-ghost rounded-md px-1.5 text-base font-normal">+</button></div>
      <div className="space-y-1">
        {groups.map(group => <button type="button" key={group.id} aria-label={group.title} title={group.title} onClick={() => onSelectGroup(group.id)} onContextMenu={event => onContextMenu(group.id, event)} className={`workspace-group-button w-full truncate rounded-lg px-3 py-2 text-left text-sm transition ${selectedGroupId === group.id ? 'ui-selected' : 'ui-button-ghost'}`}>⌘ <span className="workspace-group-copy ml-1">{group.title}</span></button>)}
        {groups.length === 0 && <div className="workspace-copy rounded-lg px-3 py-2 text-xs leading-5 ui-dim">点击 + 创建协作群聊</div>}
      </div>
    </div>
    <div className="mt-auto space-y-2"><button type="button" aria-label="打开交互与工作偏好" title="交互与工作偏好" onClick={onOpenPreferences} className="workspace-knowledge-button w-full rounded-xl border ui-border px-3 py-2.5 text-left text-sm ui-button-ghost"><span aria-hidden="true">⚙</span> <span className="workspace-knowledge-label ml-1">交互偏好</span></button><button type="button" aria-label="打开项目知识" title="项目知识" onClick={onOpenMemories} className="workspace-knowledge-button w-full rounded-xl border ui-border px-3 py-2.5 text-left text-sm ui-button-ghost"><span aria-hidden="true">📚</span> <span className="workspace-knowledge-label ml-1">项目知识</span></button></div>
  </aside>;
}
