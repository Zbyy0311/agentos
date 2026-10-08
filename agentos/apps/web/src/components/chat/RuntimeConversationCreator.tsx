'use client';

import { useState } from 'react';
import type { AgentSummary } from './DirectConversationWorkbench';
import { uiLayerClass } from '@/lib/uiLayers';

export interface RuntimeConversationCreateInput {
  readonly title: string;
  readonly agentId: string;
}

export function RuntimeConversationCreator(props: {
  readonly agents: readonly AgentSummary[];
  readonly error?: string;
  readonly onClose: () => void;
  readonly onCreate: (input: RuntimeConversationCreateInput) => Promise<unknown> | void;
}) {
  const enabledAgents = props.agents;
  const [title, setTitle] = useState('新建轻量对话');
  const [agentId, setAgentId] = useState(enabledAgents[0]?.id ?? '');
  const [submitting, setSubmitting] = useState(false);
  const canSubmit = !submitting && title.trim().length > 0 && agentId.length > 0;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await props.onCreate({ title: title.trim(), agentId });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={`fixed inset-0 ${uiLayerClass('editor')} grid place-items-center bg-[var(--app-overlay)] p-4 backdrop-blur-sm`}>
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="runtime-conversation-creator-title"
        onSubmit={event => { event.preventDefault(); void submit(); }}
        className="ui-panel-raised w-full max-w-lg rounded-2xl border p-5 shadow-[var(--app-shadow)]"
      >
        <div className="ui-modal-sticky-header mb-5 flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium tracking-[0.16em] ui-accent">RUNTIME CONVERSATION</p>
            <h2 id="runtime-conversation-creator-title" className="mt-2 text-lg font-semibold ui-text">创建轻量对话</h2>
            <p className="mt-1 text-xs ui-muted">保留 Runtime 的对话语义，普通发送不会创建 Task 或 Run。</p>
          </div>
          <button type="button" onClick={props.onClose} className="ui-button-ghost rounded-lg px-2 py-1 text-sm">关闭</button>
        </div>

        <label className="block text-sm ui-text-soft" htmlFor="runtime-conversation-title">
          会话名称
          <input id="runtime-conversation-title" value={title} onChange={event => setTitle(event.target.value)} className="ui-input mt-2 w-full rounded-xl px-3 py-2 text-sm outline-none" />
        </label>

        <label className="mt-4 block text-sm ui-text-soft" htmlFor="runtime-conversation-agent">
          负责 Agent
          <select id="runtime-conversation-agent" value={agentId} onChange={event => setAgentId(event.target.value)} className="ui-input mt-2 w-full rounded-xl px-3 py-2 text-sm outline-none">
            {enabledAgents.map(agent => <option key={agent.id} value={agent.id}>{agent.name} · {agent.roleTitle ?? '协作成员'}</option>)}
          </select>
        </label>

        {props.error === undefined ? null : <p role="alert" className="mt-3 text-sm text-[var(--status-danger)]">{props.error}</p>}
        <div className="ui-modal-sticky-footer mt-6 flex justify-end gap-3">
          <button type="button" onClick={props.onClose} className="ui-button-secondary rounded-xl px-4 py-2 text-sm">取消</button>
          <button type="submit" disabled={!canSubmit} className="ui-button-primary rounded-xl px-4 py-2 text-sm font-medium disabled:cursor-not-allowed">{submitting ? '创建中…' : '创建轻量对话'}</button>
        </div>
      </form>
    </div>
  );
}
