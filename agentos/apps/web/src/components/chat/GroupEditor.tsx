import { useState } from 'react';
import type { AgentProfile, CollaborationRole, ConversationMember, GroupDispatchMode } from '@agentos/shared';
import { SelectField } from '../controls/SelectField';

interface GroupEditorProps {
  agents: AgentProfile[];
  members: ConversationMember[];
  dispatchMode: GroupDispatchMode;
  saving: boolean;
  onClose(): void;
  onSave(input: { members: Array<{ agentId: string; roleKind: CollaborationRole; roleTitle: string; sequence: number }>; dispatchMode: GroupDispatchMode }): void;
}

const roles: CollaborationRole[] = ['leader', 'worker', 'reviewer', 'specialist'];

export function GroupEditor({ agents, members, dispatchMode: initialDispatchMode, saving, onClose, onSave }: GroupEditorProps) {
  const [dispatchMode, setDispatchMode] = useState(initialDispatchMode);
  const [draft, setDraft] = useState(() => members.map((member, index) => ({ agentId: member.agentId, roleKind: member.roleKind ?? (member.isLeader ? 'leader' : 'worker'), roleTitle: member.roleTitle, sequence: member.sequence ?? (index + 1) * 10 })));
  const enabled = agents.filter(agent => agent.enabled);
  const validDraft = draft.length >= 2 && draft.filter(member => member.roleKind === 'leader').length === 1 && draft.every(member => Number.isInteger(member.sequence) && member.sequence > 0) && new Set(draft.map(member => member.sequence)).size === draft.length;
  const update = (agentId: string, patch: Partial<(typeof draft)[number]>) => setDraft(current => current.map(member => member.agentId === agentId ? { ...member, ...patch } : member));
  const submit = () => onSave({ members: draft, dispatchMode });
  return <div className="fixed inset-0 z-50 grid place-items-center bg-[var(--app-overlay)] p-4 backdrop-blur-sm"><div className="ui-panel-raised max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl border p-5 shadow-[var(--app-shadow)]"><div className="flex items-start justify-between"><div><p className="text-xs font-medium tracking-[0.16em] ui-accent">GROUP EDITOR</p><h2 className="mt-2 text-lg font-semibold ui-text">编辑协作策略</h2></div><button type="button" onClick={onClose} className="ui-button-ghost rounded-lg px-2 py-1 text-sm">关闭</button></div><label className="mt-5 block text-sm ui-text-soft">调度策略<div className="mt-2"><SelectField ariaLabel="调度策略" value={dispatchMode} options={[{ value: 'leader_route', label: 'Leader 路由' }, { value: 'full_pipeline', label: '完整流水线' }, { value: 'mentioned_only', label: '仅 @Agent' }]} onChange={value => setDispatchMode(value as GroupDispatchMode)} /></div></label><div className="mt-4 space-y-2">{draft.map(member => <div key={member.agentId} className="ui-panel grid gap-2 rounded-xl border p-3 sm:grid-cols-[1fr_1fr_90px]"><label className="text-xs ui-muted">成员<div className="mt-1"><SelectField size="sm" ariaLabel="成员" value={member.agentId} options={enabled.map(agent => ({ value: agent.id, label: agent.name }))} disabled onChange={() => undefined} /></div></label><label className="text-xs ui-muted">角色<div className="mt-1"><SelectField size="sm" ariaLabel="角色" value={member.roleKind} options={roles.map(role => ({ value: role, label: role }))} onChange={value => update(member.agentId, { roleKind: value as CollaborationRole })} /></div></label><label className="text-xs ui-muted">顺序<input type="number" min={1} step={1} value={member.sequence} onChange={event => update(member.agentId, { sequence: Number(event.target.value) })} className="ui-input mt-1 w-full rounded-lg px-2 py-1 text-xs outline-none" /></label><input value={member.roleTitle} onChange={event => update(member.agentId, { roleTitle: event.target.value })} placeholder="角色标题" className="ui-input rounded-lg px-2 py-1 text-xs outline-none sm:col-span-3" /></div>)}</div><p className="mt-3 text-xs ui-muted">需要恰好一个 Leader，且 sequence 必须为正整数并且唯一。</p><div className="mt-6 flex justify-end gap-3"><button type="button" onClick={onClose} className="ui-button-secondary rounded-xl px-4 py-2 text-sm">取消</button><button type="button" onClick={submit} disabled={saving || !validDraft} className="ui-button-primary rounded-xl px-4 py-2 text-sm font-medium disabled:cursor-not-allowed">{saving ? '保存中…' : '保存策略'}</button></div></div></div>;
}
