'use client';

import { useEffect, useMemo, useState } from 'react';
import type { AgentSummary } from './DirectConversationWorkbench';
import { ConversationRuntimeView } from './ConversationRuntimeView';
import { GroupConversationCanvas } from './GroupConversationCanvas';
import { RunInspectorPanel } from './RunInspectorPanel';
import { useDirectConversation } from '@/lib/useDirectConversation';
import type { ComposerMode } from '@/lib/directComposer';
import type { ForwardConversation } from '@/lib/directConversationClient';

export type UnifiedWorkspaceView = 'chat' | 'execution';

export function UnifiedRuntimeConversationSurface(props: {
  readonly workspaceId: string;
  readonly apiBase: string;
  readonly conversationId: string;
  readonly agents: readonly AgentSummary[];
  readonly view: UnifiedWorkspaceView;
  readonly runId?: string;
  readonly onViewChange: (view: UnifiedWorkspaceView) => void;
}) {
  const state = useDirectConversation(props.workspaceId, props.apiBase, props.conversationId);
  const active = state.conversations.find(conversation => conversation.id === props.conversationId) as ForwardConversation | undefined;
  const [composerMode, setComposerMode] = useState<ComposerMode>('chat');
  const runIds = useMemo(() => [...new Set(state.messages.flatMap(message => message.runId ? [message.runId] : []))].reverse(), [state.messages]);
  const effectiveRunIds = props.runId && !runIds.includes(props.runId) ? [props.runId, ...runIds] : runIds;

  useEffect(() => {
    setComposerMode('chat');
  }, [props.conversationId]);

  const title = active?.title ?? 'Runtime 会话';
  const kindLabel = active?.kind === 'group' ? '轮流讨论' : '轻量对话';

  return (
    <section data-agentos="unified-runtime-conversation" className="flex min-w-0 flex-1 flex-col overflow-hidden ui-panel">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b ui-border px-5 py-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold ui-text">{title}</div>
          <div className="mt-1 text-xs ui-muted">Runtime · {kindLabel}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1 rounded-xl border ui-border p-1" role="tablist" aria-label="会话视图">
          <button type="button" role="tab" aria-selected={props.view === 'chat'} data-agentos="runtime-chat-tab" onClick={() => props.onViewChange('chat')} className={`rounded-lg px-2.5 py-1.5 text-xs ${props.view === 'chat' ? 'ui-selected' : 'ui-button-ghost'}`}>对话</button>
          <button type="button" role="tab" aria-selected={props.view === 'execution'} data-agentos="runtime-execution-tab" onClick={() => props.onViewChange('execution')} className={`rounded-lg px-2.5 py-1.5 text-xs ${props.view === 'execution' ? 'ui-selected' : 'ui-button-ghost'}`}>执行详情</button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden">
        {!active ? <div className="grid h-full place-items-center px-6 text-center text-sm ui-muted">正在加载 Runtime 会话…</div>
          : props.view === 'execution'
            ? <div data-agentos="unified-runtime-execution" className="h-full min-w-0 overflow-y-auto p-4"><RunInspectorPanel workspaceId={props.workspaceId} apiBase={props.apiBase} runIds={effectiveRunIds} theme="light" /></div>
            : active.kind === 'group'
              ? <GroupConversationCanvas theme="light" workspaceId={props.workspaceId} apiBase={props.apiBase} conversationId={active.id} conversationTitle={active.title} agents={props.agents} />
              : <ConversationRuntimeView theme="light" conversationTitle={active.title} conversationKind="轻量对话" messages={state.messages} stream={state.stream} composerMode={composerMode} composerContent={state.content} sending={state.sending} {...(state.error === undefined ? {} : { error: state.error })} onModeChange={setComposerMode} onContentChange={state.setContent} onSend={() => { void state.send(); }} />}
      </div>
    </section>
  );
}
