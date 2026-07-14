import { useState } from 'react';
import type { AgentProfile } from '@agentos/shared';

interface GroupCreatorProps { agents: AgentProfile[]; saving: boolean; onClose(): void; onCreate(input: { title: string; memberAgentIds: string[]; leaderAgentId: string }): void; }

export function GroupCreator({ agents, saving, onClose, onCreate }: GroupCreatorProps) {
  const enabled = agents.filter(agent => agent.enabled);
  const [title, setTitle] = useState('新建协作群聊');
  const [memberAgentIds, setMemberAgentIds] = useState(enabled.map(agent => agent.id));
  const [leaderAgentId, setLeaderAgentId] = useState(enabled[0]?.id ?? '');
  const toggle = (id: string) => setMemberAgentIds(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id]);
  const applyStandardTeam = () => {
    const codex = enabled.find(agent => agent.role === 'codex');
    const kimi = enabled.find(agent => agent.role === 'kimi');
    const reviewer = enabled.find(agent => agent.role === 'opencode');
    if (!codex || !kimi || !reviewer) return;
    setTitle('标准开发团队');
    setMemberAgentIds([codex.id, kimi.id, reviewer.id]);
    setLeaderAgentId(codex.id);
  };
  return <div className="fixed inset-0 z-50 grid place-items-center bg-[var(--app-overlay)] p-4 backdrop-blur-sm sm:p-6"><form onSubmit={event => { event.preventDefault(); onCreate({ title, memberAgentIds, leaderAgentId }); }} className="ui-panel-raised w-full max-w-md rounded-2xl border p-5 shadow-[var(--app-shadow)] sm:p-6"><div className="mb-5 flex items-start justify-between"><div><p className="text-xs font-medium tracking-[0.16em] ui-accent">GROUP SETUP</p><h2 className="mt-2 text-lg font-semibold ui-text">创建协作群聊</h2></div><button type="button" onClick={onClose} className="ui-button-ghost rounded-lg px-2 py-1 text-sm">关闭</button></div><button type="button" onClick={applyStandardTeam} disabled={!enabled.some(agent => agent.role === 'codex') || !enabled.some(agent => agent.role === 'kimi') || !enabled.some(agent => agent.role === 'opencode')} className="mb-5 w-full rounded-xl border border-[color:var(--app-accent)]/40 bg-[var(--app-accent-soft)] px-3 py-3 text-left text-sm ui-text transition hover:border-[var(--app-accent)] disabled:cursor-not-allowed disabled:opacity-50"><span className="font-medium">标准开发团队</span><span className="mt-1 block text-xs ui-muted">Codex 规划 → Kimi 执行 → OpenCode 审查 → Codex 总结</span></button><label className="block text-sm ui-text-soft">群聊名称<input value={title} onChange={event => setTitle(event.target.value)} className="ui-input mt-2 w-full rounded-xl px-3 py-2 text-sm outline-none" /></label><fieldset className="mt-5"><legend className="text-sm ui-text-soft">成员</legend><div className="mt-2 space-y-2">{enabled.map(agent => <label key={agent.id} className="ui-panel flex items-center gap-3 rounded-xl border px-3 py-2 text-sm ui-text-soft"><input type="checkbox" checked={memberAgentIds.includes(agent.id)} onChange={() => toggle(agent.id)} className="accent-[var(--app-accent)]" />{agent.name}<span className="ml-auto text-xs ui-muted">{agent.roleTitle}</span></label>)}</div></fieldset><label className="mt-5 block text-sm ui-text-soft">群主<select value={leaderAgentId} onChange={event => setLeaderAgentId(event.target.value)} className="ui-input mt-2 w-full rounded-xl px-3 py-2 text-sm outline-none">{enabled.filter(agent => memberAgentIds.includes(agent.id)).map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label><div className="mt-6 flex justify-end gap-3"><button type="button" onClick={onClose} className="ui-button-secondary rounded-xl px-4 py-2 text-sm">取消</button><button disabled={saving || memberAgentIds.length < 2 || !memberAgentIds.includes(leaderAgentId) || !title.trim()} className="ui-button-primary rounded-xl px-4 py-2 text-sm font-medium disabled:cursor-not-allowed">{saving ? '创建中…' : '创建群聊'}</button></div></form></div>;
}
