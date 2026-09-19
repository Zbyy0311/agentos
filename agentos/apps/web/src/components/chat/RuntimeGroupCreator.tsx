'use client';

import { useState } from 'react';
import type { ThinkingEffort } from '@agentos/shared';
import type { AgentSummary } from './DirectConversationWorkbench';
import { getGroupMemberModelOptions, getGroupMemberThinkingEfforts, THINKING_EFFORT_LABELS } from '../../lib/groupMemberSettings';
import { CompactSelect } from './CompactSelect';

export interface RuntimeGroupMemberCreateSettings {
  readonly agentId: string;
  readonly roleTitle?: string;
  readonly model?: string;
  readonly thinkingEffort?: ThinkingEffort;
  readonly additionalInstructions?: string;
}

export interface RuntimeGroupCreateInput {
  readonly title: string;
  readonly memberAgentIds: readonly string[];
  readonly members?: readonly RuntimeGroupMemberCreateSettings[];
}

interface RuntimeGroupCreatorProps {
  readonly agents: readonly AgentSummary[];
  readonly error?: string;
  readonly onClose: () => void;
  readonly onCreate: (input: RuntimeGroupCreateInput) => Promise<unknown> | void;
}

/**
 * Creates only canonical runtime groups. Legacy group settings intentionally do
 * not appear here: runtime groups use the bounded sequential driver and the
 * runtime ConversationRepository end to end.
 */
export function RuntimeGroupCreator(props: RuntimeGroupCreatorProps) {
  const enabledAgents = props.agents;
  const [title, setTitle] = useState('新建运行时群聊');
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(
    () => new Set(enabledAgents.map(agent => agent.id)),
  );
  const [roleTitles, setRoleTitles] = useState<Record<string, string>>({});
  const [models, setModels] = useState<Record<string, string>>({});
  const [efforts, setEfforts] = useState<Record<string, string>>({});
  const [instructions, setInstructions] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const toggleAgent = (agentId: string) => {
    setSelectedAgentIds(current => {
      const next = new Set(current);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  };

  const canSubmit = !submitting && title.trim().length > 0 && selectedAgentIds.size >= 2;
  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const selectedAgents = enabledAgents.filter(agent => selectedAgentIds.has(agent.id));
      const memberAgentIds = selectedAgents.map(agent => agent.id);
      const members = selectedAgents.map(agent => {
        const model = models[agent.id]?.trim();
        const thinkingEffort = efforts[agent.id] as ThinkingEffort | undefined;
        const additionalInstructions = instructions[agent.id]?.trim();
        return {
          agentId: agent.id,
          ...(roleTitles[agent.id]?.trim() ? { roleTitle: roleTitles[agent.id].trim() } : {}),
          ...(model ? { model } : {}),
          ...(thinkingEffort ? { thinkingEffort } : {}),
          ...(additionalInstructions ? { additionalInstructions } : {}),
        };
      });
      await props.onCreate({ title: title.trim(), memberAgentIds, members });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[var(--app-overlay)] p-4 backdrop-blur-sm sm:p-6">
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="runtime-group-creator-title"
        onSubmit={event => { event.preventDefault(); void submit(); }}
        className="ui-panel-raised max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border p-5 shadow-[var(--app-shadow)] sm:p-6"
      >
        <div className="ui-modal-sticky-header mb-5 flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium tracking-[0.16em] ui-accent">RUNTIME GROUP</p>
            <h2 id="runtime-group-creator-title" className="mt-2 text-lg font-semibold ui-text">创建运行时群聊</h2>
          </div>
          <button type="button" onClick={props.onClose} className="ui-button-ghost rounded-lg px-2 py-1 text-sm">关闭</button>
        </div>

        <label className="block text-sm ui-text-soft" htmlFor="runtime-group-title">
          群聊名称
          <input
            id="runtime-group-title"
            value={title}
            onChange={event => setTitle(event.target.value)}
            className="ui-input mt-2 w-full rounded-xl px-3 py-2 text-sm outline-none"
          />
        </label>

        <fieldset className="mt-5">
        <legend className="text-sm ui-text-soft">运行时成员与独立参数</legend>
          <p className="mt-1 text-xs ui-muted">模型和思考强度只对本群聊生效；留空表示继承该 Agent 的默认值。</p>
          <div className="mt-2 space-y-3">
            {enabledAgents.map((agent, index) => {
              const selected = selectedAgentIds.has(agent.id);
              const model = models[agent.id] ?? '';
              const availableEfforts = getGroupMemberThinkingEfforts(agent, model || undefined);
              const modelOptions = getGroupMemberModelOptions(agent);
              const modelPickerOptions = [
                { value: '', label: '继承 Agent 默认', detail: '使用当前 Agent 的模型配置' },
                ...modelOptions.map(option => ({ value: option.id, label: option.label, detail: option.label === option.id ? undefined : option.id })),
              ];
              const effortPickerOptions = [
                { value: '', label: '继承 Agent 默认', detail: '使用当前 Agent 的思考强度' },
                ...availableEfforts.map(effort => ({ value: effort, label: THINKING_EFFORT_LABELS[effort] })),
              ];
              return (
                <div key={agent.id} className="ui-panel rounded-xl border px-3 py-3 text-sm ui-text-soft">
                  <label className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => toggleAgent(agent.id)}
                      className="accent-[var(--app-accent)]"
                    />
                    <span>{agent.name}</span>
                    {agent.status === undefined ? null : <span className="ml-auto text-xs ui-muted">{agent.status}</span>}
                    <span className="text-xs ui-muted">#{index + 1}</span>
                  </label>
                  {selected && (
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      <label className="text-xs ui-muted">
                        群聊角色标题
                        <input
                          aria-label={`${agent.name} 群聊角色标题`}
                          value={roleTitles[agent.id] ?? ''}
                          maxLength={80}
                          onChange={event => setRoleTitles(current => ({ ...current, [agent.id]: event.target.value }))}
                          placeholder="协作成员"
                          className="ui-input mt-1 w-full rounded-lg px-2 py-1.5 text-xs outline-none"
                        />
                      </label>
                      <CompactSelect
                        label="使用模型"
                        ariaLabel={`${agent.name} 使用模型`}
                        value={model}
                        options={modelPickerOptions}
                        onChange={nextModel => {
                          setModels(current => ({ ...current, [agent.id]: nextModel }));
                          const nextEfforts = getGroupMemberThinkingEfforts(agent, nextModel || undefined);
                          if (efforts[agent.id] && !nextEfforts.includes(efforts[agent.id] as ThinkingEffort)) {
                            setEfforts(current => ({ ...current, [agent.id]: '' }));
                          }
                        }}
                      />
                      <CompactSelect
                        label="思考强度"
                        ariaLabel={`${agent.name} 思考强度`}
                        value={efforts[agent.id] ?? ''}
                        options={effortPickerOptions}
                        onChange={value => setEfforts(current => ({ ...current, [agent.id]: value }))}
                      />
                      <label className="text-xs ui-muted sm:col-span-2">
                        群聊附加指令
                        <textarea
                          aria-label={`${agent.name} 群聊附加指令`}
                          value={instructions[agent.id] ?? ''}
                          onChange={event => setInstructions(current => ({ ...current, [agent.id]: event.target.value }))}
                          maxLength={4000}
                          placeholder="例如：只关注测试失败和可复现步骤"
                          className="ui-input mt-1 h-16 w-full resize-y rounded-lg px-2 py-1.5 text-xs outline-none"
                        />
                      </label>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </fieldset>

        <p className="mt-4 text-xs ui-muted">
          运行时群聊固定使用顺序回复（sequential），至少选择两个启用的 Agent。凭据、权限和 Provider 身份仍由工作区 Agent 配置管理。
        </p>
        {props.error === undefined ? null : <p role="alert" className="mt-3 text-sm text-[var(--status-danger)]">{props.error}</p>}

        <div className="ui-modal-sticky-footer flex justify-end gap-3">
          <button type="button" onClick={props.onClose} className="ui-button-secondary rounded-xl px-4 py-2 text-sm">取消</button>
          <button type="submit" disabled={!canSubmit} className="ui-button-primary rounded-xl px-4 py-2 text-sm font-medium disabled:cursor-not-allowed">
            {submitting ? '创建中…' : '创建运行时群聊'}
          </button>
        </div>
      </form>
    </div>
  );
}
