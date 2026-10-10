import { useMemo, useState } from 'react';
import { uiLayerClass } from '@/lib/uiLayers';
import type { AgentProfile, GroupDispatchMode } from '@agentos/shared';

export interface GroupCreateMember {
  agentId: string;
}

interface GroupCreatorProps {
  agents: AgentProfile[];
  saving: boolean;
  onClose(): void;
  onCreate(input: { title: string; members: GroupCreateMember[]; dispatchMode: GroupDispatchMode }): void;
}

/**
 * Group creation deliberately has one small decision: who participates.
 * Member model, effort, order and instructions belong to the group editor so
 * creating a group never asks the user to choose an execution mode.
 */
export function GroupCreator({ agents, saving, onClose, onCreate }: GroupCreatorProps) {
  const enabled = useMemo(() => agents.filter(agent => agent.enabled), [agents]);
  const [title, setTitle] = useState('新建群聊');
  const [memberAgentIds, setMemberAgentIds] = useState(enabled.map(agent => agent.id));

  const toggle = (id: string) => {
    setMemberAgentIds(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id]);
  };

  const applyStandardTeam = () => {
    const team = enabled
      .filter(agent => agent.role === 'codex' || agent.role === 'kimi' || agent.role === 'opencode')
      .map(agent => agent.id);
    if (team.length >= 2) setMemberAgentIds(team);
  };

  const canSubmit = !saving && title.trim().length > 0 && memberAgentIds.length >= 2;
  const submit = () => onCreate({
    title: title.trim(),
    members: memberAgentIds.map(agentId => ({ agentId })),
      // The canonical group endpoint now always starts bounded sequential
      // discussions. Keep the legacy field for the shared form contract;
      // the server ignores it for newly created groups.
      dispatchMode: 'leader_route',
  });

  return <div className={`ui-overlay-enter fixed inset-0 ${uiLayerClass('editor')} grid place-items-center bg-[var(--app-overlay)] p-4 backdrop-blur-sm sm:p-6`}>
    <form role="dialog" aria-modal="true" aria-labelledby="group-creator-title" onSubmit={event => { event.preventDefault(); if (canSubmit) submit(); }} className="ui-panel-raised max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-2xl border p-5 shadow-[var(--app-shadow)] sm:p-6">
      <div className="ui-modal-sticky-header mb-5 flex items-start justify-between gap-4"><div><p className="text-xs font-medium tracking-[0.16em] ui-accent">GROUP SETUP</p><h2 id="group-creator-title" className="mt-2 text-lg font-semibold ui-text">创建群聊</h2><p className="mt-1 text-xs ui-muted">创建后默认按成员顺序进行一次轮流讨论。</p></div><button type="button" onClick={onClose} className="ui-button-ghost rounded-lg px-2 py-1 text-sm">关闭</button></div>
      <button type="button" onClick={applyStandardTeam} disabled={enabled.filter(agent => agent.role === 'codex' || agent.role === 'kimi' || agent.role === 'opencode').length < 2} className="mb-5 w-full rounded-xl border border-[color:var(--app-accent)]/40 bg-[var(--app-accent-soft)] px-3 py-3 text-left text-sm ui-text transition hover:border-[var(--app-accent)] disabled:cursor-not-allowed disabled:opacity-50"><span className="font-medium">使用标准开发团队</span><span className="mt-1 block text-xs ui-muted">快速选择当前工作区的 Codex、KimiCode、OpenCode</span></button>
      <label className="block text-sm ui-text-soft">群聊名称<input value={title} onChange={event => setTitle(event.target.value)} className="ui-input mt-2 w-full rounded-xl px-3 py-2 text-sm outline-none" /></label>
      <fieldset className="mt-5"><legend className="text-sm ui-text-soft">参与成员</legend><p className="mt-1 text-xs ui-muted">未指定 @Agent 时，所有已选成员各公开回复一次；发送时也可以 @ 单个成员。</p><div className="mt-3 space-y-2">{enabled.map(agent => { const selected = memberAgentIds.includes(agent.id); return <label key={agent.id} className={`flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-3 text-sm transition ${selected ? 'border-[var(--app-accent)] bg-[var(--app-accent-soft)]' : 'ui-border ui-panel'}`}><input type="checkbox" checked={selected} onChange={() => toggle(agent.id)} className="accent-[var(--app-accent)]" /><span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--app-accent-soft)] font-semibold ui-accent">{agent.name.slice(0, 1)}</span><span className="min-w-0"><span className="block ui-text">{agent.name}</span><span className="block truncate text-xs ui-muted">{agent.roleTitle}</span></span></label>; })}</div></fieldset>
      <p className="mt-4 text-xs ui-muted">模型、思考强度、角色标题、附加指令和成员顺序可在群聊设置中调整。</p>
      <div className="ui-modal-sticky-footer mt-5 flex justify-end gap-3"><button type="button" onClick={onClose} className="ui-button-secondary rounded-xl px-4 py-2 text-sm">取消</button><button disabled={!canSubmit} className="ui-button-primary rounded-xl px-4 py-2 text-sm font-medium disabled:cursor-not-allowed">{saving ? '创建中…' : '创建群聊'}</button></div>
    </form>
  </div>;
}
