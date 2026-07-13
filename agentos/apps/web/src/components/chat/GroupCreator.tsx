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
  return <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/70 p-6 backdrop-blur-sm"><form onSubmit={event => { event.preventDefault(); onCreate({ title, memberAgentIds, leaderAgentId }); }} className="w-full max-w-md rounded-2xl border border-slate-700 bg-[#121a25] p-6 shadow-2xl"><div className="mb-5 flex items-center justify-between"><h2 className="text-lg font-semibold text-slate-100">创建协作群聊</h2><button type="button" onClick={onClose} className="text-sm text-slate-500 hover:text-slate-200">关闭</button></div><button type="button" onClick={applyStandardTeam} disabled={!enabled.some(agent => agent.role === 'codex') || !enabled.some(agent => agent.role === 'kimi') || !enabled.some(agent => agent.role === 'opencode')} className="mb-5 w-full rounded-lg border border-blue-500/40 bg-blue-500/10 px-3 py-3 text-left text-sm text-blue-200 transition hover:bg-blue-500/20 disabled:cursor-not-allowed disabled:border-slate-700 disabled:bg-slate-800 disabled:text-slate-500"><span className="font-medium">标准开发团队</span><span className="mt-1 block text-xs opacity-75">Codex 规划 → Kimi 执行 → OpenCode 审查 → Codex 总结</span></button><label className="block text-sm text-slate-300">群聊名称<input value={title} onChange={event => setTitle(event.target.value)} className="mt-2 w-full rounded-lg border border-slate-700 bg-[#0d131b] px-3 py-2 text-slate-100 outline-none focus:border-blue-500" /></label><fieldset className="mt-5"><legend className="text-sm text-slate-300">成员</legend><div className="mt-2 space-y-2">{enabled.map(agent => <label key={agent.id} className="flex items-center gap-3 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-200"><input type="checkbox" checked={memberAgentIds.includes(agent.id)} onChange={() => toggle(agent.id)} />{agent.name}<span className="ml-auto text-xs text-slate-500">{agent.roleTitle}</span></label>)}</div></fieldset><label className="mt-5 block text-sm text-slate-300">群主<select value={leaderAgentId} onChange={event => setLeaderAgentId(event.target.value)} className="mt-2 w-full rounded-lg border border-slate-700 bg-[#0d131b] px-3 py-2 text-slate-100 outline-none">{enabled.filter(agent => memberAgentIds.includes(agent.id)).map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label><div className="mt-6 flex justify-end gap-3"><button type="button" onClick={onClose} className="px-4 py-2 text-sm text-slate-400">取消</button><button disabled={saving || memberAgentIds.length < 2 || !memberAgentIds.includes(leaderAgentId) || !title.trim()} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:bg-slate-700">{saving ? '创建中…' : '创建群聊'}</button></div></form></div>;
}
