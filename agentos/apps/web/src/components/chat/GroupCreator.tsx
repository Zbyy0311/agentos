import { useMemo, useState } from 'react';
import type { AgentProfile, CollaborationRole, GroupDispatchMode } from '@agentos/shared';

export interface GroupCreateMember {
  agentId: string;
  roleKind: CollaborationRole;
  roleTitle: string;
  sequence: number;
}

interface GroupCreatorProps {
  agents: AgentProfile[];
  saving: boolean;
  onClose(): void;
  onCreate(input: { title: string; members: GroupCreateMember[]; dispatchMode: GroupDispatchMode }): void;
}

const ROLE_LABELS: Record<CollaborationRole, string> = {
  leader: 'Leader',
  worker: 'Worker',
  reviewer: 'Reviewer',
  specialist: 'Specialist',
};

export function GroupCreator({ agents, saving, onClose, onCreate }: GroupCreatorProps) {
  const enabled = useMemo(() => agents.filter(agent => agent.enabled), [agents]);
  const [title, setTitle] = useState('新建协作群聊');
  const [memberAgentIds, setMemberAgentIds] = useState(enabled.map(agent => agent.id));
  const [leaderAgentId, setLeaderAgentId] = useState(enabled[0]?.id ?? '');
  const [dispatchMode, setDispatchMode] = useState<GroupDispatchMode>('leader_route');
  const [roles, setRoles] = useState<Record<string, CollaborationRole>>(() => Object.fromEntries(enabled.map((agent, index) => [agent.id, index === 0 ? 'leader' : 'worker'])));
  const [roleTitles, setRoleTitles] = useState<Record<string, string>>(() => Object.fromEntries(enabled.map(agent => [agent.id, agent.roleTitle])));

  const toggle = (id: string) => {
    setMemberAgentIds(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id]);
  };

  const setRole = (id: string, roleKind: CollaborationRole) => {
    setRoles(current => {
      const next = { ...current, [id]: roleKind };
      if (roleKind === 'leader') {
        for (const memberId of memberAgentIds) if (memberId !== id && next[memberId] === 'leader') next[memberId] = 'worker';
      }
      return next;
    });
    if (roleKind === 'leader') setLeaderAgentId(id);
  };

  const applyStandardTeam = () => {
    const codex = enabled.find(agent => agent.role === 'codex');
    const kimi = enabled.find(agent => agent.role === 'kimi');
    const reviewer = enabled.find(agent => agent.role === 'opencode');
    if (!codex || !kimi || !reviewer) return;
    setTitle('标准开发团队');
    setMemberAgentIds([codex.id, kimi.id, reviewer.id]);
    setLeaderAgentId(codex.id);
    setRoles(current => ({ ...current, [codex.id]: 'leader', [kimi.id]: 'worker', [reviewer.id]: 'reviewer' }));
    setDispatchMode('full_pipeline');
  };

  const leaderCount = memberAgentIds.filter(id => (roles[id] ?? 'worker') === 'leader').length;
  const canSubmit = !saving && title.trim().length > 0 && memberAgentIds.length >= 2 && leaderCount === 1;
  const submit = () => {
    const members = memberAgentIds.map((agentId, index) => ({
      agentId,
      roleKind: roles[agentId] ?? (agentId === leaderAgentId ? 'leader' : 'worker'),
      roleTitle: roleTitles[agentId]?.trim() || '协作成员',
      sequence: (index + 1) * 10,
    }));
    onCreate({ title: title.trim(), members, dispatchMode });
  };

  return <div className="fixed inset-0 z-50 grid place-items-center bg-[var(--app-overlay)] p-4 backdrop-blur-sm sm:p-6"><form onSubmit={event => { event.preventDefault(); if (canSubmit) submit(); }} className="ui-panel-raised max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl border p-5 shadow-[var(--app-shadow)] sm:p-6"><div className="mb-5 flex items-start justify-between"><div><p className="text-xs font-medium tracking-[0.16em] ui-accent">GROUP SETUP</p><h2 className="mt-2 text-lg font-semibold ui-text">创建协作群聊</h2></div><button type="button" onClick={onClose} className="ui-button-ghost rounded-lg px-2 py-1 text-sm">关闭</button></div><button type="button" onClick={applyStandardTeam} disabled={!enabled.some(agent => agent.role === 'codex') || !enabled.some(agent => agent.role === 'kimi') || !enabled.some(agent => agent.role === 'opencode')} className="mb-5 w-full rounded-xl border border-[color:var(--app-accent)]/40 bg-[var(--app-accent-soft)] px-3 py-3 text-left text-sm ui-text transition hover:border-[var(--app-accent)] disabled:cursor-not-allowed disabled:opacity-50"><span className="font-medium">标准开发团队</span><span className="mt-1 block text-xs ui-muted">Codex 规划 → Kimi 执行 → OpenCode 审查</span></button><label className="block text-sm ui-text-soft">群聊名称<input value={title} onChange={event => setTitle(event.target.value)} className="ui-input mt-2 w-full rounded-xl px-3 py-2 text-sm outline-none" /></label><label className="mt-4 block text-sm ui-text-soft">调度策略<select value={dispatchMode} onChange={event => setDispatchMode(event.target.value as GroupDispatchMode)} className="ui-input mt-2 w-full rounded-xl px-3 py-2 text-sm outline-none"><option value="leader_route">Leader 路由（默认）</option><option value="full_pipeline">完整流水线</option><option value="mentioned_only">仅 @Agent</option></select></label><fieldset className="mt-5"><legend className="text-sm ui-text-soft">成员与显式角色</legend><div className="mt-2 space-y-2">{enabled.map((agent, index) => { const selected = memberAgentIds.includes(agent.id); return <div key={agent.id} className="ui-panel rounded-xl border px-3 py-2 text-sm ui-text-soft"><div className="flex items-center gap-3"><input type="checkbox" checked={selected} onChange={() => toggle(agent.id)} className="accent-[var(--app-accent)]" />{agent.name}<span className="ml-auto text-xs ui-muted">#{index + 1}</span></div>{selected && <div className="mt-2 grid gap-2 sm:grid-cols-2"><select value={roles[agent.id] ?? 'worker'} onChange={event => setRole(agent.id, event.target.value as CollaborationRole)} className="ui-input rounded-lg px-2 py-1 text-xs outline-none">{Object.entries(ROLE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><input value={roleTitles[agent.id] ?? ''} onChange={event => setRoleTitles(current => ({ ...current, [agent.id]: event.target.value }))} placeholder="角色标题" className="ui-input rounded-lg px-2 py-1 text-xs outline-none" /></div>}</div>; })}</div></fieldset><p className="mt-3 text-xs ui-muted">必须选择至少两个成员，并且只能有一个 Leader。Provider 只代表运行时，不会自动推断角色。</p><div className="mt-6 flex justify-end gap-3"><button type="button" onClick={onClose} className="ui-button-secondary rounded-xl px-4 py-2 text-sm">取消</button><button disabled={!canSubmit} className="ui-button-primary rounded-xl px-4 py-2 text-sm font-medium disabled:cursor-not-allowed">{saving ? '创建中…' : '创建群聊'}</button></div></form></div>;
}
