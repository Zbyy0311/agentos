import { useMemo, useState } from 'react';
import { uiLayerClass } from '@/lib/uiLayers';
import type { AgentProfile, CollaborationRole, GroupDispatchMode, ThinkingEffort } from '@agentos/shared';
import { getGroupMemberModelOptions, getGroupMemberThinkingEfforts, THINKING_EFFORT_LABELS } from '../../lib/groupMemberSettings';
import { CompactSelect } from './CompactSelect';

export interface GroupCreateMember {
  agentId: string;
  roleKind: CollaborationRole;
  roleTitle: string;
  sequence: number;
  model?: string;
  thinkingEffort?: ThinkingEffort;
  additionalInstructions?: string;
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

const DISPATCH_OPTIONS = [
  { value: 'leader_route', label: 'Leader 路由（默认）', detail: '由 Leader 决定下一位 Agent' },
  { value: 'full_pipeline', label: '完整流水线', detail: '按顺序执行所有成员' },
  { value: 'mentioned_only', label: '仅 @Agent', detail: '只执行被明确提及的成员' },
] satisfies ReadonlyArray<{ value: GroupDispatchMode; label: string; detail: string }>;

export function GroupCreator({ agents, saving, onClose, onCreate }: GroupCreatorProps) {
  const enabled = useMemo(() => agents.filter(agent => agent.enabled), [agents]);
  const [title, setTitle] = useState('新建协作群聊');
  const [memberAgentIds, setMemberAgentIds] = useState(enabled.map(agent => agent.id));
  const [leaderAgentId, setLeaderAgentId] = useState(enabled[0]?.id ?? '');
  const [dispatchMode, setDispatchMode] = useState<GroupDispatchMode>('leader_route');
  const [roles, setRoles] = useState<Record<string, CollaborationRole>>(() => Object.fromEntries(enabled.map((agent, index) => [agent.id, index === 0 ? 'leader' : 'worker'])));
  const [roleTitles, setRoleTitles] = useState<Record<string, string>>(() => Object.fromEntries(enabled.map(agent => [agent.id, agent.roleTitle])));
  const [models, setModels] = useState<Record<string, string>>({});
  const [efforts, setEfforts] = useState<Record<string, string>>({});
  const [instructions, setInstructions] = useState<Record<string, string>>({});

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
    const members = memberAgentIds.map((agentId, index) => {
      const model = models[agentId]?.trim();
      const thinkingEffort = efforts[agentId] as ThinkingEffort | undefined;
      const additionalInstructions = instructions[agentId]?.trim();
      return {
        agentId,
        roleKind: roles[agentId] ?? (agentId === leaderAgentId ? 'leader' : 'worker'),
        roleTitle: roleTitles[agentId]?.trim() || '协作成员',
        sequence: (index + 1) * 10,
        ...(model ? { model } : {}),
        ...(thinkingEffort ? { thinkingEffort } : {}),
        ...(additionalInstructions ? { additionalInstructions } : {}),
      };
    });
    onCreate({ title: title.trim(), members, dispatchMode });
  };

  return <div className={`fixed inset-0 ${uiLayerClass('editor')} grid place-items-center bg-[var(--app-overlay)] p-4 backdrop-blur-sm sm:p-6`}><form role="dialog" aria-modal="true" aria-labelledby="group-creator-title" onSubmit={event => { event.preventDefault(); if (canSubmit) submit(); }} className="ui-panel-raised max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-2xl border p-5 shadow-[var(--app-shadow)] sm:p-6"><div className="ui-modal-sticky-header mb-5 flex items-start justify-between gap-4"><div><p className="text-xs font-medium tracking-[0.16em] ui-accent">GROUP SETUP</p><h2 id="group-creator-title" className="mt-2 text-lg font-semibold ui-text">创建协作群聊</h2></div><button type="button" onClick={onClose} className="ui-button-ghost rounded-lg px-2 py-1 text-sm">关闭</button></div><button type="button" onClick={applyStandardTeam} disabled={!enabled.some(agent => agent.role === 'codex') || !enabled.some(agent => agent.role === 'kimi') || !enabled.some(agent => agent.role === 'opencode')} className="mb-5 w-full rounded-xl border border-[color:var(--app-accent)]/40 bg-[var(--app-accent-soft)] px-3 py-3 text-left text-sm ui-text transition hover:border-[var(--app-accent)] disabled:cursor-not-allowed disabled:opacity-50"><span className="font-medium">标准开发团队</span><span className="mt-1 block text-xs ui-muted">Codex 规划 → Kimi 执行 → OpenCode 审查</span></button><label className="block text-sm ui-text-soft">群聊名称<input value={title} onChange={event => setTitle(event.target.value)} className="ui-input mt-2 w-full rounded-xl px-3 py-2 text-sm outline-none" /></label><div className="mt-4"><CompactSelect label="调度策略" value={dispatchMode} options={DISPATCH_OPTIONS} onChange={value => setDispatchMode(value as GroupDispatchMode)} /></div><fieldset className="mt-5"><legend className="text-sm ui-text-soft">成员与独立参数</legend><p className="mt-1 text-xs ui-muted">模型、思考强度和附加指令只对本群聊生效；留空表示继承 Agent 默认值。</p><div className="mt-2 space-y-3">{enabled.map((agent, index) => { const selected = memberAgentIds.includes(agent.id); const model = models[agent.id] ?? ''; const modelOptions = getGroupMemberModelOptions(agent); const availableEfforts = getGroupMemberThinkingEfforts(agent, model || undefined); const modelPickerOptions = [{ value: '', label: '继承 Agent 默认', detail: '使用当前 Agent 的模型配置' }, ...modelOptions.map(option => ({ value: option.id, label: option.label, detail: option.label === option.id ? undefined : option.id }))]; const effortPickerOptions = [{ value: '', label: '继承 Agent 默认', detail: '使用当前 Agent 的思考强度' }, ...availableEfforts.map(effort => ({ value: effort, label: THINKING_EFFORT_LABELS[effort] }))]; const roleOptions = Object.entries(ROLE_LABELS).map(([value, label]) => ({ value, label })); return <div key={agent.id} className="ui-panel rounded-xl border px-3 py-3 text-sm ui-text-soft"><div className="flex items-center gap-3"><input type="checkbox" checked={selected} onChange={() => toggle(agent.id)} className="accent-[var(--app-accent)]" /><span>{agent.name}</span><span className="ml-auto text-xs ui-muted">#{index + 1}</span></div>{selected && <div className="mt-3 grid gap-2 sm:grid-cols-2"><CompactSelect label="角色" value={roles[agent.id] ?? 'worker'} options={roleOptions} onChange={value => setRole(agent.id, value as CollaborationRole)} /><label className="text-xs ui-muted">角色标题<input value={roleTitles[agent.id] ?? ''} onChange={event => setRoleTitles(current => ({ ...current, [agent.id]: event.target.value }))} placeholder="角色标题" className="ui-input mt-1 w-full rounded-lg px-2 py-1.5 text-xs outline-none" /></label><CompactSelect label="使用模型" ariaLabel={`${agent.name} 使用模型`} value={model} options={modelPickerOptions} onChange={nextModel => { setModels(current => ({ ...current, [agent.id]: nextModel })); const nextEfforts = getGroupMemberThinkingEfforts(agent, nextModel || undefined); if (efforts[agent.id] && !nextEfforts.includes(efforts[agent.id] as ThinkingEffort)) setEfforts(current => ({ ...current, [agent.id]: '' })); }} /><CompactSelect label="思考强度" ariaLabel={`${agent.name} 思考强度`} value={efforts[agent.id] ?? ''} options={effortPickerOptions} onChange={value => setEfforts(current => ({ ...current, [agent.id]: value }))} /><label className="text-xs ui-muted sm:col-span-2">群聊附加指令<textarea aria-label={`${agent.name} 群聊附加指令`} value={instructions[agent.id] ?? ''} onChange={event => setInstructions(current => ({ ...current, [agent.id]: event.target.value }))} maxLength={4000} placeholder="例如：只关注测试失败和可复现步骤" className="ui-input mt-1 h-16 w-full resize-y rounded-lg px-2 py-1.5 text-xs outline-none" /></label></div>}</div>; })}</div></fieldset><p className="mt-3 text-xs ui-muted">必须选择至少两个成员，并且只能有一个 Leader。Provider、凭据和权限仍由工作区 Agent 配置管理。</p><div className="ui-modal-sticky-footer flex justify-end gap-3"><button type="button" onClick={onClose} className="ui-button-secondary rounded-xl px-4 py-2 text-sm">取消</button><button disabled={!canSubmit} className="ui-button-primary rounded-xl px-4 py-2 text-sm font-medium disabled:cursor-not-allowed">{saving ? '创建中…' : '创建群聊'}</button></div></form></div>;
}
