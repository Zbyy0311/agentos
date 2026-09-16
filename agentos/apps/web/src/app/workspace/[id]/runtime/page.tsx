'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { DirectConversationWorkbench } from '@/components/chat/DirectConversationWorkbench';
import { RunInspectorPanel } from '@/components/chat/RunInspectorPanel';
import { RuntimeGroupCreator, type RuntimeGroupCreateInput } from '@/components/chat/RuntimeGroupCreator';
import { useDirectConversation } from '@/lib/useDirectConversation';
import { useApi } from '@/lib/useApi';
import type { UiTheme } from '@/lib/uiFoundation';

/**
 * Direct Conversation UX page (forward Conversation runtime).
 *
 * Composes the four-column workbench (Agents / Conversations / Canvas / Inspector)
 * over the forward runtime. This is an additive route; the legacy workspace page is
 * untouched (COMPATIBILITY).
 */
export default function DirectConversationPage() {
  const params = useParams();
  const workspaceId = typeof params.id === 'string' ? params.id : '';
  const { API_BASE } = useApi();
  const state = useDirectConversation(workspaceId, API_BASE);
  const [viewportWidth, setViewportWidth] = useState(1600);
  const [creatingGroup, setCreatingGroup] = useState(false);

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const active = state.conversations.find(c => c.id === state.activeConversationId);
  const theme: UiTheme = 'dark';
  const runIds = [...new Set(state.messages.flatMap(message =>
    message.conversationId === state.activeConversationId && message.runId ? [message.runId] : []))].reverse();
  const createConversation = () => { void state.createConversation(); };
  const createGroup = async (input: RuntimeGroupCreateInput) => {
    const created = await state.createGroupConversation(input);
    if (created !== null) setCreatingGroup(false);
  };

  return (
    <>
      <DirectConversationWorkbench
        theme={theme}
        workspaceId={workspaceId}
        apiBase={API_BASE}
        inspector={<RunInspectorPanel key={state.activeConversationId ?? workspaceId} workspaceId={workspaceId}
          apiBase={API_BASE} runIds={runIds} theme={theme} />}
        toolbar={(
          <>
            <span data-agentos="workspace-breadcrumb" aria-label="Workspace breadcrumb">
              Workspace / {state.activeConversationId ?? workspaceId}
            </span>
            <span role="status" data-agentos="runtime-status">
              Runtime · {state.stream.phase}
            </span>
            <button
              type="button"
              data-agentos="toolbar-new-conversation"
              onClick={createConversation}
              disabled={state.agents.length === 0}
            >
              New Conversation
            </button>
          </>
        )}
        viewportWidth={viewportWidth}
        workspaceName={workspaceId}
        agents={state.agents}
        activeAgentId={state.activeAgentId}
        conversations={state.conversations}
        activeConversationId={state.activeConversationId}
        activeConversationTitle={active?.title ?? 'Conversation'}
        activeConversationKind={active?.kind ?? 'direct'}
        messages={state.messages}
        stream={state.stream}
        composerMode={state.mode}
        composerContent={state.content}
        sending={state.sending}
        {...(state.error === undefined ? {} : { error: state.error })}
        onSelectAgent={state.selectAgent}
        onSelectConversation={state.selectConversation}
        onCreateConversation={createConversation}
        onCreateGroupConversation={() => setCreatingGroup(true)}
        onModeChange={state.setMode}
        onContentChange={state.setContent}
        onSend={() => { void state.send(); }}
      />
      {creatingGroup && (
        <RuntimeGroupCreator
          agents={state.agents}
          {...(state.error === undefined ? {} : { error: state.error })}
          onClose={() => setCreatingGroup(false)}
          onCreate={createGroup}
        />
      )}
    </>
  );
}
