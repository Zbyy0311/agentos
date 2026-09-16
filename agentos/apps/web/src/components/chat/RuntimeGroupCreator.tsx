'use client';

import { useState } from 'react';
import type { AgentSummary } from './DirectConversationWorkbench';

export interface RuntimeGroupCreateInput {
  readonly title: string;
  readonly memberAgentIds: readonly string[];
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
      const memberAgentIds = enabledAgents
        .filter(agent => selectedAgentIds.has(agent.id))
        .map(agent => agent.id);
      await props.onCreate({ title: title.trim(), memberAgentIds });
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
        className="ui-panel-raised max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl border p-5 shadow-[var(--app-shadow)] sm:p-6"
      >
        <div className="mb-5 flex items-start justify-between">
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
          <legend className="text-sm ui-text-soft">运行时成员</legend>
          <div className="mt-2 space-y-2">
            {enabledAgents.map(agent => (
              <label key={agent.id} className="ui-panel flex items-center gap-3 rounded-xl border px-3 py-2 text-sm ui-text-soft">
                <input
                  type="checkbox"
                  checked={selectedAgentIds.has(agent.id)}
                  onChange={() => toggleAgent(agent.id)}
                  className="accent-[var(--app-accent)]"
                />
                <span>{agent.name}</span>
                {agent.status === undefined ? null : <span className="ml-auto text-xs ui-muted">{agent.status}</span>}
              </label>
            ))}
          </div>
        </fieldset>

        <p className="mt-4 text-xs ui-muted">
          运行时群聊固定使用顺序回复（sequential），至少选择两个启用的 Agent。旧版群聊数据不会被迁移或覆盖。
        </p>
        {props.error === undefined ? null : <p role="alert" className="mt-3 text-sm text-[var(--status-danger)]">{props.error}</p>}

        <div className="mt-6 flex justify-end gap-3">
          <button type="button" onClick={props.onClose} className="ui-button-secondary rounded-xl px-4 py-2 text-sm">取消</button>
          <button type="submit" disabled={!canSubmit} className="ui-button-primary rounded-xl px-4 py-2 text-sm font-medium disabled:cursor-not-allowed">
            {submitting ? '创建中…' : '创建运行时群聊'}
          </button>
        </div>
      </form>
    </div>
  );
}
