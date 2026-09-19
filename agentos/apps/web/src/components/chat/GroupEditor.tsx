import { useState } from 'react';
import type { AgentProfile, CollaborationRole, ConversationMember, GroupDispatchMode, ThinkingEffort } from '@agentos/shared';
import { getGroupMemberModelOptions, getGroupMemberThinkingEfforts, THINKING_EFFORT_LABELS } from '../../lib/groupMemberSettings';
import { CompactSelect } from './CompactSelect';

interface GroupEditorProps {
  agents: AgentProfile[];
  members: ConversationMember[];
  title: string;
  dispatchMode: GroupDispatchMode;
  saving: boolean;
  onClose(): void;
  onSave(input: {
    title: string;
    members: Array<{
      agentId: string;
      roleKind: CollaborationRole;
      roleTitle: string;
      sequence: number;
      model?: string | null;
      thinkingEffort?: ThinkingEffort | null;
      additionalInstructions?: string | null;
    }>;
    dispatchMode: GroupDispatchMode;
  }): void;
}

const roles: CollaborationRole[] = ['leader', 'worker', 'reviewer', 'specialist'];
const roleOptions = roles.map(role => ({ value: role, label: role }));
const dispatchOptions = [
  { value: 'leader_route', label: 'Leader 路由', detail: '由 Leader 决定下一位 Agent' },
  { value: 'full_pipeline', label: '完整流水线', detail: '按顺序执行所有成员' },
  { value: 'mentioned_only', label: '仅 @Agent', detail: '只执行被明确提及的成员' },
] satisfies ReadonlyArray<{ value: GroupDispatchMode; label: string; detail: string }>;

interface GroupEditorDraft {
  agentId: string;
  roleKind: CollaborationRole;
  roleTitle: string;
  sequence: number;
  model: string;
  thinkingEffort: string;
  additionalInstructions: string;
}

export function GroupEditor({ agents, members, title: initialTitle, dispatchMode: initialDispatchMode, saving, onClose, onSave }: GroupEditorProps) {
  const [title, setTitle] = useState(initialTitle);
  const [dispatchMode, setDispatchMode] = useState(initialDispatchMode);
  const [draft, setDraft] = useState<GroupEditorDraft[]>(() => members.map((member, index) => ({
    agentId: member.agentId,
    roleKind: member.roleKind ?? (member.isLeader ? 'leader' : 'worker'),
    roleTitle: member.roleTitle,
    sequence: member.sequence ?? (index + 1) * 10,
    model: member.model ?? '',
    thinkingEffort: member.thinkingEffort ?? '',
    additionalInstructions: member.additionalInstructions ?? '',
  })));
  const enabled = agents.filter(agent => agent.enabled);
  const validDraft = title.trim().length > 0
    && draft.length >= 2
    && draft.filter(member => member.roleKind === 'leader').length === 1
    && draft.every(member => Number.isInteger(member.sequence) && member.sequence > 0)
    && new Set(draft.map(member => member.sequence)).size === draft.length
    && draft.every(member => member.roleTitle.trim().length > 0);
  const update = (agentId: string, patch: Partial<GroupEditorDraft>) => setDraft(current => current.map(member => member.agentId === agentId ? { ...member, ...patch } : member));
  const submit = () => onSave({
    title: title.trim(),
    members: draft.map(member => ({
      agentId: member.agentId,
      roleKind: member.roleKind,
      roleTitle: member.roleTitle.trim(),
      sequence: member.sequence,
      model: member.model.trim() || null,
      thinkingEffort: (member.thinkingEffort || null) as ThinkingEffort | null,
      additionalInstructions: member.additionalInstructions.trim() || null,
    })),
    dispatchMode,
  });

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[var(--app-overlay)] p-4 backdrop-blur-sm">
      <div role="dialog" aria-modal="true" aria-labelledby="group-editor-title" className="ui-panel-raised max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-2xl border p-5 shadow-[var(--app-shadow)] sm:p-6">
        <div className="ui-modal-sticky-header flex items-start justify-between gap-4">
          <div><p className="text-xs font-medium tracking-[0.16em] ui-accent">GROUP EDITOR</p><h2 id="group-editor-title" className="mt-2 text-lg font-semibold ui-text">编辑群聊</h2><p className="mt-1 text-sm ui-muted">群聊名称、调度策略和成员参数在这里统一管理。</p></div>
          <button type="button" onClick={onClose} className="ui-button-ghost ui-button-ghost-danger rounded-lg px-2 py-1 text-sm">关闭</button>
        </div>
        <label className="mt-5 block max-w-md text-sm ui-text-soft" htmlFor="group-editor-group-title">群聊名称<input id="group-editor-group-title" aria-label="群聊名称" value={title} maxLength={80} onChange={event => setTitle(event.target.value)} className="ui-input mt-2 w-full rounded-xl px-3 py-2 text-sm outline-none" /></label>
        <div className="mt-4 max-w-md"><CompactSelect label="调度策略" value={dispatchMode} options={dispatchOptions} onChange={value => setDispatchMode(value as GroupDispatchMode)} /></div>
        <div className="mt-4 space-y-3">
          {draft.map(member => {
            const agent = enabled.find(item => item.id === member.agentId);
            const modelOptions = getGroupMemberModelOptions(agent ?? {});
            const availableEfforts = getGroupMemberThinkingEfforts(agent ?? {}, member.model || undefined);
            const visibleModelOptions = member.model && !modelOptions.some(option => option.id === member.model)
              ? [...modelOptions, { id: member.model, label: `当前群聊配置 · ${member.model}`, thinkingEfforts: getGroupMemberThinkingEfforts(agent ?? {}), defaultThinkingEffort: 'auto' as ThinkingEffort }]
              : modelOptions;
            const memberOptions = enabled.map(item => ({ value: item.id, label: item.name }));
            const modelPickerOptions = [
              { value: '', label: '继承 Agent 默认', detail: '使用当前 Agent 的模型配置' },
              ...visibleModelOptions.map(option => ({ value: option.id, label: option.label, detail: option.label === option.id ? undefined : option.id })),
            ];
            const effortPickerOptions = [
              { value: '', label: '继承 Agent 默认', detail: '使用当前 Agent 的思考强度' },
              ...availableEfforts.map(effort => ({ value: effort, label: THINKING_EFFORT_LABELS[effort] })),
            ];
            return <section key={member.agentId} className="ui-panel rounded-xl border p-3"><div className="grid gap-2 sm:grid-cols-[1fr_1fr_90px]"><CompactSelect label="成员" value={member.agentId} options={memberOptions} disabled /><CompactSelect label="角色" ariaLabel={`${agent?.name ?? member.agentId} 角色`} value={member.roleKind} options={roleOptions} onChange={value => update(member.agentId, { roleKind: value as CollaborationRole })} /><label className="text-xs ui-muted">顺序<input type="number" min={1} step={1} value={member.sequence} onChange={event => update(member.agentId, { sequence: Number(event.target.value) })} className="ui-input mt-1 w-full rounded-lg px-2 py-1 text-xs outline-none" /></label><label className="text-xs ui-muted sm:col-span-3">角色标题<input value={member.roleTitle} maxLength={80} onChange={event => update(member.agentId, { roleTitle: event.target.value })} placeholder="角色标题" className="ui-input mt-1 w-full rounded-lg px-2 py-1.5 text-xs outline-none" /></label><CompactSelect label="使用模型" ariaLabel={`${agent?.name ?? member.agentId} 使用模型`} value={member.model} options={modelPickerOptions} onChange={nextModel => { const nextEfforts = getGroupMemberThinkingEfforts(agent ?? {}, nextModel || undefined); update(member.agentId, { model: nextModel, ...(member.thinkingEffort && !nextEfforts.includes(member.thinkingEffort as ThinkingEffort) ? { thinkingEffort: '' } : {}) }); }} /><CompactSelect label="思考强度" ariaLabel={`${agent?.name ?? member.agentId} 思考强度`} value={member.thinkingEffort} options={effortPickerOptions} onChange={value => update(member.agentId, { thinkingEffort: value })} /><label className="text-xs ui-muted sm:col-span-2">群聊附加指令<textarea aria-label={`${agent?.name ?? member.agentId} 群聊附加指令`} value={member.additionalInstructions} maxLength={4000} onChange={event => update(member.agentId, { additionalInstructions: event.target.value })} placeholder="留空表示不增加群聊专属指令" className="ui-input mt-1 h-16 w-full resize-y rounded-lg px-2 py-1.5 text-xs outline-none" /></label></div></section>;
          })}
        </div>
        <p className="mt-3 text-xs ui-muted">需要恰好一个 Leader，且 sequence 必须为正整数并且唯一。留空的模型、思考强度和指令会清除群聊覆盖。</p>
        <div className="ui-modal-sticky-footer flex justify-end gap-3"><button type="button" onClick={onClose} className="ui-button-secondary rounded-xl px-4 py-2 text-sm">取消</button><button type="button" onClick={submit} disabled={saving || !validDraft} className="ui-button-primary rounded-xl px-4 py-2 text-sm font-medium disabled:cursor-not-allowed">{saving ? '保存中…' : '保存群聊'}</button></div>
      </div>
    </div>
  );
}
