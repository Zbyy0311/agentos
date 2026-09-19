'use client';

import { useState } from 'react';
import { uiLayerClass } from '@/lib/uiLayers';
import type { ThinkingEffort } from '@agentos/shared';
import type { ForwardConversationMember } from '../../lib/directConversationClient';
import { getGroupMemberModelOptions, getGroupMemberThinkingEfforts, THINKING_EFFORT_LABELS } from '../../lib/groupMemberSettings';
import type { AgentSummary } from './DirectConversationWorkbench';
import { CompactSelect } from './CompactSelect';

export interface RuntimeGroupMemberUpdate {
  readonly memberId: string;
  readonly roleTitle: string;
  readonly model: string | null;
  readonly thinkingEffort: ThinkingEffort | null;
  readonly additionalInstructions: string | null;
}

interface RuntimeGroupSettingsProps {
  readonly agents: readonly AgentSummary[];
  readonly members: readonly ForwardConversationMember[];
  readonly saving: boolean;
  readonly error?: string;
  readonly onClose: () => void;
  readonly onSave: (members: readonly RuntimeGroupMemberUpdate[]) => Promise<boolean> | void;
}

interface RuntimeGroupMemberDraft {
  readonly memberId: string;
  readonly agentId: string;
  readonly displayName: string;
  readonly roleTitle: string;
  readonly model: string;
  readonly thinkingEffort: string;
  readonly additionalInstructions: string;
}

export function RuntimeGroupSettings(props: RuntimeGroupSettingsProps) {
  const agentMembers = props.members.filter(member => member.subjectType === 'agent' && member.removedAt === null);
  const [draft, setDraft] = useState<RuntimeGroupMemberDraft[]>(() => agentMembers.map(member => ({
    memberId: member.id,
    agentId: member.subjectId,
    displayName: member.displayNameSnapshot,
    roleTitle: member.roleTitle,
    model: member.model ?? '',
    thinkingEffort: member.thinkingEffort ?? '',
    additionalInstructions: member.additionalInstructions ?? '',
  })));
  const [submitting, setSubmitting] = useState(false);
  const agentById = new Map(props.agents.map(agent => [agent.id, agent]));
  const canSubmit = !props.saving && !submitting && draft.length >= 2 && draft.every(member => member.roleTitle.trim().length > 0);

  const update = (memberId: string, patch: Partial<RuntimeGroupMemberDraft>) => {
    setDraft(current => current.map(member => member.memberId === memberId ? { ...member, ...patch } : member));
  };

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const updates = draft.map(member => ({
        memberId: member.memberId,
        roleTitle: member.roleTitle.trim(),
        model: member.model.trim() || null,
        thinkingEffort: (member.thinkingEffort || null) as ThinkingEffort | null,
        additionalInstructions: member.additionalInstructions.trim() || null,
      }));
      await props.onSave(updates);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={`fixed inset-0 ${uiLayerClass('editor')} grid place-items-center bg-[var(--app-overlay)] p-4 backdrop-blur-sm sm:p-6`}>
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="runtime-group-settings-title"
        onSubmit={event => { event.preventDefault(); void submit(); }}
        className="ui-panel-raised max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-2xl border p-5 shadow-[var(--app-shadow)] sm:p-6"
      >
        <div className="ui-modal-sticky-header mb-5 flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium tracking-[0.16em] ui-accent">RUNTIME GROUP</p>
            <h2 id="runtime-group-settings-title" className="mt-2 text-lg font-semibold ui-text">群聊成员设置</h2>
            <p className="mt-1 text-sm ui-muted">修改从下一次群聊交互开始生效，正在运行的交互继续使用启动时冻结的配置。</p>
          </div>
          <button type="button" onClick={props.onClose} className="ui-button-ghost rounded-lg px-2 py-1 text-sm">关闭</button>
        </div>

        <div className="space-y-3">
          {draft.map(member => {
            const agent = agentById.get(member.agentId);
            const source = agent ?? {};
            const baseOptions = getGroupMemberModelOptions(source);
            const modelOptions = member.model && !baseOptions.some(option => option.id === member.model)
              ? [...baseOptions, { id: member.model, label: `当前群聊配置 · ${member.model}`, thinkingEfforts: getGroupMemberThinkingEfforts(source), defaultThinkingEffort: 'auto' as ThinkingEffort }]
              : baseOptions;
            const availableEfforts = getGroupMemberThinkingEfforts(source, member.model || undefined);
            const modelPickerOptions = [
              { value: '', label: '继承 Agent 默认', detail: '使用当前 Agent 的模型配置' },
              ...modelOptions.map(option => ({ value: option.id, label: option.label, detail: option.label === option.id ? undefined : option.id })),
            ];
            const effortPickerOptions = [
              { value: '', label: '继承 Agent 默认', detail: '使用当前 Agent 的思考强度' },
              ...availableEfforts.map(effort => ({ value: effort, label: THINKING_EFFORT_LABELS[effort] })),
            ];
            return (
              <section key={member.memberId} className="ui-panel rounded-xl border px-3 py-3">
                <div className="flex items-center justify-between gap-3 text-sm ui-text-soft">
                  <span>{agent?.name ?? member.displayName}</span>
                  <span className="text-xs ui-muted">{member.agentId}</span>
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <label className="text-xs ui-muted">
                    群聊角色标题
                    <input
                      aria-label={`${member.displayName} 群聊角色标题`}
                      value={member.roleTitle}
                      maxLength={80}
                      onChange={event => update(member.memberId, { roleTitle: event.target.value })}
                      className="ui-input mt-1 w-full rounded-lg px-2 py-1.5 text-xs outline-none"
                    />
                  </label>
                  <CompactSelect
                    label="使用模型"
                    ariaLabel={`${member.displayName} 使用模型`}
                    value={member.model}
                    options={modelPickerOptions}
                    onChange={nextModel => {
                      const nextEfforts = getGroupMemberThinkingEfforts(source, nextModel || undefined);
                      update(member.memberId, {
                        model: nextModel,
                        ...(member.thinkingEffort && !nextEfforts.includes(member.thinkingEffort as ThinkingEffort) ? { thinkingEffort: '' } : {}),
                      });
                    }}
                  />
                  <CompactSelect
                    label="思考强度"
                    ariaLabel={`${member.displayName} 思考强度`}
                    value={member.thinkingEffort}
                    options={effortPickerOptions}
                    onChange={value => update(member.memberId, { thinkingEffort: value })}
                  />
                  <label className="text-xs ui-muted sm:col-span-2">
                    群聊附加指令
                    <textarea
                      aria-label={`${member.displayName} 群聊附加指令`}
                      value={member.additionalInstructions}
                      maxLength={4000}
                      onChange={event => update(member.memberId, { additionalInstructions: event.target.value })}
                      placeholder="留空表示不增加群聊专属指令"
                      className="ui-input mt-1 h-16 w-full resize-y rounded-lg px-2 py-1.5 text-xs outline-none"
                    />
                  </label>
                </div>
              </section>
            );
          })}
        </div>

        <p className="mt-4 text-xs ui-muted">保存使用设置版本校验。若其他人已修改群聊设置，本次保存会被拒绝，请刷新后重新编辑。</p>
        {props.error === undefined ? null : <p role="alert" className="mt-3 text-sm text-[var(--status-danger)]">{props.error}</p>}
        <div className="ui-modal-sticky-footer flex justify-end gap-3">
          <button type="button" onClick={props.onClose} className="ui-button-secondary rounded-xl px-4 py-2 text-sm">取消</button>
          <button type="submit" disabled={!canSubmit} className="ui-button-primary rounded-xl px-4 py-2 text-sm font-medium disabled:cursor-not-allowed">
            {props.saving || submitting ? '保存中…' : '保存成员设置'}
          </button>
        </div>
      </form>
    </div>
  );
}
